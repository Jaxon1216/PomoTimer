import { timerSnapshotSchema, type ActivePresenceSource, type BreakMode, type Presence, type Round, type RoundKind, type Settings, type TimerCommand, type TimerSnapshot } from "../shared/contracts.js";
import { checkpointOf, type TimerCheckpoint } from "./checkpoint.js";

export interface CompletedSession {
  id: string;
  completedAt: string;
  localDate: string;
  localOffsetMinutes: number;
  cycleNumber: number;
  focusRoundNumber: number;
  plannedDurationSeconds: number;
  activeDurationSeconds: number;
  mode: "seated";
}

// CompletedRound 是当前进程内最后一次成功提交的自然完成信息。
//
// 领域：Timer / 完成事件
// 顺序：tick -> Store 完成写入 -> Main 读取 completedRound。
// 作用：为主进程提供完成轮次、下一轮及与完成计数对应的版本。
// 原因：提醒只能来自成功落盘的自然完成，不能由读取快照或跳轮推断。
// 边界：只保存在内存中，不加入检查点；重启后由下一次自然完成重新生成。
export interface CompletedRound {
  readonly revision: number;
  readonly completedKind: RoundKind;
  readonly nextKind: RoundKind;
  readonly completedAt: string;
}

export interface TimerStore {
  loadSnapshot(): TimerCheckpoint | undefined;
  saveSnapshot(snapshot: TimerCheckpoint): void;
  commitCompletedSessionAndSnapshot(session: CompletedSession, snapshot: TimerCheckpoint): void;
  loadSettings?(): Settings;
  saveSettings?(settings: Settings): void;
}

export interface TimerClock { now(): number; wallDate(): Date; }

export const defaultSettings: Settings = { version: 1, focusDurationSeconds: 1800, shortBreakDurationSeconds: 300, longBreakDurationSeconds: 600, focusRoundsPerCycle: 3, inputIdleThresholdSeconds: 40, focusPresenceSource: "input", defaultBreakMode: "active", theme: "system", alwaysOnTop: true, followWorkspaces: true, autoFade: true, notificationsEnabled: true };

function durationFor(kind: Round["kind"], settings: Settings): number {
  return (kind === "focus"
    ? settings.focusDurationSeconds
    : kind === "short-break"
      ? settings.shortBreakDurationSeconds
      : settings.longBreakDurationSeconds) * 1000;
}

function makeRound(
  kind: Round["kind"],
  cycle: number,
  focusNumber: number | null,
  position: number,
  settings: Settings,
): Round {
  return {
    kind,
    cycleNumber: cycle,
    positionInCycle: position,
    focusRoundNumber: focusNumber,
    breakMode: kind === "focus" ? null : settings.defaultBreakMode,
    totalDurationMs: durationFor(kind, settings),
  };
}

export class TimerEngine {
  private snapshotValue: TimerSnapshot;
  private runningSince: number | undefined;
  private settingsValue: Settings;
  private standingFromMode: BreakMode | undefined;
  private inputAvailable = true;
  private inputPresence: Presence = "unknown";
  private manualInputFallback = false;
  private screenLocked = false;
  private storageFailed = false;
  private completedRoundsRevisionValue = 0;
  private completedRoundValue: CompletedRound | undefined;
  private persistedState = "";
  private emittedAutomation = "";
  private activeCycleRounds: number;
  private readonly clock: TimerClock;
  private readonly store: TimerStore;

  constructor(store: TimerStore, clock: TimerClock, settings?: Settings) {
    this.store = store;
    this.clock = clock;
    this.settingsValue = settings ?? store.loadSettings?.() ?? defaultSettings;
    const persisted = store.loadSnapshot();
    this.activeCycleRounds = persisted?.activeCycleRounds ?? this.settingsValue.focusRoundsPerCycle;
    this.snapshotValue = this.initialSnapshot();
    if (persisted) {
      const { interruption, ordinaryBreakMode, ...progress } = persisted;
      // 领域：Timer / 旧检查点恢复
      // 顺序：SqliteStore 检查点 -> TimerEngine 构造 -> 新鲜感知样本。
      // 作用：恢复进度，保留专注暂停锁；旧自动休息恢复等待，大站等待手动确认。
      // 原因：离线时间不补计，且普通休息不能在重启后失去自动恢复能力。
      // 边界：只规范化读取后的运行时状态，不补计离线时间或修改已完成记录。
      const legacyBreakPause = progress.status === "manual-paused" && progress.round.kind !== "focus";
      const status = progress.status === "running" || legacyBreakPause ? "auto-paused" : progress.status;
      const standing = progress.round.breakMode === "standing";
      if (standing) this.standingFromMode = ordinaryBreakMode ?? this.settingsValue.defaultBreakMode;
      this.snapshotValue = {
        ...progress, activeCycleRounds: this.activeCycleRounds, status,
        automation: {
          ...this.snapshotValue.automation,
          manualPauseLocked: status === "manual-paused",
          pauseReason: standing && status === "auto-paused" ? interruption ?? "standing-confirmation"
            : legacyBreakPause ? "break-condition" : status === "auto-paused" ? interruption ?? "core-recovery" : "none",
        },
      };
    }
    this.snapshotValue.automation.activePresenceSource = this.activePresenceSource();
    this.persist();
  }

  get settings(): Settings {
    return this.settingsValue;
  }

  get snapshot(): TimerSnapshot {
    this.tick();
    return this.snapshotValue;
  }

  get completedRoundsRevision(): number {
    return this.completedRoundsRevisionValue;
  }

  get completedRound(): CompletedRound | undefined {
    return this.completedRoundValue ? { ...this.completedRoundValue } : undefined;
  }

  setInputAvailability(available: boolean): TimerSnapshot {
    return this.inputSample(undefined, available);
  }

  applySettings(patch: Partial<Settings>): Settings {
    this.assertStorageAvailable();
    this.tick();
    const previousSource = this.activePresenceSource();
    const sourceChanged = patch.focusPresenceSource !== undefined && patch.focusPresenceSource !== this.settingsValue.focusPresenceSource;
    if (patch.inputIdleThresholdSeconds !== undefined && patch.inputIdleThresholdSeconds !== this.settingsValue.inputIdleThresholdSeconds) {
      this.snapshotValue.automation.breakPreparation = null;
    }
    this.settingsValue = { ...this.settingsValue, ...patch, version: 1 };
    this.store.saveSettings?.(this.settingsValue);
    // 领域：Timer / 感知源切换
    // 顺序：Main 设置命令 -> applySettings -> 清空旧检测 -> 下一次有效源采样。
    // 作用：实际采用的来源变化时冻结当前轮次，等待新来源的有效条件。
    // 原因：旧源结果不能授权新源继续计时，也不能把等待初始化的时间计入轮次。
    // 边界：摄像头管理专注与活动休息；桌前休息始终使用输入，专注手动暂停锁保持。
    if (sourceChanged) this.invalidateCameraPresence();
    if (previousSource !== this.activePresenceSource()) {
      this.manualInputFallback = false;
      this.snapshotValue.automation.breakPreparation = null;
      if (this.snapshotValue.status === "running") {
        this.freeze(this.clock.now());
        this.snapshotValue.status = "auto-paused";
      }
      if (this.snapshotValue.status === "auto-paused" && !this.screenLocked) this.snapshotValue.automation.pauseReason = "source-unavailable";
    }
    this.emit();
    return this.settingsValue;
  }

  command(command: TimerCommand): TimerSnapshot {
    this.assertStorageAvailable();
    const switchesStanding = command === "start-standing-break" || command === "exit-standing-break";
    if (this.screenLocked && (command === "start" || command === "resume" || switchesStanding)) throw new Error("锁屏期间不能开始计时或切换休息方式");
    const requestedRound = this.snapshotValue.round;
    const now = this.clock.now();
    this.tick(now);
    if (switchesStanding && (requestedRound !== this.snapshotValue.round || this.snapshotValue.remainingMs === 0)) {
      throw new Error("当前轮次已结束");
    }
    this.snapshotValue.automation.breakPreparation = null;
    if ((command === "start" || command === "resume") && this.activePresenceSource() === "camera"
      && !this.presenceAllowsRunning(this.snapshotValue.automation.cameraPresence)) {
      throw new Error("摄像头当前未满足计时条件，请等待有效检测或切换触控感知");
    }

    if (command === "start-standing-break") {
      // 领域：Timer / 本轮大站互切
      // 顺序：Main 显式命令 -> command tick -> 冻结已走进度 -> 剩余时长两倍折算并开始。
      // 作用：在休息轮任意阶段将普通休息切为大站，按 2 倍折算剩余和总时长。
      // 原因：休息开始或暂停后仍应允许随时起立继续工作，不增加独立时长设置。
      // 边界：不改变周期或全局默认，不允许专注轮或自动信号触发。
      const round = this.snapshotValue.round;
      if (round.kind === "focus" || round.breakMode === "standing") {
        throw new Error("仅可在普通休息期间切换为大站");
      }
      this.standingFromMode = round.breakMode ?? this.settingsValue.defaultBreakMode;
      this.snapshotValue.round = { ...round, breakMode: "standing", totalDurationMs: round.totalDurationMs * 2 };
      this.snapshotValue.remainingMs = this.snapshotValue.remainingMs * 2;
      this.snapshotValue.automation.manualPauseLocked = false;
      this.manualInputFallback = false;
      this.invalidateCameraPresence();
      this.startRunning(now);
    } else if (command === "exit-standing-break") {
      // 领域：Timer / 切回普通休息
      // 顺序：Main 显式命令 -> command tick -> 冻结已走进度 -> 剩余时长折半并恢复等待。
      // 作用：将本轮大站按 1/2 折算回普通休息，交还对应感知源判断开始或继续。
      // 原因：点击切回本身是一次桌面交互，不能未经有效离席或无输入样本直接扣减普通休息。
      // 边界：仅作用于当前大站轮，保证折半后剩余毫秒大于零且不超过普通总时长。
      const round = this.snapshotValue.round;
      if (round.kind === "focus" || round.breakMode !== "standing") {
        throw new Error("当前不在大站休息中");
      }
      this.freeze(now);
      const nextTotalDurationMs = Math.max(1, Math.round(round.totalDurationMs / 2));
      const nextRemainingMs = Math.min(nextTotalDurationMs, Math.ceil(this.snapshotValue.remainingMs / 2));
      const breakMode = this.standingFromMode ?? this.settingsValue.defaultBreakMode;
      this.snapshotValue.round = { ...round, breakMode, totalDurationMs: nextTotalDurationMs };
      this.standingFromMode = undefined;
      this.snapshotValue.remainingMs = nextRemainingMs;
      this.snapshotValue.status = "auto-paused";
      this.snapshotValue.automation.manualPauseLocked = false;
      this.manualInputFallback = false;
      this.invalidateCameraPresence();
      this.snapshotValue.automation.pauseReason = this.activePresenceSource() === "camera" || !this.inputAvailable
        ? "source-unavailable" : "break-condition";
    } else if (command === "start") {
      const canStart = this.snapshotValue.status === "idle"
        || (this.snapshotValue.round.kind !== "focus" && this.snapshotValue.status === "auto-paused");
      if (!canStart) throw new Error("当前轮次不能开始");
      this.manualInputFallback = this.activePresenceSource() === "input" && !this.inputAvailable;
      this.startRunning(now);
    } else if (command === "pause") {
      // 领域：Timer / 暂停优先级
      // 顺序：用户暂停 -> command tick 完成当前轮次 -> 按最新轮次设置暂停状态。
      // 作用：专注设置手动锁，自动休息回到等待，大站回到手动确认。
      // 原因：用户在专注归零边界按暂停时，不能把已经生成的休息锁住或报错。
      // 边界：只冻结实际运行过的时间；大站不由后续感知信号重新开始。
      const focus = this.snapshotValue.round.kind === "focus";
      if (focus && this.snapshotValue.status !== "running") throw new Error("当前轮次未在运行");
      this.freeze(now);
      this.snapshotValue.status = focus ? "manual-paused" : "auto-paused";
      this.snapshotValue.automation.manualPauseLocked = focus;
      this.snapshotValue.automation.pauseReason = focus ? "none" : this.isStandingBreak() ? "standing-confirmation" : "break-condition";
      this.manualInputFallback = false;
    } else if (command === "resume") {
      if (this.snapshotValue.status !== "auto-paused" && this.snapshotValue.status !== "manual-paused") {
        throw new Error("当前轮次不能继续");
      }
      this.snapshotValue.automation.manualPauseLocked = false;
      this.manualInputFallback = this.activePresenceSource() === "input" && !this.inputAvailable;
      this.startRunning(now);
    } else if (command === "reset") {
      this.snapshotValue.status = "idle";
      this.snapshotValue.remainingMs = this.snapshotValue.round.totalDurationMs;
      this.snapshotValue.automation.manualPauseLocked = false;
      this.snapshotValue.automation.pauseReason = "none";
      this.runningSince = undefined;
      this.manualInputFallback = false;
    } else {
      this.advanceRound();
    }

    return this.emit();
  }

  inputSample(idleSeconds: number | undefined, available = true): TimerSnapshot {
    if (this.storageFailed) return timerSnapshotSchema.parse(this.snapshotValue);
    this.tick();
    const failed = !available || idleSeconds === undefined || !Number.isFinite(idleSeconds) || idleSeconds < 0;
    this.inputAvailable = !failed;
    this.snapshotValue.automation.inputMonitoringAvailable = !failed;
    this.inputPresence = failed ? "unknown" : idleSeconds >= this.settingsValue.inputIdleThresholdSeconds ? "away" : "present";
    if (this.activePresenceSource() !== "input") return this.emit();
    if (failed) {
      this.snapshotValue.automation.breakPreparation = null;
      this.inputPresence = "unknown";
      if (!this.manualInputFallback && !this.snapshotValue.automation.manualPauseLocked && this.snapshotValue.status === "running") {
        this.freeze(this.clock.now());
        this.snapshotValue.status = "auto-paused";
        this.snapshotValue.automation.pauseReason = "source-unavailable";
      } else if (!this.screenLocked && this.snapshotValue.status === "auto-paused") {
        this.snapshotValue.automation.pauseReason = "source-unavailable";
      }
      return this.emit();
    }

    this.manualInputFallback = false;
    this.inputPresence = idleSeconds >= this.settingsValue.inputIdleThresholdSeconds ? "away" : "present";
    this.snapshotValue.automation.inputPresence = this.inputPresence;
    if (this.screenLocked) return this.emit();
    this.reconcilePresence(this.inputPresence, this.clock.now());
    this.updateBreakPreparation(idleSeconds);
    return this.emit();
  }

  // 领域：Timer / 摄像头在场
  // 顺序：Renderer 本地检测 -> Main 校验当前会话 -> cameraSample -> reconcilePresence。
  // 作用：专注按在场运行，活动休息按离席运行，未知结果安全冻结。
  // 原因：输入闲置不代表离开镜头，检测故障也不能推断为离席。
  // 边界：不接收帧或身份数据；桌前休息只用输入，专注手动暂停锁优先。
  cameraSample(presence: Presence): TimerSnapshot {
    if (this.storageFailed) return timerSnapshotSchema.parse(this.snapshotValue);
    this.tick();
    if (this.settingsValue.focusPresenceSource !== "camera") return this.emit();
    if (this.screenLocked) {
      this.invalidateCameraPresence();
      return this.emit();
    }
    this.snapshotValue.automation.cameraPresence = presence;
    this.snapshotValue.automation.cameraMonitoringAvailable = presence !== "unknown";
    if (this.activePresenceSource() === "camera") this.reconcilePresence(presence, this.clock.now());
    return this.emit();
  }

  private isStandingBreak(): boolean {
    return this.snapshotValue.round.kind !== "focus" && this.snapshotValue.round.breakMode === "standing";
  }

  private activePresenceSource(): ActivePresenceSource {
    if (this.isStandingBreak()) return "none";
    const round = this.snapshotValue.round;
    return round.kind === "focus" || round.breakMode === "active" ? this.settingsValue.focusPresenceSource : "input";
  }

  private invalidateCameraPresence(): void {
    this.snapshotValue.automation.cameraPresence = "unknown";
    this.snapshotValue.automation.cameraMonitoringAvailable = false;
  }

  private presenceAllowsRunning(presence: Presence): boolean {
    return this.snapshotValue.round.kind === "focus" ? presence === "present" : presence === "away";
  }

  private reconcilePresence(presence: Presence, now: number): void {
    if (this.snapshotValue.automation.manualPauseLocked || this.screenLocked || this.isStandingBreak()) return;
    const shouldRun = this.presenceAllowsRunning(presence);
    const canAutoStart = this.snapshotValue.round.kind !== "focus" || this.activePresenceSource() === "camera";
    const conditionReason = presence === "unknown" ? "source-unavailable"
      : this.snapshotValue.round.kind !== "focus" ? "break-condition"
        : this.activePresenceSource() === "camera" ? "camera-away" : "input-away";
    if (this.snapshotValue.status === "running" && !shouldRun) {
      this.freeze(now);
      this.snapshotValue.status = "auto-paused";
      this.snapshotValue.automation.pauseReason = conditionReason;
    } else if (shouldRun && (this.snapshotValue.status === "auto-paused" || (this.snapshotValue.status === "idle" && canAutoStart))) {
      this.startRunning(now);
    } else if (this.snapshotValue.status === "auto-paused" && (this.activePresenceSource() === "camera"
      || this.snapshotValue.automation.pauseReason === "source-unavailable"
      || this.snapshotValue.automation.pauseReason === "core-recovery")) {
      this.snapshotValue.automation.pauseReason = conditionReason;
    }
  }

  systemSuspend(): TimerSnapshot {
    this.invalidateCameraPresence();
    this.snapshotValue.automation.breakPreparation = null;
    this.manualInputFallback = false;
    this.tick();
    // Sleep only interrupts an active timer. Idle and manually paused rounds
    // must remain untouched so wake-up cannot start them implicitly.
    if (this.snapshotValue.status === "running") {
      this.freeze(this.clock.now());
      this.snapshotValue.status = "auto-paused";
      this.snapshotValue.automation.pauseReason = "system-suspend";
    }
    return this.emit();
  }

  // 领域：Timer / 锁屏状态
  // 顺序：Main lock-screen -> systemLock -> inputSample；unlock-screen -> systemUnlock。
  // 作用：锁屏冻结活动轮次，屏蔽输入自动化直到解锁后的有效样本。
  // 原因：锁屏时系统输入仍可能报告在场，不能据此继续专注或开始休息。
  // 边界：门禁仅在当前进程内保存；idle 和手动暂停锁保持不变。
  systemLock(): TimerSnapshot {
    this.invalidateCameraPresence();
    this.snapshotValue.automation.breakPreparation = null;
    this.manualInputFallback = false;
    this.tick();
    this.screenLocked = true;
    if (this.snapshotValue.status === "running") {
      this.freeze(this.clock.now());
      this.snapshotValue.status = "auto-paused";
    }
    if (this.snapshotValue.status === "auto-paused" && !this.storageFailed) this.snapshotValue.automation.pauseReason = "system-lock";
    return this.emit();
  }

  systemUnlock(): TimerSnapshot {
    this.screenLocked = false;
    if (this.snapshotValue.automation.pauseReason === "system-lock") {
      this.snapshotValue.automation.pauseReason = this.isStandingBreak() ? "standing-confirmation"
        : this.activePresenceSource() === "camera" || !this.inputAvailable
        ? "source-unavailable"
        : this.snapshotValue.round.kind === "focus" ? "input-away" : "break-condition";
    }
    return this.emit();
  }

  // 领域：Timer / 存储故障
  // 顺序：Main 捕获 Store 异常 -> storageFailure -> freeze -> 只读快照。
  // 作用：在内存中安全暂停，并拒绝当前进程内的后续计时和设置变更。
  // 原因：错误处理不能再次访问已经失败的 Store，也不能触发轮次完成提交。
  // 边界：不持久化故障状态；只有重启并成功打开数据库后才恢复写入。
  storageFailure(): TimerSnapshot {
    this.storageFailed = true;
    this.snapshotValue.automation.breakPreparation = null;
    this.manualInputFallback = false;
    if (this.snapshotValue.status === "running") {
      this.freeze(this.clock.now());
      this.snapshotValue.status = "auto-paused";
    }
    if (this.snapshotValue.status === "auto-paused") this.snapshotValue.automation.pauseReason = "storage-unavailable";
    return this.emit();
  }

  // 领域：Timer / 休息准备
  // 顺序：Main 输入采样 -> inputSample -> reconcilePresence -> updateBreakPreparation -> 运行时快照。
  // 作用：输入休息等待阈值时提供剩余秒数，最后最多十秒显示准备倒计时。
  // 原因：准备时间不能减少实际休息时长，达到阈值才从当前剩余时长开始计时。
  // 边界：准备提示不进入 SQLite；只由新鲜有效输入更新，故障、挂起或切轮清空。
  private updateBreakPreparation(idleSeconds: number): void {
    const waiting = this.snapshotValue.status === "auto-paused" || this.snapshotValue.status === "idle";
    if (this.snapshotValue.round.kind === "focus" || this.activePresenceSource() !== "input" || !waiting
      || this.snapshotValue.automation.manualPauseLocked || this.screenLocked || idleSeconds >= this.settingsValue.inputIdleThresholdSeconds) {
      this.snapshotValue.automation.breakPreparation = null;
      return;
    }
    const remainingSeconds = Math.ceil(this.settingsValue.inputIdleThresholdSeconds - idleSeconds);
    this.snapshotValue.automation.breakPreparation = { remainingSeconds, countdown: remainingSeconds <= 10 };
  }

  private initialSnapshot(): TimerSnapshot {
    return {
      revision: 0,
      emittedAt: new Date().toISOString(),
      round: makeRound("focus", 1, 1, 1, this.settingsValue),
      activeCycleRounds: this.activeCycleRounds,
      status: "idle",
      remainingMs: this.settingsValue.focusDurationSeconds * 1000,
      automation: {
        activePresenceSource: this.settingsValue.focusPresenceSource,
        inputPresence: "unknown",
        cameraPresence: "unknown",
        inputMonitoringAvailable: true,
        cameraMonitoringAvailable: false,
        breakPreparation: null,
        manualPauseLocked: false,
        pauseReason: "none",
      },
    };
  }

  private startRunning(now: number): void {
    this.snapshotValue.automation.breakPreparation = null;
    this.snapshotValue.status = "running";
    this.snapshotValue.automation.pauseReason = "none";
    this.runningSince = now;
  }

  private freeze(now: number): void {
    if (this.runningSince !== undefined) {
      this.snapshotValue.remainingMs = Math.max(0, this.snapshotValue.remainingMs - Math.floor(now - this.runningSince));
      this.runningSince = undefined;
    }
  }

  private tick(now = this.clock.now()): void {
    if (this.snapshotValue.status !== "running" || this.runningSince === undefined) return;
    const remaining = this.snapshotValue.remainingMs - Math.floor(now - this.runningSince);
    if (remaining > 0) {
      this.snapshotValue.remainingMs = remaining;
      this.runningSince = now;
      return;
    }

    const beforeCompletion = structuredClone(this.snapshotValue);
    const beforeStandingFromMode = this.standingFromMode;
    const current = this.snapshotValue.round;
    this.snapshotValue.remainingMs = 0;
    this.runningSince = undefined;
    this.moveToNextRound();
    this.snapshotValue.revision = beforeCompletion.revision + 1;
    this.snapshotValue.emittedAt = new Date().toISOString();

    try {
      const date = this.clock.wallDate();
      const completedAt = date.toISOString();
      if (current.kind === "focus" && current.focusRoundNumber) {
        this.store.commitCompletedSessionAndSnapshot(
          {
            // A round identity is stable across retries and process restarts.
            id: `focus-${current.cycleNumber}-${current.focusRoundNumber}`,
            completedAt,
            localDate: date.toLocaleDateString("sv-SE"),
            localOffsetMinutes: -date.getTimezoneOffset(),
            cycleNumber: current.cycleNumber,
            focusRoundNumber: current.focusRoundNumber,
            plannedDurationSeconds: Math.floor(current.totalDurationMs / 1000),
            activeDurationSeconds: Math.floor(current.totalDurationMs / 1000),
            mode: "seated",
          },
          checkpointOf(this.snapshotValue),
        );
      } else {
        this.persist();
      }
      this.persistedState = this.snapshotState();
      this.emittedAutomation = JSON.stringify(this.snapshotValue.automation);
      this.completedRoundsRevisionValue += 1;
      this.completedRoundValue = {
        revision: this.completedRoundsRevisionValue,
        completedKind: current.kind,
        nextKind: this.snapshotValue.round.kind,
        completedAt,
      };
    } catch (error) {
      // Keep the just-finished round retryable. The Store transaction has
      // rolled back both the record and snapshot when this path is reached.
      this.snapshotValue = beforeCompletion;
      this.standingFromMode = beforeStandingFromMode;
      this.snapshotValue.remainingMs = 0;
      this.runningSince = now;
      throw error;
    }
  }

  private moveToNextRound(): void {
    this.snapshotValue.automation.breakPreparation = null;
    this.manualInputFallback = false;
    const current = this.snapshotValue.round;
    const nextFocus = current.kind === "focus"
      ? (current.focusRoundNumber ?? 1) + 1
      : current.kind === "short-break"
        ? Math.floor(current.positionInCycle / 2) + 1
        : 1;
    const nextCycle = current.kind === "long-break" ? current.cycleNumber + 1 : current.cycleNumber;
    const nextKind = current.kind === "focus"
      ? (current.focusRoundNumber === this.activeCycleRounds ? "long-break" : "short-break")
      : "focus";
    const position = current.kind === "long-break" ? 1 : current.positionInCycle + 1;
    const focusNumber = nextKind === "focus" ? nextFocus : null;
    if (nextCycle !== current.cycleNumber) this.activeCycleRounds = this.settingsValue.focusRoundsPerCycle;
    this.standingFromMode = undefined;
    this.snapshotValue.activeCycleRounds = this.activeCycleRounds;
    this.snapshotValue.round = makeRound(nextKind, nextCycle, focusNumber, position, this.settingsValue);
    this.snapshotValue.automation.activePresenceSource = this.activePresenceSource();
    this.snapshotValue.remainingMs = this.snapshotValue.round.totalDurationMs;
    this.snapshotValue.status = nextKind === "focus" ? "idle" : "auto-paused";
    this.snapshotValue.automation.manualPauseLocked = false;
    this.snapshotValue.automation.pauseReason = nextKind === "focus" ? "none" : "break-condition";
  }

  private advanceRound(): void {
    this.snapshotValue.status = "idle";
    this.snapshotValue.automation.manualPauseLocked = false;
    this.snapshotValue.automation.pauseReason = "none";
    this.runningSince = undefined;
    this.moveToNextRound();
  }

  // 领域：Timer / 检查点
  // 顺序：命令或输入采样 -> emit -> snapshotState -> persist。
  // 作用：可见状态变化更新 IPC revision，只有可恢复的进度变化才写检查点。
  // 原因：输入采样能刷新界面，但不应在 SQLite 中留下采样记录或写入时间。
  // 边界：休息准备提示和监测状态只存在于内存，运行中的剩余时间仍定期保存。
  private emit(): TimerSnapshot {
    this.snapshotValue.automation.activePresenceSource = this.activePresenceSource();
    this.snapshotValue.automation.inputPresence = this.inputPresence;
    const progressChanged = this.snapshotState() !== this.persistedState;
    const automation = JSON.stringify(this.snapshotValue.automation);
    if (!progressChanged && automation === this.emittedAutomation) return timerSnapshotSchema.parse(this.snapshotValue);
    this.snapshotValue.revision += 1;
    this.snapshotValue.emittedAt = new Date().toISOString();
    if (progressChanged) this.persist();
    this.emittedAutomation = automation;
    return timerSnapshotSchema.parse({ ...this.snapshotValue });
  }

  private persist(): void {
    if (this.storageFailed) return;
    this.store.saveSnapshot(checkpointOf(this.snapshotValue, this.standingFromMode));
    this.persistedState = this.snapshotState();
    this.emittedAutomation = JSON.stringify(this.snapshotValue.automation);
  }

  private snapshotState(): string {
    const { round, activeCycleRounds, status, remainingMs, interruption, ordinaryBreakMode } = checkpointOf(this.snapshotValue, this.standingFromMode);
    return JSON.stringify({ round, activeCycleRounds, status, remainingMs, interruption, ordinaryBreakMode });
  }

  private assertStorageAvailable(): void {
    if (this.storageFailed) throw new Error("本地存储不可用，请重新启动应用后重试");
  }
}

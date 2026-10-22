import { timerSnapshotSchema, type Presence, type Round, type Settings, type TimerCommand, type TimerSnapshot } from "../shared/contracts.js";

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

export interface TimerStore {
  loadSnapshot(): TimerSnapshot | undefined;
  saveSnapshot(snapshot: TimerSnapshot): void;
  commitCompletedSessionAndSnapshot(session: CompletedSession, snapshot: TimerSnapshot): void;
  loadSettings?(): Settings;
  saveSettings?(settings: Settings): void;
}

export interface TimerClock { now(): number; wallDate(): Date; }

export const defaultSettings: Settings = { version: 1, focusDurationSeconds: 1800, shortBreakDurationSeconds: 300, longBreakDurationSeconds: 600, focusRoundsPerCycle: 3, inputIdleThresholdSeconds: 40, focusPresenceSource: "input", defaultBreakMode: "active", theme: "system", alwaysOnTop: false, notificationsEnabled: true };

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
  private inputAvailable = true;
  private inputPresence: Presence = "unknown";
  private pendingBreakCountdown: { startedAt: number; idleStartedAt: number } | undefined;
  private activeCycleRounds: number;
  private readonly clock: TimerClock;
  private readonly store: TimerStore;

  constructor(store: TimerStore, clock: TimerClock, settings?: Settings) {
    this.store = store;
    this.clock = clock;
    this.settingsValue = settings ?? store.loadSettings?.() ?? defaultSettings;
    const persisted = store.loadSnapshot();
    this.activeCycleRounds = persisted?.activeCycleRounds ?? this.settingsValue.focusRoundsPerCycle;
    this.snapshotValue = persisted
      ? {
          ...persisted,
          activeCycleRounds: this.activeCycleRounds,
          status: persisted.status === "running" ? "auto-paused" : persisted.status,
          automation: {
            ...persisted.automation,
            // A manual pause is a user decision and must survive restart.
            manualPauseLocked: persisted.status === "manual-paused"
              ? true
              : persisted.automation.manualPauseLocked,
            pauseReason: persisted.status === "running"
              ? "core-recovery"
              : persisted.automation.pauseReason,
          },
        }
      : this.initialSnapshot();
    this.persist();
  }

  get settings(): Settings {
    return this.settingsValue;
  }

  get snapshot(): TimerSnapshot {
    this.tick();
    return this.snapshotValue;
  }

  setInputAvailability(available: boolean): TimerSnapshot {
    return this.inputSample(undefined, available);
  }

  applySettings(patch: Partial<Settings>): Settings {
    this.tick();
    if (patch.inputIdleThresholdSeconds !== undefined && patch.inputIdleThresholdSeconds !== this.settingsValue.inputIdleThresholdSeconds) {
      this.pendingBreakCountdown = undefined;
    }
    this.settingsValue = { ...this.settingsValue, ...patch, version: 1 };
    this.store.saveSettings?.(this.settingsValue);
    this.persist();
    return this.settingsValue;
  }

  command(command: TimerCommand): TimerSnapshot {
    this.pendingBreakCountdown = undefined;
    this.tick();
    const now = this.clock.now();

    if (command === "start") {
      const canStart = this.snapshotValue.status === "idle"
        || (this.snapshotValue.round.kind !== "focus" && this.snapshotValue.status === "auto-paused");
      if (!canStart) throw new Error("当前轮次不能开始");
      this.startRunning(now);
    } else if (command === "pause") {
      if (this.snapshotValue.status !== "running") throw new Error("当前轮次未在运行");
      this.freeze(now);
      this.snapshotValue.status = "manual-paused";
      this.snapshotValue.automation.manualPauseLocked = true;
      this.snapshotValue.automation.pauseReason = "none";
    } else if (command === "resume") {
      if (this.snapshotValue.status !== "auto-paused" && this.snapshotValue.status !== "manual-paused") {
        throw new Error("当前轮次不能继续");
      }
      this.snapshotValue.automation.manualPauseLocked = false;
      this.startRunning(now);
    } else if (command === "reset") {
      this.snapshotValue.status = "idle";
      this.snapshotValue.remainingMs = this.snapshotValue.round.totalDurationMs;
      this.snapshotValue.automation.manualPauseLocked = false;
      this.snapshotValue.automation.pauseReason = "none";
      this.runningSince = undefined;
    } else {
      this.advanceRound();
    }

    return this.emit();
  }

  inputSample(idleSeconds: number | undefined, available = true): TimerSnapshot {
    this.tick();
    this.inputAvailable = available;
    this.snapshotValue.automation.inputMonitoringAvailable = available;
    const failed = !available || idleSeconds === undefined || !Number.isFinite(idleSeconds);
    if (failed) {
      this.pendingBreakCountdown = undefined;
      this.inputPresence = "unknown";
      if (!this.snapshotValue.automation.manualPauseLocked && this.snapshotValue.status === "running") {
        this.freeze(this.clock.now());
        this.snapshotValue.status = "auto-paused";
        this.snapshotValue.automation.pauseReason = "source-unavailable";
      } else if (this.snapshotValue.status === "auto-paused") {
        this.snapshotValue.automation.pauseReason = "source-unavailable";
      }
      return this.emit();
    }

    this.inputPresence = idleSeconds >= this.settingsValue.inputIdleThresholdSeconds ? "away" : "present";
    this.snapshotValue.automation.inputPresence = this.inputPresence;
    const now = this.clock.now();
    const confirmedCountdownMs = this.observeBreakCountdown(idleSeconds, now);
    if (!this.snapshotValue.automation.manualPauseLocked) {
      const shouldRun = this.snapshotValue.round.kind === "focus" ? this.inputPresence === "present" : this.inputPresence === "away";
      const conditionReason = this.snapshotValue.round.kind === "focus" ? "input-away" : "break-condition";
      if (this.snapshotValue.status === "running" && !shouldRun) {
        this.freeze(this.clock.now());
        this.snapshotValue.status = "auto-paused";
        this.snapshotValue.automation.pauseReason = conditionReason;
      } else if (this.snapshotValue.status === "auto-paused" && shouldRun) {
        this.startRunning(now - confirmedCountdownMs);
        if (confirmedCountdownMs > 0) this.tick();
      } else if (this.snapshotValue.status === "auto-paused" && this.snapshotValue.automation.pauseReason === "source-unavailable") {
        this.snapshotValue.automation.pauseReason = conditionReason;
      }
    }
    return this.emit();
  }

  systemSuspend(): TimerSnapshot {
    this.pendingBreakCountdown = undefined;
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

  // 领域：Timer / 休息倒计时
  // 顺序：自动计时链第 4 站，Main 输入采样 -> inputSample -> observeBreakCountdown -> startRunning。
  // 作用：确认空闲阈值前，暂记当前休息轮最后最多 10 秒的倒计时。
  // 原因：达到阈值后才扣除已观测的候选时长，避免等待确认的时间被遗漏。
  // 边界：候选仅在内存中；不补计休息轮开始、故障、睡眠或重启之前的时间。
  private observeBreakCountdown(idleSeconds: number, now: number): number {
    if (this.snapshotValue.round.kind === "focus" || this.snapshotValue.status !== "auto-paused" || this.snapshotValue.automation.manualPauseLocked) {
      this.pendingBreakCountdown = undefined;
      return 0;
    }

    const threshold = this.settingsValue.inputIdleThresholdSeconds;
    const idleStartedAt = now - idleSeconds * 1000;
    if (idleSeconds < Math.max(0, threshold - 10)
      || (this.pendingBreakCountdown && idleStartedAt - this.pendingBreakCountdown.idleStartedAt > 1000)) {
      this.pendingBreakCountdown = undefined;
    }

    if (idleSeconds >= threshold) {
      const confirmedMs = this.pendingBreakCountdown
        ? Math.max(0, Math.min(10_000, Math.floor(now - this.pendingBreakCountdown.startedAt), this.snapshotValue.remainingMs))
        : 0;
      this.pendingBreakCountdown = undefined;
      return confirmedMs;
    }

    if (idleSeconds >= Math.max(0, threshold - 10)) {
      this.pendingBreakCountdown ??= { startedAt: now, idleStartedAt };
    }
    return 0;
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
        activePresenceSource: "input",
        inputPresence: "unknown",
        cameraPresence: "unknown",
        inputMonitoringAvailable: true,
        cameraMonitoringAvailable: false,
        manualPauseLocked: false,
        pauseReason: "none",
      },
    };
  }

  private startRunning(now: number): void {
    this.pendingBreakCountdown = undefined;
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

  private tick(): void {
    if (this.snapshotValue.status !== "running" || this.runningSince === undefined) return;
    const now = this.clock.now();
    const remaining = this.snapshotValue.remainingMs - Math.floor(now - this.runningSince);
    if (remaining > 0) {
      this.snapshotValue.remainingMs = remaining;
      this.runningSince = now;
      return;
    }

    const beforeCompletion = structuredClone(this.snapshotValue);
    const current = this.snapshotValue.round;
    this.snapshotValue.remainingMs = 0;
    this.runningSince = undefined;
    this.moveToNextRound();
    this.snapshotValue.revision = beforeCompletion.revision + 1;
    this.snapshotValue.emittedAt = new Date().toISOString();

    try {
      if (current.kind === "focus" && current.focusRoundNumber) {
        const date = this.clock.wallDate();
        this.store.commitCompletedSessionAndSnapshot(
          {
            // A round identity is stable across retries and process restarts.
            id: `focus-${current.cycleNumber}-${current.focusRoundNumber}`,
            completedAt: date.toISOString(),
            localDate: date.toLocaleDateString("sv-SE"),
            localOffsetMinutes: -date.getTimezoneOffset(),
            cycleNumber: current.cycleNumber,
            focusRoundNumber: current.focusRoundNumber,
            plannedDurationSeconds: Math.floor(current.totalDurationMs / 1000),
            activeDurationSeconds: Math.floor(current.totalDurationMs / 1000),
            mode: "seated",
          },
          this.snapshotValue,
        );
      } else {
        this.persist();
      }
    } catch (error) {
      // Keep the just-finished round retryable. The Store transaction has
      // rolled back both the record and snapshot when this path is reached.
      this.snapshotValue = beforeCompletion;
      this.snapshotValue.remainingMs = 0;
      this.runningSince = now;
      throw error;
    }
  }

  private moveToNextRound(): void {
    this.pendingBreakCountdown = undefined;
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
    this.snapshotValue.activeCycleRounds = this.activeCycleRounds;
    this.snapshotValue.round = makeRound(nextKind, nextCycle, focusNumber, position, this.settingsValue);
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

  private emit(): TimerSnapshot {
    this.snapshotValue.revision += 1;
    this.snapshotValue.emittedAt = new Date().toISOString();
    this.snapshotValue.automation.inputPresence = this.inputPresence;
    this.persist();
    return timerSnapshotSchema.parse({ ...this.snapshotValue });
  }

  private persist(): void {
    this.store.saveSnapshot(this.snapshotValue);
  }
}

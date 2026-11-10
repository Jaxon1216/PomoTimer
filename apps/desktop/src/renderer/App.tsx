import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import {
  BarChart3,
  Camera,
  ChevronLeft,
  CircleHelp,
  Moon,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  SkipForward,
  Sun,
  TimerReset,
  Touchpad,
} from "lucide-react";
import type {
  CoreEvent,
  CameraState,
  PresenceSource,
  Settings,
  SettingsPatch,
  StatisticsSnapshot,
  TimerCommand,
  TimerSnapshot,
} from "../shared/contracts";
import { formatDuration } from "./time";
import { startCameraPresence } from "./camera-presence";
import { useTimerFade } from "./use-timer-fade";
import { readDesktopView, type DesktopView } from "../shared/window-view";

type View = DesktopView;

const labels = {
  focus: "专注",
  "short-break": "短休",
  "long-break": "长休",
} as const;

function statusText(snapshot: TimerSnapshot, settings: Settings): string {
  if (snapshot.status === "running") return snapshot.round.kind === "focus" ? "专注中" : "休息中";
  const isFocus = snapshot.round.kind === "focus";
  if (isFocus && snapshot.automation.manualPauseLocked) return "手动暂停 · 点击继续";
  const waitingBreak = !isFocus && (snapshot.status === "idle" || snapshot.status === "manual-paused"
    || snapshot.automation.pauseReason === "break-condition");
  if (waitingBreak) {
    const action = snapshot.remainingMs === snapshot.round.totalDurationMs ? "开始" : "继续";
    if (snapshot.automation.activePresenceSource === "camera") {
      if (!snapshot.automation.cameraMonitoringAvailable) return "等待摄像头检测";
      return `等待离席 · 将自动${action}`;
    }
    if (!snapshot.automation.inputMonitoringAvailable) return "输入检测不可用";
    const preparation = snapshot.automation.breakPreparation;
    return preparation?.countdown
      ? `${preparation.remainingSeconds} 秒后${action}休息`
      : `无输入 ${settings.inputIdleThresholdSeconds} 秒${action}休息`;
  }
  if (snapshot.status === "idle") {
    if (snapshot.automation.activePresenceSource === "camera") return "等待摄像头检测 · 将自动开始";
    return "准备开始";
  }

  switch (snapshot.automation.pauseReason) {
    case "input-away":
      return "无输入 · 自动暂停";
    case "camera-away":
      return "未检测到在场 · 自动暂停";
    case "break-condition": {
      return "等待休息条件";
    }
    case "source-unavailable":
      return snapshot.automation.activePresenceSource === "camera" ? "等待摄像头检测" : "输入检测不可用";
    case "system-suspend":
      return "系统恢复后已暂停";
    case "system-lock":
      return "锁屏已暂停";
    case "storage-unavailable":
      return "本地存储不可用";
    case "core-recovery":
      return "应用恢复后已暂停";
    default:
      return "自动暂停";
  }
}

function IconButton({
  label,
  children,
  onClick,
  className = "",
  title = label,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`iconButton ${className}`}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function primaryCommand(snapshot: TimerSnapshot): {
  command: TimerCommand;
  label: string;
  icon: ReactElement;
} {
  if (snapshot.status === "running") {
    return { command: "pause", label: "暂停计时", icon: <Pause size={16} /> };
  }
  const waitingBreak = snapshot.round.kind !== "focus"
    && snapshot.remainingMs === snapshot.round.totalDurationMs
    && (snapshot.status === "idle" || (snapshot.status === "auto-paused" && snapshot.automation.pauseReason === "break-condition"));
  if (waitingBreak) {
    return { command: snapshot.status === "idle" ? "start" : "resume", label: "手动开始休息", icon: <Play size={16} /> };
  }
  if (snapshot.status === "idle") {
    return { command: "start", label: "开始计时", icon: <Play size={16} /> };
  }
  return { command: "resume", label: "继续计时", icon: <Play size={16} /> };
}

function TimerView({
  snapshot,
  settings,
  onCommand,
  onView,
  onModeChange,
  modeChanging,
}: {
  snapshot: TimerSnapshot;
  settings: Settings;
  onCommand: (command: TimerCommand) => void;
  onView: (view: View) => void;
  onModeChange: (source: PresenceSource) => void;
  modeChanging: boolean;
}): ReactElement {
  const action = primaryCommand(snapshot);
  const [menuOpen, setMenuOpen] = useState(false);
  const { surface, faded } = useTimerFade(settings.autoFade, menuOpen || modeChanging);
  const menuContainer = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const progress = 1 - snapshot.remainingMs / snapshot.round.totalDurationMs;
  const remaining = formatDuration(snapshot.remainingMs);
  const circumference = 2 * Math.PI * 108;
  const currentStatus = statusText(snapshot, settings);
  const monitorStatus = snapshot.automation.activePresenceSource === "camera"
    ? snapshot.automation.cameraMonitoringAvailable
      ? `监控感知 · ${snapshot.automation.cameraPresence === "present" ? "在场" : snapshot.automation.cameraPresence === "away" ? "离开" : "待检测"}`
      : "监控感知 · 正在启动摄像头"
    : snapshot.automation.inputMonitoringAvailable
    ? `系统输入检测 · ${settings.inputIdleThresholdSeconds} 秒阈值`
    : snapshot.status === "auto-paused" && snapshot.automation.pauseReason === "source-unavailable"
      ? "已暂停 · 可手动继续"
      : "输入检测不可用 · 手动控制";
  const rounds = snapshot.activeCycleRounds ?? settings.focusRoundsPerCycle;
  const focusRoundNumber = snapshot.round.focusRoundNumber ?? Math.ceil(snapshot.round.positionInCycle / 2);
  const roundCount = snapshot.round.kind === "focus" ? `第 ${focusRoundNumber}/${rounds} 轮专注`
    : `第 ${snapshot.round.kind === "long-break" ? rounds : focusRoundNumber} 轮后的${labels[snapshot.round.kind]}`;
  const sequence = Array.from({ length: rounds * 2 }, (_, index): { kind: TimerSnapshot["round"]["kind"]; seconds: number; description: string } => {
    const kind = index % 2 === 0 ? "focus" : index === rounds * 2 - 1 ? "long-break" : "short-break";
    const plannedSeconds = kind === "focus" ? settings.focusDurationSeconds
      : kind === "short-break" ? settings.shortBreakDurationSeconds : settings.longBreakDurationSeconds;
    const seconds = index === snapshot.round.positionInCycle - 1 ? snapshot.round.totalDurationMs / 1000 : plannedSeconds;
    return { kind, seconds, description: `${labels[kind]} ${Number((seconds / 60).toFixed(2))} 分钟` };
  });

  useEffect(() => {
    const toggleWithSpace = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.code !== "Space" || event.repeat || event.isComposing || event.keyCode === 229
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || menuOpen) return;
      const target = event.target instanceof Element ? event.target : null;
      const primaryButton = target?.closest(".timerControls .primary");
      if (!primaryButton && target?.closest("button, input, select, textarea, a[href], summary, [contenteditable]:not([contenteditable=false]), [role=button], [role=menu], [role=menuitem], [role=slider], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [tabindex]:not([tabindex='-1']), audio[controls], video[controls]")) return;
      event.preventDefault();
      onCommand(action.command);
    };
    window.addEventListener("keydown", toggleWithSpace);
    return () => window.removeEventListener("keydown", toggleWithSpace);
  }, [action.command, menuOpen, onCommand]);

  useEffect(() => {
    if (!menuOpen) return;
    menuContainer.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuContainer.current?.contains(event.target)) setMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const menuAction = (callback: () => void) => {
    setMenuOpen(false);
    callback();
  };
  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
    const current = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <main ref={surface} className={`timerSurface round-${snapshot.round.kind}`} data-faded={faded}>
      <header className="titlebar">
        <span className="brand">
          POMO<span>DOT</span>
        </span>
        <div className="titleActions">
          <IconButton className="presenceModeButton" disabled={modeChanging}
            label={`感知模式：${settings.focusPresenceSource === "input" ? "触控" : "监控"}，切换为${settings.focusPresenceSource === "input" ? "监控" : "触控"}`}
            title={settings.focusPresenceSource === "input"
              ? "当前：触控感知。使用系统输入（键盘、鼠标、触控板）；点击切换为监控感知。"
              : "当前：监控感知。专注和活动休息使用摄像头，桌前休息使用系统输入；影像仅在本机处理，不保存或上传。点击切换为触控感知。"}
            onClick={() => onModeChange(settings.focusPresenceSource === "input" ? "camera" : "input")}>
            {settings.focusPresenceSource === "input" ? <Touchpad size={16} /> : <Camera size={16} />}
          </IconButton>
          <IconButton label="打开统计" onClick={() => onView("stats")}>
            <BarChart3 size={16} />
          </IconButton>
          <div className="timerMenuContainer" ref={menuContainer}>
            <button type="button" className="iconButton" aria-label="更多操作" title="更多操作" aria-haspopup="menu"
              aria-expanded={menuOpen} aria-controls="timer-menu" ref={menuButton} onClick={() => setMenuOpen((open) => !open)}
              onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setMenuOpen(true); } }}>
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div className="timerMenu" id="timer-menu" role="menu" aria-label="计时器操作" onKeyDown={navigateMenu}>
                <button type="button" role="menuitem" onClick={() => menuAction(() => onView("stats"))}><BarChart3 size={15} />打开统计</button>
                <button type="button" role="menuitem" onClick={() => menuAction(() => onView("settings"))}><SettingsIcon size={15} />打开设置</button>
                <button type="button" role="menuitem" disabled={modeChanging} onClick={() => menuAction(() => onModeChange(settings.focusPresenceSource === "input" ? "camera" : "input"))}><Camera size={15} />{settings.focusPresenceSource === "input" ? "切换为监控感知" : "切换为触控感知"}</button>
                <button type="button" role="menuitem" onClick={() => menuAction(() => onCommand("reset"))}><RotateCcw size={15} />重新开始当前轮次</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className="timerStage" aria-labelledby="round-title">
        <div className="timerDetails">
          <div className="roundMeta">
            <h1 id="round-title">{labels[snapshot.round.kind]}</h1>
            {snapshot.round.kind !== "focus" && <span className="breakMode">{snapshot.round.breakMode === "active" ? "活动休息" : "桌前休息"}</span>}
          </div>
          <div className="timerStatus" aria-live="polite">
            <div className={`statePill state-${snapshot.status}`} title={currentStatus}>
              <span className="stateDot" aria-hidden="true" />
              <span>{currentStatus}</span>
            </div>
            <p className="monitorStatus" data-available={snapshot.automation.activePresenceSource === "camera" ? snapshot.automation.cameraMonitoringAvailable : snapshot.automation.inputMonitoringAvailable}>{monitorStatus}</p>
          </div>
        </div>
        <div className="dialSlot">
          <div
            className="timerDial"
            aria-label={`${labels[snapshot.round.kind]}，剩余 ${formatDuration(snapshot.remainingMs)}，${currentStatus}`}
          >
            <svg viewBox="0 0 230 230" aria-hidden="true">
              <circle className="dialTrack" cx="115" cy="115" r="108" />
              <circle
                className="dialProgress"
                cx="115"
                cy="115"
                r="108"
                style={{
                  strokeDasharray: circumference,
                  strokeDashoffset: circumference * (1 - Math.max(0, Math.min(1, progress))),
                  opacity: progress > 0 ? 1 : 0,
                }}
              />
            </svg>
            <div className="dialContent">
              <time className={remaining.length > 5 ? "longDuration" : undefined}>{remaining}</time>
              <span className="dialTotal">共 {formatDuration(snapshot.round.totalDurationMs)}</span>
            </div>
          </div>
        </div>

        <div className="timerControls" aria-label="计时控制">
          <IconButton label={action.label} onClick={() => onCommand(action.command)} className="primary">
            {action.icon}
          </IconButton>
          <IconButton label="跳到下一轮" onClick={() => onCommand("next")}>
            <SkipForward size={16} />
          </IconButton>
        </div>
      </section>

      <footer className="timerFooter">
        <div className="roundSequence" role="img" aria-label={`第 ${snapshot.round.positionInCycle} / ${rounds * 2} 阶段；${sequence.map((stage) => stage.description).join(" → ")}`}>
          {sequence.map((stage, index) => (
            <span key={index} style={{ flexGrow: stage.seconds }} title={`第 ${index + 1} 阶段 · ${labels[stage.kind]} · ${Number((stage.seconds / 60).toFixed(2))} 分钟`}
              className={index === snapshot.round.positionInCycle - 1 ? "current" : index < snapshot.round.positionInCycle - 1 ? "finished" : ""} />
          ))}
        </div>
        <span className="roundCount" title={roundCount}>{roundCount}</span>
      </footer>
    </main>
  );
}

const numericSettings = {
  focusDurationSeconds: { label: "专注时长", min: 5, max: 120, scale: 60, hint: "分钟 · 下一轮生效" },
  shortBreakDurationSeconds: { label: "短休时长", min: 1, max: 60, scale: 60, hint: "分钟 · 下一轮生效" },
  longBreakDurationSeconds: { label: "长休时长", min: 1, max: 90, scale: 60, hint: "分钟 · 下一轮生效" },
  inputIdleThresholdSeconds: { label: "输入闲置阈值", min: 10, max: 600, scale: 1, hint: "秒 · 下次输入样本生效" },
} as const;
type NumericSetting = keyof typeof numericSettings;
const numericSettingKeys = Object.keys(numericSettings) as NumericSetting[];
function settingsNumbers(settings: Settings): Record<NumericSetting, string> {
  return Object.fromEntries(numericSettingKeys.map((key) => [key, String(settings[key] / numericSettings[key].scale)])) as Record<NumericSetting, string>;
}

function SettingsView({
  settings,
  onSave,
  onBack,
  onModeChange,
  modeChanging,
}: {
  settings: Settings;
  onSave: (patch: SettingsPatch) => Promise<void>;
  onBack: () => void;
  onModeChange: (source: PresenceSource) => void;
  modeChanging: boolean;
}): ReactElement {
  const [draft, setDraft] = useState(settings);
  const [numbers, setNumbers] = useState(() => settingsNumbers(settings));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimeout = useRef<number | undefined>(undefined);
  const previousSettings = useRef(settings);

  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = settings;
    if ((Object.keys(settings) as Array<keyof Settings>).every((key) => key === "focusPresenceSource" || previous[key] === settings[key])) return;
    setDraft(settings);
    setNumbers(settingsNumbers(settings));
  }, [settings]);
  useEffect(() => () => window.clearTimeout(savedTimeout.current), []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const setNumber = (key: NumericSetting, value: string) => {
    setNumbers((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const errors = Object.fromEntries(numericSettingKeys.map((key) => {
    const { min, max } = numericSettings[key];
    const value = Number(numbers[key]);
    return [key, numbers[key].trim() === "" || !Number.isInteger(value) || value < min || value > max
      ? `请输入 ${min}–${max} 之间的整数` : null];
  })) as Record<NumericSetting, string | null>;

  const save = async () => {
    if (saving || numericSettingKeys.some((key) => errors[key])) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await onSave({
        focusDurationSeconds: Number(numbers.focusDurationSeconds) * 60,
        shortBreakDurationSeconds: Number(numbers.shortBreakDurationSeconds) * 60,
        longBreakDurationSeconds: Number(numbers.longBreakDurationSeconds) * 60,
        focusRoundsPerCycle: draft.focusRoundsPerCycle,
        inputIdleThresholdSeconds: Number(numbers.inputIdleThresholdSeconds),
        defaultBreakMode: draft.defaultBreakMode,
        theme: draft.theme,
        alwaysOnTop: draft.alwaysOnTop,
        followWorkspaces: draft.followWorkspaces,
        autoFade: draft.autoFade,
        notificationsEnabled: draft.notificationsEnabled,
      });
      setSaved(true);
      window.clearTimeout(savedTimeout.current);
      savedTimeout.current = window.setTimeout(() => setSaved(false), 1800);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "设置保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const numberInput = (key: NumericSetting) => {
    const { label, min, max, hint } = numericSettings[key];
    return (
      <label key={key} className={key === "inputIdleThresholdSeconds" ? "wideSetting" : undefined}>
        {label}
        <input type="number" aria-label={label} min={min} max={max} step="1" value={numbers[key]}
          aria-invalid={Boolean(errors[key])} aria-describedby={`${key}-hint${errors[key] ? ` ${key}-error` : ""}`}
          disabled={saving} onChange={(event) => setNumber(key, event.target.value)} />
        <small id={`${key}-hint`}>{hint}</small>
        {errors[key] && <span id={`${key}-error`} className="fieldError">{errors[key]}</span>}
      </label>
    );
  };

  return (
    <main className="pageSurface">
      <header className="pageHeader">
        <button className="backButton" type="button" aria-label="返回计时器" onClick={onBack}>
          <ChevronLeft size={17} />
          <span className="backLabel">计时器</span>
        </button>
        <h1>设置</h1>
        <span className="headerSpacer" />
      </header>

      <div className="settingsScroll">
        <fieldset className="settingsFields" disabled={saving}>
          <section className="settingsSection">
            <h2>节奏</h2>
            <div className="settingGrid">
              {numericSettingKeys.filter((key) => key !== "inputIdleThresholdSeconds").map(numberInput)}
              <label>
                每周期专注轮数
                <select
                  value={draft.focusRoundsPerCycle}
                  onChange={(event) => set("focusRoundsPerCycle", Number(event.target.value))}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
                    <option key={number} value={number}>
                      {number} 轮
                    </option>
                  ))}
                </select>
                <small>下一周期生效</small>
              </label>
            </div>
          </section>

          <section className="settingsSection">
            <h2>自动化</h2>
            <div className="segmented" role="group" aria-label="感知模式">
              <span>感知模式</span>
              <button type="button" disabled={modeChanging} aria-pressed={settings.focusPresenceSource === "input"} onClick={() => onModeChange("input")}>触控</button>
              <button type="button" disabled={modeChanging} aria-pressed={settings.focusPresenceSource === "camera"} onClick={() => onModeChange("camera")}>监控</button>
            </div>
            <p className="infoNote">立即生效。监控会请求摄像头权限：专注在场计时，活动休息离席计时；桌前休息根据系统输入计时。画面只在本机处理，不保存或上传。切回触控会关闭摄像头。</p>
            {numberInput("inputIdleThresholdSeconds")}
            <div className="segmented">
              <span>默认休息模式</span>
              <button
                type="button"
                className={draft.defaultBreakMode === "active" ? "selected" : ""}
                aria-pressed={draft.defaultBreakMode === "active"}
                onClick={() => set("defaultBreakMode", "active")}
              >
                活动休息
              </button>
              <button
                type="button"
                className={draft.defaultBreakMode === "desk" ? "selected" : ""}
                aria-pressed={draft.defaultBreakMode === "desk"}
                onClick={() => set("defaultBreakMode", "desk")}
              >
                桌前休息
              </button>
            </div>
            <p className="infoNote">
              <CircleHelp size={14} />
              系统输入只传递距最近输入的秒数，不会记录按键、鼠标位置或活动窗口。
            </p>
          </section>

          <section className="settingsSection">
            <h2>外观与系统</h2>
            <div className="themeChoices">
              <button type="button" aria-pressed={draft.theme === "light"} className={draft.theme === "light" ? "selected" : ""} onClick={() => set("theme", "light")}>
                <Sun size={16} />浅色
              </button>
              <button type="button" aria-pressed={draft.theme === "dark"} className={draft.theme === "dark" ? "selected" : ""} onClick={() => set("theme", "dark")}>
                <Moon size={16} />深色
              </button>
              <button type="button" aria-pressed={draft.theme === "system"} className={draft.theme === "system" ? "selected" : ""} onClick={() => set("theme", "system")}>
                <CircleHelp size={16} />跟随系统
              </button>
            </div>
            <label className="toggleRow">
              <span>常驻顶部</span>
              <input type="checkbox" checked={draft.alwaysOnTop} onChange={(event) => set("alwaysOnTop", event.target.checked)} />
            </label>
            <label className="toggleRow">
              <span>跟随桌面与全屏</span>
              <input type="checkbox" checked={draft.followWorkspaces}
                disabled={document.documentElement.dataset.platform !== "macos"}
                aria-describedby="follow-workspaces-hint"
                onChange={(event) => set("followWorkspaces", event.target.checked)} />
            </label>
            <p className="infoNote" id="follow-workspaces-hint">仅 macOS。切换桌面或进入全屏应用时仍显示计时器；置顶单独控制。</p>
            <label className="toggleRow">
              <span>自动淡化</span>
              <input type="checkbox" checked={draft.autoFade} aria-describedby="auto-fade-hint"
                onChange={(event) => set("autoFade", event.target.checked)} />
            </label>
            <p className="infoNote" id="auto-fade-hint">鼠标离开计时器两秒后淡化背景和辅助信息，移入恢复。数字、状态与操作保持清晰。</p>
            <label className="toggleRow">
              <span>完成弹窗与暂停通知</span>
              <input type="checkbox" checked={draft.notificationsEnabled} onChange={(event) => set("notificationsEnabled", event.target.checked)} />
            </label>
          </section>
        </fieldset>
      </div>

      {saveError && <p className="inlineError" role="alert">{saveError} · 请修改后重试，或再次保存。</p>}
      <footer className="settingsFooter">
        <span className="saveHint" aria-live="polite">{saved ? "已保存" : "修改将在保存后生效"}</span>
        <button type="button" className="saveButton" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存设置"}
        </button>
      </footer>
    </main>
  );
}

function localWeekday(localDate: string): number {
  return (new Date(`${localDate}T12:00:00`).getDay() + 6) % 7;
}

function heatClass(minutes: number, maximum: number): string {
  if (minutes <= 0) return "heat-0";
  return `heat-${Math.max(1, Math.ceil((minutes / maximum) * 5))}`;
}

function StatsView({
  statistics,
  settings,
  error,
  onRetry,
  onBack,
}: {
  statistics: StatisticsSnapshot | null;
  settings: Settings;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}): ReactElement {
  const heatmapFrame = useRef<HTMLDivElement>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const lastDate = statistics?.heatmap.at(-1)?.localDate;
  const hasRecords = statistics?.heatmap.some((day) => day.completedFocusMinutes > 0) ?? false;
  useEffect(() => {
    const frame = heatmapFrame.current;
    if (frame) frame.scrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  }, [lastDate, error, hasRecords]);

  if (!statistics || error) {
    return (
      <main className="pageSurface">
        <header className="pageHeader">
          <button className="backButton" type="button" aria-label="返回计时器" onClick={onBack}>
            <ChevronLeft size={17} /><span className="backLabel">计时器</span>
          </button>
          <h1>统计</h1>
          <span className="headerSpacer" />
        </header>
        <div className="loadingSurface">
          {error ? <>
            <p role="alert">{error}</p>
            <button className="saveButton" type="button" onClick={onRetry}>重试加载统计</button>
          </> : <><span className="loadingLine" /><p>正在加载统计</p></>}
        </div>
      </main>
    );
  }

  const maximum = Math.max(1, ...statistics.heatmap.map((day) => day.completedFocusMinutes));
  const targetMinutes = (settings.focusDurationSeconds * settings.focusRoundsPerCycle) / 60;
  const todayPercent = targetMinutes > 0
    ? Math.min(100, Math.round((statistics.today.completedFocusMinutes / targetMinutes) * 100))
    : 0;
  const leadingCells = statistics.heatmap.length > 0 ? localWeekday(statistics.heatmap[0]!.localDate) : 0;
  const heatmapCells = [
    ...Array.from({ length: leadingCells }, () => null),
    ...statistics.heatmap,
  ];
  while (heatmapCells.length % 7 !== 0) heatmapCells.push(null);
  const heatmapWeeks = Array.from({ length: heatmapCells.length / 7 }, (_, index) =>
    heatmapCells.slice(index * 7, index * 7 + 7).find((day) => day !== null)?.localDate ?? "");
  const ringStyle = { "--progress": `${todayPercent}%` } as CSSProperties;
  const selectedDay = statistics.heatmap.find((day) => day.localDate === selectedDate);
  const navigateHeatmap = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offsets: Record<string, number> = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };
    if (!(event.key in offsets) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? statistics.heatmap.length - 1
      : Math.max(0, Math.min(statistics.heatmap.length - 1, index + offsets[event.key]!));
    heatmapFrame.current?.querySelectorAll<HTMLButtonElement>("[data-heatmap-day]")[next]?.focus();
  };

  return (
    <main className="pageSurface">
      <header className="pageHeader">
        <button className="backButton" type="button" aria-label="返回计时器" onClick={onBack}>
          <ChevronLeft size={17} /><span className="backLabel">计时器</span>
        </button>
        <h1>统计</h1>
        <span className="headerSpacer" />
      </header>

      <div className="statsScroll">
        <section className="statsHero">
          <div>
            <span>今日专注</span>
            <strong>
              {statistics.today.completedFocusMinutes}
              <small> 分钟</small>
            </strong>
            <em>
              {statistics.today.completedFocusRounds} 个完整轮次 · 一周期 {targetMinutes} 分钟
            </em>
          </div>
          <div
            className="todayRing"
            style={ringStyle}
            aria-label={`一周期目标 ${targetMinutes} 分钟，今日完成 ${todayPercent}%`}
          >
            <span>{todayPercent}%</span>
          </div>
        </section>

        <section className="statsSection">
          <div className="sectionTitle">
            <h2>本周</h2>
            <span>按本机日期</span>
          </div>
          <div className="weekBars">
            {statistics.week.map((day) => {
              const weekMaximum = Math.max(1, ...statistics.week.map((item) => item.completedFocusMinutes));
              return (
                <div className="weekDay" key={day.localDate}>
                  <div className="barWrap">
                    <div className="bar" style={{ height: `${Math.max(4, (day.completedFocusMinutes / weekMaximum) * 100)}%` }} />
                  </div>
                  <b>{day.completedFocusMinutes || "·"}</b>
                  <small>{day.localDate.slice(5)}</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className="statsSection">
          <div className="sectionTitle">
            <h2>最近 52 周</h2>
            <span>
              {hasRecords
                ? `${statistics.heatmap.reduce((sum, day) => sum + day.completedFocusMinutes, 0)} 分钟`
                : "还没有完成记录"}
            </span>
          </div>
          {hasRecords ? (
            <div className="heatmapFrame" ref={heatmapFrame} role="region" aria-label="最近 52 周专注热力图">
              <div className="heatmapWeekdays" aria-hidden="true">
                {['一', '', '三', '', '五', '', '日'].map((day, index) => <span key={index}>{day}</span>)}
              </div>
              <div className="heatmapCalendar">
                <div className="heatmapMonths" aria-hidden="true">
                  {heatmapWeeks.map((date, index) => <span key={index}>
                    {date && (index === 0 || date.slice(0, 7) !== heatmapWeeks[index - 1]?.slice(0, 7)) ? `${Number(date.slice(5, 7))}月` : ""}
                  </span>)}
                </div>
                <div className="heatmap">
                  {heatmapCells.map((day, index) => day ? (
                    <button type="button" key={day.localDate} data-heatmap-day
                      className={heatClass(day.completedFocusMinutes, maximum)}
                      aria-label={`${day.localDate}，专注 ${day.completedFocusMinutes} 分钟`}
                      tabIndex={day.localDate === (selectedDay?.localDate ?? lastDate) ? 0 : -1}
                      title={`${day.localDate} · ${day.completedFocusMinutes} 分钟`}
                      onFocus={() => setSelectedDate(day.localDate)} onClick={() => setSelectedDate(day.localDate)}
                      onKeyDown={(event) => navigateHeatmap(event, index - leadingCells)} />
                  ) : <span key={`empty-${index}`} className="heat-empty" aria-hidden="true" />)}
                </div>
              </div>
            </div>
          ) : (
            <p className="emptyState">完成一个完整专注轮后，这里会显示你的节奏。</p>
          )}
          {hasRecords && <>
            <p className="heatmapDetails" aria-live="polite">{selectedDay
              ? `${selectedDay.localDate} · ${selectedDay.completedFocusMinutes} 分钟`
              : "用方向键浏览日期，聚焦查看专注分钟。"}</p>
            <p className="heatmapLegend">颜色越深，完成专注分钟越多；空白表示没有完成记录。</p>
          </>}
        </section>
      </div>
    </main>
  );
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [statistics, setStatistics] = useState<StatisticsSnapshot | null>(null);
  const [statisticsError, setStatisticsError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => readDesktopView(window.location.hash));
  const [fatalError, setFatalError] = useState<{ title: string; message: string; storage: boolean } | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>({ enabled: false, generation: 0 });
  const [modeChanging, setModeChanging] = useState(false);
  const modeChangePending = useRef(false);
  const statisticsRequest = useRef(0);

  useEffect(() => {
    window.history.replaceState(null, "", `#${view}`);
  }, [view]);

  const syncStats = useCallback(async () => {
    const request = ++statisticsRequest.current;
    setStatisticsError(null);
    try {
      const next = await window.pomodoro.getStatistics();
      if (request === statisticsRequest.current) setStatistics(next);
    } catch (reason) {
      if (request === statisticsRequest.current) setStatisticsError(reason instanceof Error ? reason.message : "统计读取失败");
    }
  }, []);

  const runCommand = useCallback(async (command: TimerCommand) => {
    try {
      setSnapshot(await window.pomodoro.command(command));
      setOperationError(null);
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : "计时操作未完成，请重试");
    }
  }, []);

  const saveSettings = useCallback(async (patch: SettingsPatch) => {
    setSettings(await window.pomodoro.updateSettings(patch));
  }, []);

  const changeMode = useCallback(async (source: PresenceSource) => {
    if (modeChangePending.current) return;
    modeChangePending.current = true;
    setModeChanging(true);
    try {
      await saveSettings({ focusPresenceSource: source });
      setOperationError(null);
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : "感知模式切换失败，请重试");
    } finally {
      modeChangePending.current = false;
      setModeChanging(false);
    }
  }, [saveSettings]);

  useEffect(() => {
    let active = true;
    void Promise.all([window.pomodoro.getSnapshot(), window.pomodoro.getSettings(), window.pomodoro.getCameraState()])
      .then(([nextSnapshot, nextSettings, nextCameraState]) => {
        if (active) {
          setSnapshot(nextSnapshot);
          setSettings(nextSettings);
          setCameraState((current) => current.generation > nextCameraState.generation ? current : nextCameraState);
        }
      })
      .catch((reason) => {
        if (active) setFatalError({ title: "计时核心不可用", message: reason instanceof Error ? reason.message : "计时核心不可用", storage: false });
      });

    const unsubscribe = window.pomodoro.subscribe((event: CoreEvent) => {
      if (event.type === "timer.snapshot") setSnapshot(event.snapshot);
      if (event.type === "camera.state") setCameraState((current) => current.generation > event.state.generation ? current : event.state);
      if (event.type === "settings.changed") setSettings(event.settings);
      if (event.type === "stats.changed") {
        ++statisticsRequest.current;
        setStatistics(event.statistics);
        setStatisticsError(null);
      }
      if (event.type === "core.error") {
        if (event.recoverable) setOperationError(event.message);
        else setFatalError({ title: event.code === "STORAGE_UNAVAILABLE" ? "本地存储不可用" : "计时核心不可用", message: event.message, storage: event.code === "STORAGE_UNAVAILABLE" });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!cameraState.enabled || fatalError) return;
    let active = true;
    const stop = startCameraPresence(async (presence) => {
      if (active) await window.pomodoro.reportCameraPresence(presence, cameraState.generation);
    }, (message) => {
      if (!active) return;
      setOperationError(message);
      void window.pomodoro.reportCameraPresence("unknown", cameraState.generation).catch(() => {
        // 领域：Camera / IPC 故障
        // 顺序：Renderer 故障上报失败 -> Main 心跳期限 -> 触控回退。
        // 作用：跨进程中断时等待 Main 的安全回退。
        // 原因：前端不能自行决定权威计时或持久化模式。
        // 边界：本地摄像头已由 controller 释放，不在此重复启动。
      });
    });
    return () => { active = false; stop(); };
  }, [cameraState.enabled, cameraState.generation, fatalError]);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : undefined;
    const applyTheme = () => {
      const dark = settings.theme === "dark" || (settings.theme === "system" && Boolean(media?.matches));
      root.dataset.theme = settings.theme;
      root.classList.toggle("dark", dark);
    };

    applyTheme();
    media?.addEventListener("change", applyTheme);
    return () => media?.removeEventListener("change", applyTheme);
  }, [settings]);

  useEffect(() => {
    if (view !== "stats") return;
    void syncStats();
    const refresh = () => { void syncStats(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [view, syncStats]);

  if (fatalError) {
    return (
      <main className="failureSurface" role="alert">
        <TimerReset size={26} />
        <h1>{fatalError.title}</h1>
        <p>{fatalError.message}</p>
        {fatalError.storage ? <p>计时已安全暂停，请重新打开应用后重试。</p> : <button className="saveButton" type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>}
      </main>
    );
  }

  if (!snapshot || !settings) {
    return (
      <main className="loadingSurface">
        <span className="loadingLine" />
        <p>正在打开本地计时器</p>
      </main>
    );
  }

  return <div className="appShell">
    {operationError && <div className="operationError" role="alert"><span>{operationError}</span>
      <button type="button" aria-label="关闭错误提示" onClick={() => setOperationError(null)}>关闭</button></div>}
    {view === "settings" ? <SettingsView settings={settings} onSave={saveSettings} onBack={() => setView("timer")}
      onModeChange={(source) => void changeMode(source)} modeChanging={modeChanging} />
      : view === "stats" ? <StatsView statistics={statistics} settings={settings} error={statisticsError}
        onRetry={() => void syncStats()} onBack={() => setView("timer")} />
        : <TimerView snapshot={snapshot} settings={settings}
          onModeChange={(source) => void changeMode(source)} modeChanging={modeChanging}
          onCommand={(command) => void runCommand(command)} onView={setView} />}
  </div>;
}

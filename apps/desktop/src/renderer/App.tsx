import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  BarChart3,
  ChevronLeft,
  CircleHelp,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  SkipForward,
  Sun,
  TimerReset,
} from "lucide-react";
import type {
  CoreEvent,
  Settings,
  SettingsPatch,
  StatisticsSnapshot,
  TimerCommand,
  TimerSnapshot,
} from "../shared/contracts";
import { formatDuration } from "./time";

type View = "timer" | "settings" | "stats";

const labels = {
  focus: "专注",
  "short-break": "短休",
  "long-break": "长休",
} as const;

function statusText(snapshot: TimerSnapshot, compact = false): string {
  if (snapshot.status === "idle") return "准备开始";
  if (snapshot.status === "running") return snapshot.round.kind === "focus" ? "专注中" : "休息中";
  if (snapshot.status === "manual-paused") return "手动暂停";

  if (compact) {
    switch (snapshot.automation.pauseReason) {
      case "input-away": return "离席 · 自动暂停";
      case "break-condition": return snapshot.status === "auto-paused" ? "等待离席" : "回到工位 · 休息暂停";
      case "source-unavailable": return "检测不可用 · 手动控制";
      case "system-suspend": return "系统暂停";
      case "core-recovery": return "恢复后暂停";
      default: return "自动暂停";
    }
  }

  switch (snapshot.automation.pauseReason) {
    case "input-away":
      return "离席，已自动暂停";
    case "break-condition":
      return snapshot.status === "auto-paused" ? "等待离席后开始休息" : "回到工位，休息已暂停";
    case "source-unavailable":
      return "输入检测不可用，需手动控制";
    case "system-suspend":
      return "系统恢复后已暂停";
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
  disabled = false,
}: {
  label: string;
  children: ReactElement;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`iconButton ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
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
    return { command: "pause", label: "暂停计时", icon: <Pause size={21} /> };
  }
  if (snapshot.status === "idle") {
    return { command: "start", label: "开始计时", icon: <Play size={21} /> };
  }
  return { command: "resume", label: "继续计时", icon: <Play size={21} /> };
}

function TimerView({
  snapshot,
  settings,
  compact,
  onCommand,
  onView,
}: {
  snapshot: TimerSnapshot;
  settings: Settings;
  compact: boolean;
  onCommand: (command: TimerCommand) => void;
  onView: (view: View) => void;
}): ReactElement {
  const action = primaryCommand(snapshot);
  const progress = 1 - snapshot.remainingMs / snapshot.round.totalDurationMs;
  const circumference = 2 * Math.PI * 108;
  const monitorStatus = snapshot.automation.inputMonitoringAvailable
    ? `系统输入检测 · ${settings.inputIdleThresholdSeconds} 秒阈值`
    : "输入检测不可用 · 手动控制模式";

  return (
    <main className={`timerSurface round-${snapshot.round.kind}${compact ? " compact" : ""}`}>
      <header className="titlebar">
        <span className="brand">
          POMO<span>DOT</span>
        </span>
        <div className="titleActions">
          <IconButton label="打开统计" onClick={() => onView("stats")}>
            <BarChart3 size={16} />
          </IconButton>
          <IconButton label="打开设置" onClick={() => onView("settings")}>
            <SettingsIcon size={16} />
          </IconButton>
        </div>
      </header>

      <section className="timerStage" aria-labelledby="round-title">
        <div className="dialSlot">
          <div
            className="timerDial"
            aria-label={`${labels[snapshot.round.kind]}，剩余 ${formatDuration(snapshot.remainingMs)}，${statusText(snapshot)}`}
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
                }}
              />
            </svg>
            <div className="dialContent">
              <time>{formatDuration(snapshot.remainingMs)}</time>
            </div>
          </div>
        </div>

        <div className="roundMeta">
          <span className="eyebrow">{snapshot.round.cycleNumber.toString().padStart(2, "0")} / 周期</span>
          <h1 id="round-title">{labels[snapshot.round.kind]}</h1>
          {snapshot.round.kind !== "focus" && (
            <span className="breakMode">
              {snapshot.round.breakMode === "active" ? "活动休息" : "桌前休息"}
            </span>
          )}
        </div>

        <div className={`statePill state-${snapshot.status}`} title={statusText(snapshot)}>
          <span className="stateDot" />
          {statusText(snapshot, compact)}
        </div>
        <p className="monitorStatus">{monitorStatus}</p>

        <div className="timerControls" aria-label="计时控制">
          <IconButton label="重新开始当前轮次" onClick={() => onCommand("reset")}>
            <RotateCcw size={17} />
          </IconButton>
          <IconButton label={action.label} onClick={() => onCommand(action.command)} className="primary">
            {action.icon}
          </IconButton>
          <IconButton label="跳到下一轮" onClick={() => onCommand("next")}>
            <SkipForward size={17} />
          </IconButton>
        </div>
      </section>

      <footer className="timerFooter">
        <span className="roundCount">
          {snapshot.round.focusRoundNumber ?? "休"} <small>/ {snapshot.activeCycleRounds ?? settings.focusRoundsPerCycle}</small>
        </span>
        <span className="footerHint">{snapshot.round.kind === "focus" ? "专注轮次" : "休息轮次"}</span>
        <button type="button" className="textControl" onClick={() => onCommand("reset")}>
          重置
        </button>
      </footer>
    </main>
  );
}

function SettingsView({
  settings,
  onSave,
  onBack,
}: {
  settings: Settings;
  onSave: (patch: SettingsPatch) => Promise<void>;
  onBack: () => void;
}): ReactElement {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    await onSave({
      focusDurationSeconds: draft.focusDurationSeconds,
      shortBreakDurationSeconds: draft.shortBreakDurationSeconds,
      longBreakDurationSeconds: draft.longBreakDurationSeconds,
      focusRoundsPerCycle: draft.focusRoundsPerCycle,
      inputIdleThresholdSeconds: draft.inputIdleThresholdSeconds,
      defaultBreakMode: draft.defaultBreakMode,
      theme: draft.theme,
      alwaysOnTop: draft.alwaysOnTop,
      notificationsEnabled: draft.notificationsEnabled,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
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
        <section className="settingsSection">
          <h2>节奏</h2>
          <div className="settingGrid">
            <label>
              专注时长
              <input
                type="number"
                min="5"
                max="120"
                value={draft.focusDurationSeconds / 60}
                onChange={(event) => set("focusDurationSeconds", Number(event.target.value) * 60)}
              />
              <small>分钟 · 下一轮生效</small>
            </label>
            <label>
              短休时长
              <input
                type="number"
                min="1"
                max="60"
                value={draft.shortBreakDurationSeconds / 60}
                onChange={(event) => set("shortBreakDurationSeconds", Number(event.target.value) * 60)}
              />
              <small>分钟 · 下一轮生效</small>
            </label>
            <label>
              长休时长
              <input
                type="number"
                min="1"
                max="90"
                value={draft.longBreakDurationSeconds / 60}
                onChange={(event) => set("longBreakDurationSeconds", Number(event.target.value) * 60)}
              />
              <small>分钟 · 下一轮生效</small>
            </label>
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
          <label className="wideSetting">
            输入闲置阈值
            <input
              type="number"
              min="10"
              max="600"
              value={draft.inputIdleThresholdSeconds}
              onChange={(event) => set("inputIdleThresholdSeconds", Number(event.target.value))}
            />
            <small>秒 · 下次输入样本生效</small>
          </label>
          <div className="segmented">
            <span>默认休息模式</span>
            <button
              type="button"
              className={draft.defaultBreakMode === "active" ? "selected" : ""}
              onClick={() => set("defaultBreakMode", "active")}
            >
              活动休息
            </button>
            <button
              type="button"
              className={draft.defaultBreakMode === "desk" ? "selected" : ""}
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
            <button type="button" className={draft.theme === "light" ? "selected" : ""} onClick={() => set("theme", "light")}>
              <Sun size={16} />浅色
            </button>
            <button type="button" className={draft.theme === "dark" ? "selected" : ""} onClick={() => set("theme", "dark")}>
              <Moon size={16} />深色
            </button>
            <button type="button" className={draft.theme === "system" ? "selected" : ""} onClick={() => set("theme", "system")}>
              <CircleHelp size={16} />跟随系统
            </button>
          </div>
          <label className="toggleRow">
            <span>常驻顶部</span>
            <input type="checkbox" checked={draft.alwaysOnTop} onChange={(event) => set("alwaysOnTop", event.target.checked)} />
          </label>
          <label className="toggleRow">
            <span>完成与暂停通知</span>
            <input type="checkbox" checked={draft.notificationsEnabled} onChange={(event) => set("notificationsEnabled", event.target.checked)} />
          </label>
        </section>
      </div>

      <footer className="settingsFooter">
        <span className="saveHint">{saved ? "已保存" : "修改将在保存后生效"}</span>
        <button type="button" className="saveButton" onClick={() => void save()}>
          保存设置
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
  onBack,
}: {
  statistics: StatisticsSnapshot | null;
  settings: Settings;
  onBack: () => void;
}): ReactElement {
  if (!statistics) {
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
          <span className="loadingLine" />
          <p>正在加载统计</p>
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
  const hasRecords = statistics.heatmap.some((day) => day.completedFocusMinutes > 0);
  const ringStyle = { "--progress": `${todayPercent}%` } as CSSProperties;

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
            <div className="heatmapFrame" aria-label="最近 52 周专注热力图">
              <div className="heatmapWeekdays" aria-hidden="true">
                {['一', '', '三', '', '五', '', '日'].map((day, index) => <span key={index}>{day}</span>)}
              </div>
              <div className="heatmap">
                {heatmapCells.map((day, index) => (
                  <span
                    key={day?.localDate ?? `empty-${index}`}
                    className={day ? heatClass(day.completedFocusMinutes, maximum) : "heat-empty"}
                    title={day ? `${day.localDate} · ${day.completedFocusMinutes} 分钟` : undefined}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="emptyState">完成一个完整专注轮后，这里会显示你的节奏。</p>
          )}
        </section>
      </div>
    </main>
  );
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [statistics, setStatistics] = useState<StatisticsSnapshot | null>(null);
  const [view, setView] = useState<View>("timer");
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);

  const syncStats = useCallback(async () => {
    setStatistics(await window.pomodoro.getStatistics());
  }, []);

  const runCommand = useCallback(async (command: TimerCommand) => {
    try {
      setSnapshot(await window.pomodoro.command(command));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "计时操作未完成");
    }
  }, []);

  const saveSettings = useCallback(async (patch: SettingsPatch) => {
    try {
      setSettings(await window.pomodoro.updateSettings(patch));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置保存失败");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([window.pomodoro.getSnapshot(), window.pomodoro.getSettings()])
      .then(([nextSnapshot, nextSettings]) => {
        if (active) {
          setSnapshot(nextSnapshot);
          setSettings(nextSettings);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "计时核心不可用");
      });

    const unsubscribe = window.pomodoro.subscribe((event: CoreEvent) => {
      if (event.type === "timer.snapshot") setSnapshot(event.snapshot);
      if (event.type === "stats.changed") setStatistics(event.statistics);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const resize = () => setCompact(window.innerWidth <= 300 || window.innerHeight <= 390);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

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
    if (view === "stats") void syncStats();
  }, [view, syncStats]);

  if (error) {
    return (
      <main className="failureSurface" role="alert">
        <TimerReset size={26} />
        <h1>计时核心不可用</h1>
        <p>{error}</p>
        <button className="saveButton" type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
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

  if (view === "settings") return <SettingsView settings={settings} onSave={saveSettings} onBack={() => setView("timer")} />;
  if (view === "stats") return <StatsView statistics={statistics} settings={settings} onBack={() => setView("timer")} />;
  return <TimerView snapshot={snapshot} settings={settings} compact={compact} onCommand={(command) => void runCommand(command)} onView={setView} />;
}

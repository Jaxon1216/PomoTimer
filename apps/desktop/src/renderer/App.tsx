import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  TimerReset,
  type LucideIcon,
} from "lucide-react";
import type {
  Capabilities,
  Settings,
  TimerCommand,
  TimerSnapshot,
} from "../shared/contracts";

interface CoreViewModel {
  snapshot: TimerSnapshot;
  settings: Settings;
  capabilities: Capabilities;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function roundLabel(kind: TimerSnapshot["round"]["kind"]): string {
  if (kind === "focus") {
    return "专注";
  }
  return kind === "short-break" ? "短休" : "长休";
}

function stateLabel(snapshot: TimerSnapshot): string {
  if (snapshot.status === "idle") {
    return "准备开始";
  }
  if (snapshot.status === "running") {
    return "计时中";
  }
  if (snapshot.status === "manual-paused") {
    return "已手动暂停";
  }
  return snapshot.automation.pauseReason === "core-recovery"
    ? "恢复后已暂停"
    : "等待检测条件";
}

function IconButton({
  label,
  icon: Icon,
  className = "",
  disabled = false,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
}): ReactElement {
  return (
    <button
      className={`iconButton ${className}`}
      disabled={disabled}
      aria-label={label}
      title={label}
      type="button"
      onClick={onClick}
    >
      <Icon
        aria-hidden="true"
        size={className.includes("primary") ? 21 : 17}
        strokeWidth={1.8}
      />
    </button>
  );
}

function primaryAction(snapshot: TimerSnapshot): {
  command: TimerCommand;
  label: string;
  icon: LucideIcon;
} {
  if (snapshot.status === "running") {
    return { command: "pause", label: "暂停计时", icon: Pause };
  }
  if (snapshot.status === "idle") {
    return { command: "start", label: "开始计时", icon: Play };
  }
  return { command: "resume", label: "继续计时", icon: Play };
}

function AppShell({
  data,
  compact,
  pendingCommand,
  commandFeedback,
  onCommand,
}: {
  data: CoreViewModel;
  compact: boolean;
  pendingCommand: TimerCommand | null;
  commandFeedback: string | null;
  onCommand: (command: TimerCommand) => void;
}): ReactElement {
  const { snapshot, settings, capabilities } = data;
  const action = primaryAction(snapshot);
  const controlsDisabled = pendingCommand !== null;
  const elapsedPercent = useMemo(() => {
    const total = snapshot.round.totalDurationMs;
    return total > 0
      ? Math.max(0, Math.min(1, 1 - snapshot.remainingMs / total))
      : 0;
  }, [snapshot.remainingMs, snapshot.round.totalDurationMs]);
  const circumference = 2 * Math.PI * 110;
  const dashOffset = circumference * (1 - elapsedPercent);

  return (
    <main
      className={`timerSurface round-${snapshot.round.kind}${
        compact ? " compact" : ""
      }`}
    >
      <header className="titlebar" />

      <section className="timerStage" aria-labelledby="round-title">
        <div
          className="timerDial"
          aria-label={`${roundLabel(snapshot.round.kind)}，剩余 ${formatDuration(
            snapshot.remainingMs,
          )}，${stateLabel(snapshot)}`}
        >
          <svg viewBox="0 0 230 230" aria-hidden="true">
            <circle className="dialTrack" cx="115" cy="115" r="110" />
            <circle
              className="dialProgress"
              cx="115"
              cy="115"
              r="110"
              style={{
                strokeDasharray: circumference,
                strokeDashoffset: dashOffset,
              }}
            />
          </svg>
          <div className="dialContent">
            <time>{formatDuration(snapshot.remainingMs)}</time>
          </div>
        </div>

        <div className="roundMeta">
          <h1 id="round-title">{roundLabel(snapshot.round.kind)}</h1>
        </div>
        <span className="srOnly" role="status">
          {commandFeedback ?? stateLabel(snapshot)}
        </span>

        <div className="timerControls" aria-label="计时控制">
          <IconButton
            label="重新开始当前轮次"
            icon={SkipBack}
            disabled={controlsDisabled}
            onClick={() => onCommand("reset")}
          />
          <IconButton
            label={action.label}
            icon={action.icon}
            className="primary"
            disabled={controlsDisabled}
            onClick={() => onCommand(action.command)}
          />
          <IconButton
            label="跳到下一轮"
            icon={SkipForward}
            disabled={controlsDisabled}
            onClick={() => onCommand("next")}
          />
        </div>
      </section>

      <footer className="timerFooter">
        <span className="roundCount">
          {snapshot.round.focusRoundNumber ?? settings.focusRoundsPerCycle} /{" "}
          {settings.focusRoundsPerCycle}
        </span>
        <button
          className="textControl"
          type="button"
          disabled={controlsDisabled}
          title="重置当前轮次"
          onClick={() => onCommand("reset")}
        >
          重置
        </button>
        <span className="srOnly">
          {capabilities.inputMonitoring
            ? `输入检测已连接，闲置阈值 ${settings.inputIdleThresholdSeconds} 秒`
            : "输入检测不可用"}
        </span>
      </footer>
    </main>
  );
}

export function App(): ReactElement {
  const [data, setData] = useState<CoreViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCommand, setPendingCommand] = useState<TimerCommand | null>(null);
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);

  const syncSnapshot = useCallback(async () => {
    const snapshot = await window.pomodoro.getSnapshot();
    setData((current) =>
      current ? { ...current, snapshot } : current,
    );
  }, []);

  const runCommand = useCallback(async (command: TimerCommand) => {
    setPendingCommand(command);
    setCommandFeedback(null);
    try {
      const snapshot = await window.pomodoro.command(command);
      setData((current) =>
        current ? { ...current, snapshot } : current,
      );
    } catch (reason: unknown) {
      setCommandFeedback(
        reason instanceof Error ? reason.message : "计时操作未完成。",
      );
    } finally {
      setPendingCommand(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.pomodoro.getSnapshot(),
      window.pomodoro.getSettings(),
      window.pomodoro.getCapabilities(),
    ])
      .then(([snapshot, settings, capabilities]) => {
        if (active) {
          setData({ snapshot, settings, capabilities });
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "计时核心不可用。请重新启动应用后重试。",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const updateCompactMode = () => {
      setCompact(window.innerWidth <= 300 || window.innerHeight <= 390);
    };
    updateCompactMode();
    window.addEventListener("resize", updateCompactMode);
    return () => {
      window.removeEventListener("resize", updateCompactMode);
    };
  }, []);

  useEffect(() => {
    if (data?.snapshot.status !== "running") {
      return;
    }
    const intervalID = window.setInterval(() => {
      void syncSnapshot().catch(() => {
        setCommandFeedback("无法刷新计时状态。");
      });
    }, 500);
    return () => {
      window.clearInterval(intervalID);
    };
  }, [data?.snapshot.status, syncSnapshot]);

  if (error) {
    return (
      <main className="failureSurface" role="alert">
        <span className="failureMark" aria-hidden="true">
          <TimerReset size={26} />
        </span>
        <h1>未连接到计时核心</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="loadingSurface" aria-live="polite">
        <span className="loadingLine" />
        <p>正在初始化本地计时核心</p>
      </main>
    );
  }

  return (
    <AppShell
      data={data}
      compact={compact}
      pendingCommand={pendingCommand}
      commandFeedback={commandFeedback}
      onCommand={runCommand}
    />
  );
}

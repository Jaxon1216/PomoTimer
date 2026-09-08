import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  BarChart3,
  CirclePause,
  CirclePlay,
  Keyboard,
  RotateCcw,
  Settings2,
  SkipForward,
  TimerReset,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import type {
  Capabilities,
  Settings,
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
}: {
  label: string;
  icon: LucideIcon;
  className?: string;
}): ReactElement {
  return (
    <button
      className={`iconButton ${className}`}
      disabled
      aria-label={label}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" size={className.includes("primary") ? 21 : 17} strokeWidth={1.8} />
    </button>
  );
}

function AppShell({ data }: { data: CoreViewModel }): ReactElement {
  const { snapshot, settings, capabilities } = data;
  const elapsedPercent = useMemo(() => {
    const total = snapshot.round.totalDurationMs;
    return total > 0
      ? Math.max(0, Math.min(1, 1 - snapshot.remainingMs / total))
      : 0;
  }, [snapshot.remainingMs, snapshot.round.totalDurationMs]);
  const circumference = 2 * Math.PI * 105;
  const dashOffset = circumference * (1 - elapsedPercent);

  return (
    <main className="timerSurface">
      <header className="titlebar">
        <div className="windowStatus">
          <span className="statusLight" aria-hidden="true" />
          <span>本地计时</span>
        </div>
        <div className="titlebarActions">
          <IconButton label="统计（Phase 1）" icon={BarChart3} />
          <IconButton label="设置（Phase 1）" icon={Settings2} />
        </div>
      </header>

      <section className="timerStage" aria-labelledby="round-title">
        <div
          className="timerDial"
          aria-label={`${roundLabel(snapshot.round.kind)}，剩余 ${formatDuration(
            snapshot.remainingMs,
          )}，${stateLabel(snapshot)}`}
        >
          <svg viewBox="0 0 240 240" aria-hidden="true">
            <circle className="dialTrack" cx="120" cy="120" r="105" />
            <circle
              className="dialProgress"
              cx="120"
              cy="120"
              r="105"
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
          <span className="metaDivider" aria-hidden="true" />
          <span>{stateLabel(snapshot)}</span>
        </div>

        <div className="timerControls" aria-label="计时控制">
          <IconButton label="重新开始当前轮次（Phase 1）" icon={RotateCcw} />
          <IconButton
            label="开始计时（Phase 1）"
            icon={snapshot.status === "running" ? CirclePause : CirclePlay}
            className="primary"
          />
          <IconButton label="跳到下一轮（Phase 1）" icon={SkipForward} />
        </div>
      </section>

      <footer className="timerFooter">
        <span className="roundCount">
          {snapshot.round.focusRoundNumber ?? settings.focusRoundsPerCycle} /{" "}
          {settings.focusRoundsPerCycle}
        </span>
        <span className="footerDivider" aria-hidden="true" />
        <button
          className="textControl"
          type="button"
          disabled
          title="重置当前轮次（Phase 1）"
        >
          重置
        </button>
        <span className="footerDivider" aria-hidden="true" />
        <span className="monitorStatus">
          <Keyboard aria-hidden="true" size={13} strokeWidth={1.8} />
          {capabilities.inputMonitoring
            ? `输入检测 · ${settings.inputIdleThresholdSeconds} 秒`
            : "输入检测不可用"}
        </span>
        <IconButton label="音量（Phase 1）" icon={Volume2} className="volumeControl" />
      </footer>
    </main>
  );
}

export function App(): ReactElement {
  const [data, setData] = useState<CoreViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return <AppShell data={data} />;
}

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  CirclePause,
  CirclePlay,
  Coffee,
  Keyboard,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  TimerReset,
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

function ActionButton({
  label,
  icon: Icon,
}: {
  label: string;
  icon: LucideIcon;
}): ReactElement {
  return (
    <button className="actionButton" disabled aria-label={label} title={label}>
      <Icon aria-hidden="true" size={19} strokeWidth={1.8} />
    </button>
  );
}

function AppShell({ data }: { data: CoreViewModel }): ReactElement {
  const { snapshot, settings, capabilities } = data;
  const percent = useMemo(() => {
    const total = snapshot.round.totalDurationMs;
    return total > 0 ? Math.max(0, Math.min(1, snapshot.remainingMs / total)) : 0;
  }, [snapshot.remainingMs, snapshot.round.totalDurationMs]);
  const circumference = 2 * Math.PI * 43;
  const dashOffset = circumference * (1 - percent);

  return (
    <main className="timerSurface">
      <header className="topline">
        <span className="brand">
          <span className="brandMark" aria-hidden="true">
            <TimerReset size={15} strokeWidth={2.1} />
          </span>
          番茄时刻
        </span>
        <span className="stageTag">工程地基</span>
      </header>

      <section className="focusArea" aria-labelledby="round-title">
        <p className="eyebrow">第 {snapshot.round.cycleNumber} 个周期</p>
        <h1 id="round-title">{roundLabel(snapshot.round.kind)}</h1>
        <div
          className="timerDial"
          aria-label={`${roundLabel(snapshot.round.kind)}，剩余 ${formatDuration(
            snapshot.remainingMs,
          )}，${stateLabel(snapshot)}`}
        >
          <svg viewBox="0 0 112 112" aria-hidden="true">
            <circle className="dialTrack" cx="56" cy="56" r="43" />
            <circle
              className="dialProgress"
              cx="56"
              cy="56"
              r="43"
              style={{
                strokeDasharray: circumference,
                strokeDashoffset: dashOffset,
              }}
            />
          </svg>
          <div className="dialContent">
            <time>{formatDuration(snapshot.remainingMs)}</time>
            <span>{stateLabel(snapshot)}</span>
          </div>
        </div>
        <div className="actionRow" aria-label="计时控制">
          <ActionButton label="开始计时（Phase 1）" icon={CirclePlay} />
          <ActionButton label="暂停计时（Phase 1）" icon={CirclePause} />
          <ActionButton label="跳到下一轮（Phase 1）" icon={SkipForward} />
          <ActionButton label="重置当前轮次（Phase 1）" icon={RotateCcw} />
        </div>
        <p className="implementationNote">
          计时控制将在状态机完成后启用。
        </p>
      </section>

      <section className="corePanel" aria-label="计时核心状态">
        <div className="coreRow">
          <span className="coreIcon input" aria-hidden="true">
            <Keyboard size={17} />
          </span>
          <div>
            <strong>系统输入</strong>
            <span>
              {capabilities.inputMonitoring
                ? `阈值 ${settings.inputIdleThresholdSeconds} 秒`
                : "不可用"}
            </span>
          </div>
          <span className="statusDot ready">已连接</span>
        </div>
        <div className="coreRow">
          <span className="coreIcon break" aria-hidden="true">
            <Coffee size={17} />
          </span>
          <div>
            <strong>默认节奏</strong>
            <span>
              {settings.focusDurationSeconds / 60} /{" "}
              {settings.shortBreakDurationSeconds / 60} /{" "}
              {settings.longBreakDurationSeconds / 60} 分钟
            </span>
          </div>
          <span className="cycleValue">
            {settings.focusRoundsPerCycle} 轮
          </span>
        </div>
      </section>

      <footer className="privacyLine">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>本地 Core 已就绪，尚未启用摄像头或输入内容采集。</span>
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

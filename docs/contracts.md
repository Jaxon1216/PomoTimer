# Electron IPC 与本地持久化契约

## 1. IPC allowlist

Renderer 只可通过 `window.pomodoro` 调用以下方法：

```ts
getSnapshot(): Promise<TimerSnapshot>
command(command: "start" | "pause" | "resume" | "next" | "reset"): Promise<TimerSnapshot>
getSettings(): Promise<Settings>
updateSettings(patch: Partial<Omit<Settings, "version">>): Promise<Settings>
getCapabilities(): Promise<Capabilities>
getStatistics(): Promise<StatisticsSnapshot>
subscribe(listener: (event: CoreEvent) => void): () => void
```

每个参数和返回值都经过共享 Zod schema。Main 仅接受主窗口 sender；Preload 不暴露通用 IPC。

## 2. TimerSnapshot

```ts
type TimerStatus = "idle" | "running" | "auto-paused" | "manual-paused";
type RoundKind = "focus" | "short-break" | "long-break";
type BreakMode = "active" | "desk";
type PauseReason = "none" | "input-away" | "break-condition" | "system-suspend" | "core-recovery" | "source-unavailable";

interface TimerSnapshot {
  revision: number; emittedAt: string; status: TimerStatus; remainingMs: number;
  round: { kind: RoundKind; cycleNumber: number; positionInCycle: number; focusRoundNumber: number | null; breakMode: BreakMode | null; totalDurationMs: number };
  automation: { activePresenceSource: "input"; inputPresence: "present" | "away" | "unknown"; cameraPresence: "unknown"; inputMonitoringAvailable: boolean; cameraMonitoringAvailable: false; manualPauseLocked: boolean; pauseReason: PauseReason };
}
```

默认设置为 `30/5/30/5/30/10`。专注在场输入时运行，活动休息在离席时运行，桌前休息在无输入时运行。自动暂停冻结 `remainingMs`；手动暂停会设置锁。

## 3. 设置生效

设置范围与产品规格一致：专注 300–7200 秒、短休 60–3600 秒、长休 60–5400 秒、周期 1–8 轮、输入阈值 10–600 秒。主题和常驻顶部立即生效；时长在下一轮同类型轮次生效，周期轮数在下一周期生效，休息模式在下一轮休息生效，输入阈值在下一采样生效。

## 4. 事件

```ts
type CoreEvent =
  | { type: "timer.snapshot"; snapshot: TimerSnapshot }
  | { type: "stats.changed"; statistics: StatisticsSnapshot }
  | { type: "core.error"; code: string; message: string; recoverable: boolean };
```

Main 每 500ms 广播权威快照；命令、输入采样、轮次变化、电源事件和设置保存走同一广播链。事件中不包含原始输入、窗口、屏幕或相机数据。

## 5. SQLite 数据模型

保留并兼容既有表：`schema_migrations`、`settings`、单行 `timer_snapshot`、`completed_focus_sessions`。只有完整结束的 focus 写入 `completed_focus_sessions`；next、reset、退出、睡眠、自动/手动暂停都不写入。`INSERT OR IGNORE` 以 UUID 防止完成事件重复。统计按 `local_date` 聚合今日、本周和最近 52 周数据。

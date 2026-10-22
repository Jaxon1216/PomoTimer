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
getWindowMode(): Promise<WindowMode>
setWindowMode(mode: WindowMode): Promise<WindowMode>
subscribe(listener: (event: CoreEvent) => void): () => void
```

每个参数和返回值都经过共享 Zod schema。Main 仅接受主窗口 sender；Preload 不暴露通用 IPC。

`WindowMode = "regular" | "mini"`，只接受这两个枚举值。窗口模式由 Main 持有；`setWindowMode` 应用该模式对应的内容最小尺寸和已记忆的 bounds，返回最终模式并广播 `window.modeChanged`。初始常规内容区域为 360×478、最小 320×300；迷你首次进入与最小内容区域为 220×240。切回常规恢复之前的常规 bounds，各模式 bounds 仅存在于 Main 内存中。Renderer 不接触原生窗口坐标，也不通过 resize 自动请求迷你模式；这些操作不调用 TimerEngine、不改变快照且不写数据库。

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

默认设置为 `30/5/30/5/30/10`。专注在场输入时运行，活动休息在离席时运行，桌前休息在无输入时运行。自动暂停冻结 `remainingMs`；手动暂停会设置锁。休息轮在空闲确认阈值前最多 10 秒由 TimerEngine 以内存候选预记倒计时，达到阈值并进入 `running` 时才扣除已观测的候选时长；确认前快照不变更剩余时间，首次样本超过阈值不补历史。候选不进入 IPC 或 SQLite，输入回归、手动操作、检测失败、睡眠、重启、切轮或阈值改变时取消，最多抵扣当前休息剩余时长。

## 3. 设置生效

设置范围与产品规格一致：专注 300–7200 秒、短休 60–3600 秒、长休 60–5400 秒、周期 1–8 轮、输入阈值 10–600 秒。主题和常驻顶部立即生效；时长在下一轮同类型轮次生效，周期轮数在下一周期生效，休息模式在下一轮休息生效，输入阈值在下一采样生效。

## 4. 事件

```ts
type CoreEvent =
  | { type: "timer.snapshot"; snapshot: TimerSnapshot }
  | { type: "stats.changed"; statistics: StatisticsSnapshot }
  | { type: "window.modeChanged"; mode: WindowMode }
  | { type: "core.error"; code: string; message: string; recoverable: boolean };
```

Main 每 500ms 广播权威快照；命令、输入采样、轮次变化、电源事件和设置保存走同一广播链。窗口模式事件只携带本应用的模式枚举，不携带 bounds、其他应用窗口、原始输入、屏幕或相机数据。Renderer 在初次并行读取时通过 `getWindowMode` 获得模式，再从模式切换返回值和模式事件更新展示；计时状态仍只来自 TimerSnapshot。

## 5. SQLite 数据模型

保留并兼容既有表：`schema_migrations`、`settings`、单行 `timer_snapshot`、`completed_focus_sessions`。只有完整结束的 focus 写入 `completed_focus_sessions`；next、reset、退出、睡眠、自动/手动暂停都不写入。`INSERT OR IGNORE` 以 UUID 防止完成事件重复。统计按 `local_date` 聚合今日、本周和最近 52 周数据。

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
getCameraState(): Promise<CameraState>
reportCameraPresence(presence: Presence, generation: number): Promise<TimerSnapshot>
subscribe(listener: (event: CoreEvent) => void): () => void
```

每个参数和返回值都经过共享 Zod schema。Main 仅接受可信主窗口的主 frame sender；Preload 不暴露通用 IPC。摄像头报告的 wire payload 为严格的 `{ presence, generation }`，拒绝额外字段；不接收画面、检测框、时间戳或设备信息。

```ts
type Presence = "present" | "away" | "unknown";
interface CameraState { enabled: boolean; generation: number }
interface Capabilities { inputMonitoring: boolean; cameraPresence: boolean; standingFocus: false }
```

`CameraState` 是 Main 决定的本次检测生命周期。切换模式、睡眠/锁屏、恢复或释放检测时更换代次；Main 拒绝停用或旧代次的报告。首次有效报告前有 25 秒启动窗口，之后连续 5 秒没有有效报告则停止监控并回退触控。`unknown` 表示故障，不作为离席使用。

窗口拖动和尺寸约束由原生窗口处理，Renderer 根据视口尺寸排版。这些操作独立于计时命令、事件和持久化。

## 2. TimerSnapshot

```ts
type TimerStatus = "idle" | "running" | "auto-paused" | "manual-paused";
type RoundKind = "focus" | "short-break" | "long-break";
type BreakMode = "active" | "desk";
type PauseReason = "none" | "input-away" | "camera-away" | "break-condition" | "system-suspend" | "system-lock" | "core-recovery" | "source-unavailable" | "storage-unavailable";

interface TimerSnapshot {
  revision: number; emittedAt: string; status: TimerStatus; remainingMs: number;
  round: { kind: RoundKind; cycleNumber: number; positionInCycle: number; focusRoundNumber: number | null; breakMode: BreakMode | null; totalDurationMs: number };
  automation: { activePresenceSource: "input" | "camera"; inputPresence: Presence; cameraPresence: Presence; inputMonitoringAvailable: boolean; cameraMonitoringAvailable: boolean; manualPauseLocked: boolean; pauseReason: PauseReason; breakPreparation?: { remainingSeconds: number; countdown: boolean } | null };
}
```

默认设置为 `30/5/30/5/30/10`。专注和活动休息使用 `focusPresenceSource` 选中的来源；桌前休息始终使用系统输入。`activePresenceSource` 表示当前轮次实际采用的来源。触控专注的首次与下一轮由用户开始，监控专注的有效 `present` 可自动开始 `idle` 或恢复自动暂停。专注中手动暂停设置锁；休息中点击暂停不建立永久锁，后续有效休息条件仍可自动开始或恢复。

`automation.breakPreparation` 是 Main 从当前有效输入样本推导的休息准备状态。`remainingSeconds` 是大于零的整数，`countdown` 在剩余不超过 10 秒时为 `true`；仅在采用输入源的休息轮等待自动开始/恢复时提供。初始、样本故障、锁屏/睡眠或采用摄像头时为 `null`。字段可省略以兼容旧快照，当前 Engine 输出显式对象或 `null`。Renderer 在默认准备期前 30 秒显示“无输入 40 秒开始休息”，最后 10 秒显示 `10…1`；中途输入会重置准备。达到阈值才开始正式休息，准备期不扣减 `remainingMs`，也不回填已过去的休息时间。该字段只进入实时 IPC，不进入 SQLite。

## 3. 设置生效

设置范围与产品规格一致：专注 300–7200 秒、短休 60–3600 秒、长休 60–5400 秒、周期 1–8 轮、输入阈值 10–600 秒。主题和常驻顶部立即生效；时长在下一轮同类型轮次生效，周期轮数在下一周期生效，休息模式在下一轮休息生效，输入阈值在下一采样生效。

`focusPresenceSource: "input" | "camera"` 默认 `input`，它同时选择专注和活动休息的感知源。改变来源立即清除旧摄像头在场状态；当前轮次实际来源变化时，取消临时手动回退、清空准备状态并安全暂停活动轮次，等待新源样本。不重置计时，不解除专注的手动暂停锁；桌前休息的输入规则不因该设置变化而改变。监控专注只在有效 `present` 时开始/继续，监控活动休息只在有效 `away` 时开始/继续。摄像头故障由 Main 保存回退后的 `input` 设置，并通过 `settings.changed` 通知 Renderer；用户重新选择监控才重试。

## 4. 事件

```ts
type CoreEvent =
  | { type: "timer.snapshot"; snapshot: TimerSnapshot }
  | { type: "stats.changed"; statistics: StatisticsSnapshot }
  | { type: "settings.changed"; settings: Settings }
  | { type: "camera.state"; state: CameraState }
  | { type: "core.error"; code: string; message: string; recoverable: boolean };
```

Main 每 500ms 广播权威快照。命令、输入/摄像头采样、轮次变化、电源事件和设置保存走同一广播链，Renderer 从 `TimerSnapshot` 更新计时显示。Renderer 读取初始 `CameraState` 并监听 `camera.state`，按代次启动或释放唯一摄像头检测器；初始化完成后约每 500ms 上报三态心跳。切换到设置或统计不另开检测器。

`stats.changed` 在完成记录事务提交后或本机日期变化时发布，不为跳过轮次增加统计。`core.error` 中 `STORAGE_UNAVAILABLE/recoverable=false` 表示计时已在内存中冻结、后台写入已停止，需要重新打开应用；`COMMAND_REJECTED/recoverable=true` 等普通操作错误只显示可恢复提示，不移除正常计时视图。

输入检测故障下显式手动继续、锁屏门禁、完成通知计数仅存在于 TimerEngine 内存。有效输入检测恢复后取消临时手动回退；锁屏解除本身不启动计时。若变化仅涉及在场状态或检测可用性，实时快照更新 revision，SQLite 不写入。相同的静止样本保持 revision，运行中的轮次仍按秒保存进度。

## 5. SQLite 数据模型

保留并兼容既有表：`schema_migrations`、`settings`、单行 `timer_snapshot`、`completed_focus_sessions`。只有完整结束的 focus 写入 `completed_focus_sessions`。完成记录使用由周期和专注轮次生成的稳定 ID，`INSERT OR IGNORE` 防止重试重复计数。统计按 `local_date` 聚合今日、本周和最近 52 周数据。

`TimerSnapshot` 是运行时 IPC 契约。闲置秒数只在 Main 内存中使用，Renderer 通过实时快照读取推断出的在场状态。摄像头帧只在 Renderer 瞬时处理，三态和代次只在内存中使用。SQLite 的计时检查点只保存恢复轮次所需的数据，普通检查点与完成专注的事务使用同一写入格式，不保存 `automation`、presence、休息准备倒数、摄像头代次或检测历史。设置中可保存选中的专注源，沿用版本 1 设置格式，不改动已发布的数据库迁移。重启后，两种在场状态均为 `unknown`，休息准备状态为 `null`，直到收到有效样本。旧检查点中的 `manual-paused` 休息轮转为自动等待，剩余时间保持不变；专注的手动暂停锁继续保留。升级时，可读取的旧检查点转换为新格式，设置和完成记录继续保留。既有备份和故障恢复归档按原样保存，可能包含旧版本写入的字段。

Store 每次打开数据库都会尝试将 WAL 合入主文件并截断。若外部读取连接仍占用旧页，逻辑检查点已完成转换，旧页清理会在下次打开时重试。此时复制的原始文件也可能包含旧版本的数据。

初始化、迁移或快照读取失败先复制数据库及现存 WAL/SHM 文件并关闭连接。恢复入口只在 Main 的原生对话框中提供，备份成功且用户显式选择后才归档原文件并重建；不增加 Renderer 数据库或路径能力，不修改已发布迁移。

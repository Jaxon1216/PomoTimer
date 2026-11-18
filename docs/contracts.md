# Electron IPC 与本地持久化契约

## 1. IPC allowlist

主窗口 Renderer 只可通过 `window.pomodoro` 调用以下方法：

```ts
getSnapshot(): Promise<TimerSnapshot>
command(command: "start" | "pause" | "resume" | "next" | "reset" | "start-standing-break" | "exit-standing-break"): Promise<TimerSnapshot>
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

大站期间 `CameraState.enabled=false`，Main 临时释放会话并保留监控偏好。切回普通休息或进入下一轮后，按当前偏好重新启用监控时签发新代次，并等待新结果。`Capabilities.standingFocus` 保持 `false`。

窗口拖动和尺寸约束由原生窗口处理，Renderer 根据视口尺寸排版。这些操作独立于计时命令、事件和持久化。

窗口重建只恢复已知页面 fragment：`timer`、`settings`、`stats`，不新增 preload 方法或通用窗口控制 channel。恢复后的主窗口仍须通过相同来源、主 frame 和 Zod 校验。

### 完成提醒窗口

独立提醒窗口通过专用 preload 暴露自身的 `window.pomodoro`，只包含下列方法，不包含主窗口的任一命令、设置或摄像头接口：

```ts
interface CompletionReminder {
  id: number; // 当前进程内从 1 开始的成功自然完成版本
  completedKind: RoundKind;
  nextKind: RoundKind;
  completedAt: string; // 带时区的 ISO 完成时间
  theme: "light" | "dark";
}
getReminder(): Promise<CompletionReminder | null>
dismissReminder(id: number): Promise<boolean>
subscribeReminder(listener: (reminder: CompletionReminder | null) => void): () => void
```

Wire channels 为 `pomodoro:get-reminder`、`pomodoro:dismiss-reminder`（严格 `{ id: 正整数 }`）和 Main 推送的 `pomodoro:reminder`。只有当前提醒窗口的主 frame 可调用前两者；其他窗口和子 frame 均拒绝。读取结果和推送 payload 使用相同严格 Zod schema，未知字段拒绝。确认只在 ID 与当前提醒相同时清除并返回 `true`，旧卡片的迟到确认返回 `false`，不能关闭更新后的提醒；无当前条目时读取和推送均为 `null`。

提醒 ID、完成类型和完成时间来自 TimerEngine 成功落盘后的 `completedRound`；读取它不推进时钟。提醒只保存在 Main 内存，不加入 `TimerSnapshot` 或 SQLite。卡片确认不调用 TimerEngine；关闭窗口隐藏复用，重启不恢复历史卡片。`REMINDER_UNAVAILABLE/recoverable=true` 表示卡片界面不可用，计时与已完成记录仍有效。

## 2. TimerSnapshot

```ts
type TimerStatus = "idle" | "running" | "auto-paused" | "manual-paused";
type RoundKind = "focus" | "short-break" | "long-break";
type BreakMode = "active" | "desk";
type RoundBreakMode = BreakMode | "standing";
type PauseReason = "none" | "input-away" | "camera-away" | "break-condition" | "standing-confirmation" | "system-suspend" | "system-lock" | "core-recovery" | "source-unavailable" | "storage-unavailable";

interface TimerSnapshot {
  revision: number; emittedAt: string; status: TimerStatus; remainingMs: number;
  activeCycleRounds?: number;
  round: { kind: RoundKind; cycleNumber: number; positionInCycle: number; focusRoundNumber: number | null; breakMode: RoundBreakMode | null; totalDurationMs: number };
  automation: { activePresenceSource: "input" | "camera" | "none"; inputPresence: Presence; cameraPresence: Presence; inputMonitoringAvailable: boolean; cameraMonitoringAvailable: boolean; manualPauseLocked: boolean; pauseReason: PauseReason; breakPreparation?: { remainingSeconds: number; countdown: boolean } | null };
}
```

默认设置为 `30/5/30/5/30/10`。专注和活动休息使用 `focusPresenceSource` 选中的来源；桌前休息始终使用系统输入。`activePresenceSource` 表示当前轮次实际采用的来源，大站为 `none`。触控专注的首次与下一轮由用户开始，监控专注的有效 `present` 可自动开始 `idle` 或恢复自动暂停。专注中手动暂停设置锁；普通休息中点击暂停不建立永久锁，后续有效休息条件仍可自动开始或恢复。

`start-standing-break` 接受尚未结束的普通短休或长休，将本轮总时长和剩余时间翻倍并立即开始。`exit-standing-break` 接受尚未结束的大站短休或长休，将本轮总时长和剩余时间减半，剩余毫秒向上取整，并恢复进入大站时的普通休息方式。切回进入 `auto-paused`，等待来自当前感知源的有效自动条件。两个命令只作用于当前休息轮，在锁屏及存储故障期间拒绝执行。若处理命令时发现该轮已自然完成，命令拒绝，完成仍按通常流程处理。

大站的 `pause` 产生 `auto-paused`、`manualPauseLocked=false`、`pauseReason="standing-confirmation"`；该状态不表示允许感知自动恢复。输入、摄像头及其故障不启动、暂停或继续大站，`breakPreparation` 为 `null`。睡眠、锁屏和重启冻结进度且不补计离线时间，待用户显式继续；锁屏期间拒绝开始或继续。大站的 `reset` 保留当前方式及最初分配的时长，`next` 和自然结束按原周期进入后续轮次，沿用原感知与默认休息偏好。

`automation.breakPreparation` 是 Main 从当前有效输入样本推导的休息准备状态。`remainingSeconds` 是大于零的整数，`countdown` 在剩余不超过 10 秒时为 `true`；仅在采用输入源的休息轮等待自动开始/恢复时提供。初始、样本故障、锁屏/睡眠或采用摄像头时为 `null`。字段可省略以兼容旧快照，当前 Engine 输出显式对象或 `null`。Renderer 在默认准备期前 30 秒显示“无输入 40 秒开始休息”，最后 10 秒显示 `10…1`；中途输入会重置准备。达到阈值才开始正式休息，准备期不扣减 `remainingMs`，也不回填已过去的休息时间。该字段只进入实时 IPC，不进入 SQLite。

## 3. 设置生效

设置范围与产品规格一致：专注 60–7200 秒、短休 60–3600 秒、长休 60–5400 秒、周期 1–8 轮、输入阈值 10–600 秒。主题和常驻顶部立即生效；时长在下一轮同类型轮次生效，周期轮数在下一周期生效，休息模式在下一轮休息生效，输入阈值在下一采样生效。

`notificationsEnabled` 继续沿用已有布尔设置与默认值 `true`，界面称“完成弹窗与暂停通知”。它控制无声完成卡片及剩余的系统暂停通知；保存为 `false` 清除当前提醒，重新开启不补发先前已消费的完成版本，不增加迁移或新设置字段。

`defaultBreakMode` 接受 `"active" | "desk"`。大站时长按本轮已分配的普通休息时长折算，设置变更从下一轮对应休息生效。

窗口设置包含三个独立布尔字段：

```ts
interface WindowSettings {
  alwaysOnTop: boolean;
  followWorkspaces: boolean;
  autoFade: boolean;
}
```

这些字段属于完整 `Settings`，不是新增 IPC 对象。新安装均为 `true`；`followWorkspaces` 仅在 macOS 生效。常驻顶部保持普通悬浮层级，自动淡化立即用于计时器页；macOS 跟随变化在保存回复后异步重建窗口，恢复位置、尺寸和页面，不新建 TimerEngine 或 Store。计划内重建使摄像头旧代次失效并暂时 `unknown`，保留选中的感知模式；新窗口重新初始化并等待有效样本。

`Settings` 和 `SettingsPatch` 严格校验。patch 只修改传入的字段。Store 读取旧设置时为缺少的 `followWorkspaces`、`autoFade` 补 `true`，并在校验旧 `standingShortBreakDurationSeconds`、`standingLongBreakDurationSeconds` 后剥离它们。窗口开关的显式 `false` 会保留。非法旧值仍进入数据恢复路径。

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

Main 每 500ms 广播权威快照。命令、输入/摄像头采样、轮次变化、电源事件和设置保存走同一 `publishSnapshot` 广播链，先同步当前轮次需要的摄像头会话，再发布最新快照；同步不递归广播。Renderer 从 `TimerSnapshot` 更新计时显示，读取初始 `CameraState` 并监听 `camera.state`，按代次启动或释放唯一摄像头检测器；初始化完成后约每 500ms 上报三态心跳。切换到设置或统计不另开检测器。

`stats.changed` 在完成记录事务提交后或本机日期变化时发布，不为跳过轮次增加统计。`core.error` 中 `STORAGE_UNAVAILABLE/recoverable=false` 表示计时已在内存中冻结、后台写入已停止，需要重新打开应用；`COMMAND_REJECTED/recoverable=true` 等普通操作错误只显示可恢复提示，不移除正常计时视图。

输入检测故障下显式手动继续、锁屏门禁、完成通知计数仅存在于 TimerEngine 内存。有效输入检测恢复后取消临时手动回退；锁屏解除本身不启动计时。若变化仅涉及在场状态或检测可用性，实时快照更新 revision，SQLite 不写入。相同的静止样本保持 revision，运行中的轮次仍按秒保存进度。

## 5. SQLite 数据模型

保留并兼容既有表：`schema_migrations`、`settings`、单行 `timer_snapshot`、`completed_focus_sessions`。只有完整结束的 focus 写入 `completed_focus_sessions`。完成记录使用由周期和专注轮次生成的稳定 ID，`INSERT OR IGNORE` 防止重试重复计数。统计按 `local_date` 聚合今日、本周和最近 52 周数据。

`TimerSnapshot` 是运行时 IPC 契约。闲置秒数只在 Main 内存中使用，Renderer 通过实时快照读取推断出的在场状态。摄像头帧只在 Renderer 瞬时处理，三态和代次只在内存中使用。SQLite 检查点保存 `revision`、`emittedAt`、`round`、`activeCycleRounds`、`status`、`remainingMs` 和可选的系统挂起 `interruption`。大站另外保存原普通休息方式 `ordinaryBreakMode`，该字段只在私有检查点中使用。普通检查点与完成专注的事务使用同一写入格式。`automation`、presence、休息准备倒数、摄像头代次和检测历史只在内存中使用。

检查点继续使用版本 4，保留已发布的迁移与校验和。Store 读入旧 `round.hasStarted` 时验证并剥离该字段。旧大站缺少 `ordinaryBreakMode` 时，首次恢复采用保存的默认休息方式，并保留已分配时长和剩余时间。运行中的大站重启后恢复为 `auto-paused`，等待显式继续或切换。普通休息的旧 `manual-paused` 转为自动等待，专注保留手动暂停锁。两种在场状态重启后均从 `unknown` 开始，准备状态从 `null` 开始，等待新样本。

`alwaysOnTop`、`followWorkspaces`、`autoFade` 随版本 1 的设置 JSON 保存；兼容补值发生在 Store 读取边界，不改写已发布的迁移或校验和。淡化计时器、指针状态、键盘焦点与当前页面不写入 SQLite。

Store 每次打开数据库都会尝试将 WAL 合入主文件并截断。若外部读取连接仍占用旧页，逻辑检查点已完成转换，旧页清理会在下次打开时重试。此时复制的原始文件也可能包含旧版本的数据。

初始化、迁移或快照读取失败先复制数据库及现存 WAL/SHM 文件并关闭连接。恢复入口只在 Main 的原生对话框中提供，备份成功且用户显式选择后才归档原文件并重建；不增加 Renderer 数据库或路径能力，不修改已发布迁移。

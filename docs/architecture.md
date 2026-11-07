# 技术架构

## 1. 运行结构

应用采用单进程 Electron 主进程 + 受限 preload + React renderer。计时核心是与 Electron API 解耦的 TypeScript `TimerEngine`，由 Main 持有唯一实例；SQLite 由 Main 的 `SqliteStore` 独占访问。

```text
React renderer
  | typed window.pomodoro API
preload
  | validated, allowlisted IPC
Electron main
  | TimerEngine + SqliteStore
  | BrowserWindow / Tray / Notification / powerMonitor
SQLite in app.getPath("userData")
```

不使用 Go、Rust、侧车、JSON-RPC、HTTP、WebSocket 或 Node 子进程。计时、托盘、通知、系统输入采样和持久化由一个权威状态直接驱动，不依赖 Renderer 轮询。监控专注需要 Renderer 提供有效摄像头信号；Renderer 丢失时由 Main 安全暂停并回退触控。

Main 在就绪及打开数据库之前取得单实例锁；同一 userData 的第二次启动只唤起已有窗口。独立临时数据目录的测试仍可并行拥有各自实例。

## 2. 进程边界

React 渲染快照、导航设置和统计视图，并维护临时表单。Preload 只暴露 `getSnapshot`、`command`、`getSettings`、`updateSettings`、`getCapabilities`、`getStatistics`、`getCameraState`、`reportCameraPresence`、`subscribe`。Main 验证调用来源和 payload，广播经 Zod 校验的状态事件。

`TimerEngine` 使用单调时钟计算剩余时间，在内存中维护输入和摄像头三态并向 Renderer 提供实时快照。专注使用用户选中的来源，两种休息始终使用系统输入。Store 单独保存恢复计时所需的检查点、设置和已完成专注记录。重新打开应用时，Main 恢复轮次与手动暂停锁，在收到新样本之前将两种在场状态设为 `unknown`。

摄像头模块在 Renderer 内调用 `getUserMedia` 和本地 MediaPipe/BlazeFace，以 CPU 约 2 FPS 检测，在本地完成置信度、脸框高度和连续 3 秒无脸的判断。原始帧只作瞬时输入，不进入 IPC、SQLite、日志或网络。Renderer 只向 Main 提交三态和检测代次，不能直接开始/暂停权威计时。

模型源文件位于 `apps/desktop/resources/camera/mediapipe/blaze_face_short_range.tflite`。开发/构建前脚本从精确锁定的 npm 包复制 WASM 与运行脚本，并复制 Apache 许可证；生成文件不提交 Git。构建产物包含全部检测资源，运行时不下载模型或代码。

Main 持有摄像头启停状态和递增代次，通过 `camera.state` 发布。Renderer 初始读取 `getCameraState`，每次代次变化先清理旧流与检测器，再启动新检测；异步权限/模型初始化迟到也必须关闭资源。Main 为首次有效样本设置 25 秒启动期限，随后按单调时钟检查 5 秒心跳期限。过期、报告 `unknown`、窗口销毁或 Renderer 崩溃时清空摄像头状态，保存触控回退设置并广播 `settings.changed` 和可恢复错误；旧代次样本被拒绝。窗口重新加载先停用旧代次，加载完成后重新获取监控状态和新样本。

Main 管理一个可缩放的 BrowserWindow，并根据内容区域约束原生窗口尺寸。Renderer 随视口宽高调整布局，通过 Electron 拖动区域移动窗口，按钮、菜单和表单保留普通指针交互。拖动和缩放由原生窗口处理。

## 3. 平台集成

- `powerMonitor.getSystemIdleTime()` 每秒采样。仅传递闲置秒数，不传递输入内容。TimerEngine 使用单调时钟为当前休息轮保留阈值前最多 10 秒的倒计时候选，达到阈值后才确认扣时；候选只在内存中，输入回归、手动操作、检测失败、睡眠、重启、切轮或阈值变化会清除，不补计跨轮或离线时间。
- `powerMonitor` 的 suspend/resume 事件让运行轮次进入 `auto-paused`，恢复后由用户或安全自动条件继续。
- `lock-screen/unlock-screen` 直接驱动 TimerEngine 锁屏门禁；锁屏期间输入不得恢复计时，解锁后等待下一有效样本。检测持续失败时，用户显式继续启用临时手动回退，下一有效样本、锁屏、睡眠或重启取消回退。
- 摄像头只在用户已选择监控时启用；Main 将媒体权限限制为可信主窗口的主 frame、视频权限，拒绝麦克风和外部 frame。macOS 打包声明摄像头用途。CSP 仅为本地 MediaPipe 增加 WebAssembly 执行许可，不引入远程脚本或模型。
- 选中的监控在隐藏、最小化和页面导航时继续检测，窗口禁用后台节流；系统睡眠/锁屏时释放摄像头，恢复/解锁后签发新代次并等待新结果。切回触控、退出或检测失败都会释放资源。故障回退持久化为触控，避免反复请求权限。
- Tray 菜单、窗口、通知都调用同一 TimerEngine，不复制状态。
- Tray 只在展示秒数、可用操作或状态改变时重建菜单；完成通知依赖成功持久化后的完成计数，跳过轮次不发“轮次完成”。
- 关闭窗口在 Windows 上隐藏到托盘，退出菜单设置退出标记后真正退出；macOS 遵循应用生命周期。
- `contextIsolation`、sandbox、CSP、禁止导航和外部链接 allowlist 必须保持。
- macOS 使用 `hiddenInset`，为左上角交通灯预留空间。Windows 使用 Electron 的 `hidden` 和 32 px 标题栏覆盖层，保留系统窗口按钮，停止使用会被 Alt 唤出的默认应用菜单。覆盖层单独占一行，Main 在约束内容尺寸时扣除该行；Renderer 按下方计时器的可用宽高排版。计时器留白在两个平台都由系统处理拖动，按钮仍可点击。
- 初始内容区域为 360×478 px，最小为 160×180 px。Main 换算原生边框后，将内容高度限制在宽度的 1.5 倍以内，同时允许宽矮窗口。
- 托盘资源与应用图标分离：macOS 从 `trayTemplate.png` 和 `trayTemplate@2x.png` 创建透明黑色 template `NativeImage` 并设置 tooltip；Windows 只加载 `.ico`，Dock 继续使用 `.icns`。
- 原生验收使用独立临时 `userData`，由 Main 的真实 PID、`app.getPath("userData")` 和当前 Tray 的 `getBounds()` 确认实例。只有显式设置 `POMODORO_DIAGNOSTICS=1` 时，Node inspector 才可通过 Main 内部的只读 symbol 查询窗口、Tray 及其实际图像倍率；该能力不进入 preload 或 IPC。其他常驻应用无需退出。

## 4. SQLite

数据库文件为 `pomodoro.sqlite`。版本 4 迁移保留原有四张表和版本 1–3 的校验和，事务内将可读取的旧快照改写成计时检查点。检查点记录轮次、剩余时间、计时状态等恢复信息，系统挂起可以保留原因，输入监测的字段留在实时快照中。专注完成时，Store 在同一事务内写入完成记录和下一轮检查点，按稳定的轮次 ID 防止重启后重复计数。

`better-sqlite3` 12.x 是当前 Electron 33 / Node 20 构建目标的实现选择。打包前由 electron-builder 重建原生模块；升级 Electron 或数据库驱动时必须重新验证构建。

静止状态对相同业务快照去重，运行中保留每秒检查点。初始化失败由 Store 复制数据库及现存 WAL/SHM 到时间戳备份目录并关闭连接；Main 默认退出，仅在用户明确选择后归档原文件并重建。运行时存储异常由 Main 统一捕获，调用 TimerEngine 的无写入故障冻结接口，停止后台轮询并广播不可恢复 `core.error`；退出不再尝试写入失败的连接。

完成事务提交后，Store 的进程内完成修订号驱动 Main 发布 `stats.changed`。日期变化也触发统计刷新；所有统计日期由同一墙钟采样以本地日历推算，计时仍只用单调时钟。

## 5. 测试边界

`TimerEngine` 用注入的单调时钟、墙钟和 Store 独立测试。Renderer 测试验证计时控制、导航、休息等待文案和故障提示。布局检查覆盖最小窗口、窄窗的高度上限和宽矮窗口。Electron E2E 验证真实 preload/IPC、原生窗口尺寸、导航和计时事件同步。macOS/Windows 的 idle、通知、托盘和睡眠恢复仍需真实设备手工验证。

`npm run test:store` 使用与 Electron 相同 ABI 的运行时验证真实 SQLite 的旧库兼容、校验和、事务回滚、去重及包含 WAL 的恢复副本。普通 PR CI 与发布 CI 均运行原生数据库测试和 Electron E2E；模拟电源事件只验证事件接线，不能替代真实锁屏和睡眠验收。

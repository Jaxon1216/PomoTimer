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

不使用 Go、Rust、侧车、JSON-RPC、HTTP、WebSocket 或 Node 子进程。计时、托盘、通知、系统输入采样和持久化由一个权威状态直接驱动，不依赖 Renderer 轮询。监控专注和活动休息需要 Renderer 提供有效摄像头信号；Renderer 丢失时由 Main 安全暂停并回退触控。

Main 在就绪及打开数据库之前取得单实例锁；同一 userData 的第二次启动只唤起已有窗口。独立临时数据目录的测试仍可并行拥有各自实例。

## 2. 进程边界

React 渲染快照、导航设置和统计视图，并维护临时表单。主窗口 Preload 只暴露 `getSnapshot`、`command`、`getSettings`、`updateSettings`、`getCapabilities`、`getStatistics`、`getCameraState`、`reportCameraPresence`、`subscribe`。Main 验证调用来源和 payload，广播经 Zod 校验的状态事件。

`TimerEngine` 使用单调时钟计算剩余时间，在内存中维护输入和摄像头三态并向 Renderer 提供实时快照。专注和活动休息使用用户选中的来源，桌前休息始终使用系统输入。Store 单独保存恢复计时所需的检查点、设置和已完成专注记录。重新打开应用时，Main 恢复轮次与专注的手动暂停锁；旧的手动暂停休息转为自动等待。在收到新样本之前，两种在场状态为 `unknown`，休息准备状态为 `null`。

摄像头模块在 Renderer 内调用 `getUserMedia` 和本地 MediaPipe/BlazeFace，以 CPU 约 2 FPS 检测，在本地完成置信度、脸框高度和连续 3 秒无脸的判断。原始帧只作瞬时输入，不进入 IPC、SQLite、日志或网络。Renderer 只向 Main 提交三态和检测代次，不能直接开始/暂停权威计时。

模型源文件位于 `apps/desktop/resources/camera/mediapipe/blaze_face_short_range.tflite`。开发/构建前脚本从精确锁定的 npm 包复制 WASM 与运行脚本，并复制 Apache 许可证；生成文件不提交 Git。构建产物包含全部检测资源，运行时不下载模型或代码。

macOS 打包在生成 DMG 前通过自定义 signer 对应用、辅助进程、框架、原生 SQLite 模块与资源做 ad hoc 完整性签名，保留 hardened runtime。主应用和辅助应用仅授予 V8 JIT、ad hoc 库加载和摄像头 entitlement，库不获得设备授权；主应用另声明摄像头用途，麦克风仍被运行时权限门禁拒绝。ad hoc 不提供 Developer ID 身份或 Apple 公证，首次打开需要用户按系统提示批准。

Main 持有摄像头启停状态和递增代次，通过 `camera.state` 发布。Renderer 初始读取 `getCameraState`，每次代次变化先清理旧流与检测器，再启动新检测；异步权限/模型初始化迟到也必须关闭资源。Main 为首次有效样本设置 25 秒启动期限，随后按单调时钟检查 5 秒心跳期限。过期、报告 `unknown`、非计划的主窗口销毁或 Renderer 崩溃时清空摄像头状态，保存触控回退设置并广播 `settings.changed` 和可恢复错误；旧代次样本被拒绝。窗口重新加载先停用旧代次，加载完成后重新获取监控状态和新样本。切换桌面跟随引起的计划内窗口重建保留选中的监控模式，只停止旧代次、将摄像头在场置为 `unknown`，等待新主窗口重新检测；旧窗口的关闭不触发故障回退。

Main 管理一个对外的可缩放主窗口，并根据内容区域约束原生窗口尺寸。切换 macOS 窗口类型时可短暂保留旧窗口，待新窗口就绪后销毁；只有当前主窗口的可信主 frame 可调用主窗口 IPC。Renderer 随视口宽高调整布局，通过 Electron 拖动区域移动窗口，按钮、菜单和表单保留普通指针交互。拖动和缩放由原生窗口处理。自然完成时另由 `CompletionReminders` 管理一个可复用的独立提醒窗口；该窗口只显示 Main 的临时提醒状态，不初始化摄像头或新的 TimerEngine。

## 3. 平台集成

- `powerMonitor.getSystemIdleTime()` 每秒采样。仅传递闲置秒数，不传递输入内容。TimerEngine 根据有效输入样本推导 `breakPreparation`，经快照提供准备剩余秒数及是否进入最后 10 秒；Renderer 只呈现该倒数。默认第 30 秒显示 `10…1`，第 40 秒才开始正式休息，准备期不抵扣休息时长。输入回归会重新等待完整阈值；故障、睡眠、重启或实际来源变化清空准备状态，不补计离线时间。
- `powerMonitor` 的 suspend/resume 事件让运行轮次进入 `auto-paused`，恢复后由用户或安全自动条件继续。
- `lock-screen/unlock-screen` 直接驱动 TimerEngine 锁屏门禁；锁屏期间输入不得恢复计时，解锁后等待下一有效样本。检测持续失败时，用户显式继续启用临时手动回退，下一有效样本、锁屏、睡眠或重启取消回退。
- 摄像头只在用户已选择监控时启用；Main 将媒体权限限制为可信主窗口的主 frame、视频权限，拒绝麦克风和外部 frame。macOS 打包声明摄像头用途。CSP 仅为本地 MediaPipe 增加 WebAssembly 执行许可，不引入远程脚本或模型。
- 选中的监控在隐藏、最小化和页面导航时继续检测，窗口禁用后台节流；系统睡眠/锁屏时释放摄像头，恢复/解锁后签发新代次并等待新结果。切回触控、退出或检测失败都会释放资源。故障回退持久化为触控，避免反复请求权限。
- Tray 菜单、窗口、通知都调用同一 TimerEngine，不复制状态。
- Tray 只在展示秒数、可用操作或状态改变时重建菜单；完成卡片依赖成功持久化后的完成计数及 `completedRound`，跳过轮次不产生完成提醒。Main 用对应完成版本去重，系统不再额外发送完成通知。
- 完成提醒窗口有单独的隔离 session、严格 CSP 和自包含 preload，仅允许自身主 frame 读取/订阅当前提醒及按 ID 确认。其 sender 不获得主窗口的计时命令、设置或摄像头权限，全部权限请求拒绝。主窗口的既有 preload allowlist 不增加提醒方法。
- 提醒使用普通悬浮层级；macOS 使用 panel 参与桌面与原生全屏，自动显示只调用 `showInactive()`。内容按主题更新，手动确认后隐藏复用窗口，以完成 IPC 回复；下一次完成替换当前条目。锁屏和睡眠隐藏未确认内容，恢复后可重现，退出清除。提醒创建/加载失败只发布可恢复界面错误，不进入存储故障冻结路径。
- Preload 分别构建为自包含的 `index.js` 和 `reminder.js`。主入口保持单入口 Rollup，提醒入口在生成阶段独立打包并监听依赖；避免多入口共享分块使 sandbox 的受限 `require` 无法加载桥接代码。
- 关闭窗口在 Windows 上隐藏到托盘，退出菜单设置退出标记后真正退出；macOS 遵循应用生命周期。
- `contextIsolation`、sandbox、CSP、禁止导航和外部链接 allowlist 必须保持。
- macOS 使用 `hiddenInset`，为左上角交通灯预留空间。Windows 使用 Electron 的 `hidden` 和 32 px 标题栏覆盖层，保留系统窗口按钮，停止使用会被 Alt 唤出的默认应用菜单。覆盖层单独占一行，Main 在约束内容尺寸时扣除该行；Renderer 按下方计时器的可用宽高排版。计时器留白在两个平台都由系统处理拖动，按钮仍可点击。
- macOS 的 `followWorkspaces` 开启时构造 `type: "panel"`，关闭时构造普通窗口；`alwaysOnTop` 独立使用普通 `floating` 层级。Electron 33 的 panel 固定参与所有 Spaces 和全屏辅助空间，因此切换跟随通过异步重建窗口生效，保持原有位置、尺寸、页面和同一个 TimerEngine、Store。页面仅通过校验过的 `timer`、`settings`、`stats` fragment 恢复，不增加 IPC 或允许任意导航。
- 新窗口成功加载并就绪后才销毁旧窗口；加载失败恢复旧窗口的 IPC 与动态媒体权限校验，用户可重新保存以重试。摄像头就绪门禁只在主 frame 的非同文档导航时失效；fragment 导航不释放检测会话，真实 reload 仍签发新代次。
- 桌面跟随不调用会转换应用进程类型的 `setVisibleOnAllWorkspaces`，以保留正常 Dock 与 Cmd-Tab 入口。panel 的激活、跨全屏显示、撤销跟随和多屏体验仍须按路线图进行实机验收；Windows 不启用该窗口类型。
- macOS 原生窗口提供透明背景；Windows 保留不透明原生窗口，避免 Electron 透明窗口的缩放与最大化限制，并在主题变化时同步原生底色。Renderer 在 macOS 降低背景不透明度，在 Windows 混合表面色，同时淡化辅助信息。`autoFade` 仅在计时器页根据本地指针、键盘与菜单交互状态生效，只调整背景和辅助信息，不调用整窗 `setOpacity`，不采集系统输入内容、不影响 TimerEngine。设置和统计页继续绘制不透明背景。
- 初始内容区域为 360×478 px，最小为 160×180 px。Main 换算原生边框后，将内容高度限制在宽度的 1.5 倍以内，同时允许宽矮窗口。
- 托盘资源与应用图标分离：macOS 从 `trayTemplate.png` 和 `trayTemplate@2x.png` 创建透明黑色 template `NativeImage` 并设置 tooltip；Windows 只加载 `.ico`，Dock 继续使用 `.icns`。
- 原生验收使用独立临时 `userData`，由 Main 的真实 PID、`app.getPath("userData")` 和当前 Tray 的 `getBounds()` 确认实例。只有显式设置 `POMODORO_DIAGNOSTICS=1` 时，Node inspector 才可通过 Main 内部的只读 symbol 查询窗口、Tray 及其实际图像倍率；该能力不进入 preload 或 IPC。其他常驻应用无需退出。

## 4. SQLite

数据库文件为 `pomodoro.sqlite`。版本 4 迁移保留原有四张表和版本 1–3 的校验和，事务内将可读取的旧快照改写成计时检查点。检查点记录轮次、剩余时间、计时状态等恢复信息，系统挂起可以保留原因，输入监测的字段留在实时快照中。专注完成时，Store 在同一事务内写入完成记录和下一轮检查点，按稳定的轮次 ID 防止重启后重复计数。

窗口选项沿用版本 1 设置 JSON，不增加或修改已发布迁移。Store 的读取兼容 schema 仅为旧数据缺少的 `followWorkspaces`、`autoFade` 补 `true`，保留原有 `alwaysOnTop` 和显式 `false`；IPC 的完整设置与 patch 仍使用严格 schema，patch 不添加默认字段。

`better-sqlite3` 12.x 是当前 Electron 33 / Node 20 构建目标的实现选择。打包前由 electron-builder 重建原生模块；升级 Electron 或数据库驱动时必须重新验证构建。

静止状态对相同业务快照去重，运行中保留每秒检查点。初始化失败由 Store 复制数据库及现存 WAL/SHM 到时间戳备份目录并关闭连接；Main 默认退出，仅在用户明确选择后归档原文件并重建。运行时存储异常由 Main 统一捕获，调用 TimerEngine 的无写入故障冻结接口，停止后台轮询并广播不可恢复 `core.error`；退出不再尝试写入失败的连接。

完成事务提交后，Store 的进程内完成修订号驱动 Main 发布 `stats.changed`。日期变化也触发统计刷新；所有统计日期由同一墙钟采样以本地日历推算，计时仍只用单调时钟。

## 5. 测试边界

`TimerEngine` 用注入的单调时钟、墙钟和 Store 独立测试。Renderer 测试验证空格计时控制、右上角模式入口、导航、休息准备倒数、按计划时长分配的周期条和故障提示。布局检查覆盖最小窗口、窄窗的高度上限和宽矮窗口。Electron E2E 验证真实 preload/IPC、原生窗口尺寸、导航和计时事件同步。macOS/Windows 的 idle、通知、托盘和睡眠恢复仍需真实设备手工验证。

`npm run test:store` 使用与 Electron 相同 ABI 的运行时验证真实 SQLite 的旧库兼容、校验和、事务回滚、去重及包含 WAL 的恢复副本。普通 PR CI 与发布 CI 均运行原生数据库测试和 Electron E2E；模拟电源事件只验证事件接线，不能替代真实锁屏和睡眠验收。

设置主题的 Electron E2E 在两个平台检查实际绘制背景的 `.pageSurface`，覆盖浅色、深色和系统主题切换；`body` 保持透明，不能用于判断设置页背景。Windows 另外检查原生标题栏颜色。CI 触发策略和主分支合并门槛见 [CI 与合并门槛](ci.md)。

PR CI 和发布流程均构建 macOS ARM64、macOS Intel 与 Windows x64 安装包。macOS 验证签名与摄像头 entitlement、篡改拒绝，并从只读挂载的最终 DMG 复制安装；Windows 静默安装最终 EXE。安装后均以独立临时 userData 运行真实 SQLite、托盘、最小挂件与开关操作，以及断网的随包 MediaPipe 推理（Chromium 模拟摄像头）。这些检查不替代浏览器下载隔离后的首次批准、物理摄像头或真实系统电源事件；本次结果见[发布验证记录](release-beta-3-validation.md)。

桌面挂件回归还覆盖旧设置补值、三个开关独立性、鼠标离开两秒后的局部淡化、键盘与菜单恢复，以及 macOS 跟随开关引起的窗口重建。自动化窗口标志不能证明实际跨原生全屏显示，也不能替代 Dock、Cmd-Tab、外接屏和 Windows 原生窗口的真机检查；本轮结果见[桌面挂件验证](desktop-widget-validation.md)。

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

不使用 Go、Rust、侧车、JSON-RPC、HTTP、WebSocket 或 Node 子进程。这样计时、托盘、通知、系统输入采样和持久化都由一个权威状态直接驱动，renderer 关闭或未轮询时计时仍继续。

Main 在就绪及打开数据库之前取得单实例锁；同一 userData 的第二次启动只唤起已有窗口。独立临时数据目录的测试仍可并行拥有各自实例。

## 2. 进程边界

React 只渲染快照、导航设置/统计视图、维护临时表单，并显示 Main 返回或广播的窗口模式。Preload 只暴露 `getSnapshot`、`command`、`getSettings`、`updateSettings`、`getCapabilities`、`getStatistics`、`getWindowMode`、`setWindowMode`、`subscribe`。Main 验证调用来源和 payload，广播经 Zod 校验的状态事件。

`TimerEngine` 保存轮次、剩余时间、运行状态、手动暂停锁、输入 presence、设置生效边界，并在完整专注结束时调用 Store 写入一条记录。它使用单调时间派生剩余时长；Store 只保存状态快照、设置和完成记录。

`regular | mini` 是 Main 管理的原生窗口状态，不属于 TimerEngine 或持久化设置。Main 在内存中分别记住每种模式的窗口 bounds，应用各自的最小内容尺寸，切换后返回当前模式并广播 `window.modeChanged`。Renderer 启动时并行读取模式与计时/设置数据；模式读取失败使用现有核心错误界面，不能猜测模式。原生尺寸变化只由 CSS 调整排布，React 不监听 resize 来切换迷你模式，也不为布局变化发送计时命令。

## 3. 平台集成

- `powerMonitor.getSystemIdleTime()` 每秒采样。仅传递闲置秒数，不传递输入内容。TimerEngine 使用单调时钟为当前休息轮保留阈值前最多 10 秒的倒计时候选，达到阈值后才确认扣时；候选只在内存中，输入回归、手动操作、检测失败、睡眠、重启、切轮或阈值变化会清除，不补计跨轮或离线时间。
- `powerMonitor` 的 suspend/resume 事件让运行轮次进入 `auto-paused`，恢复后由用户或安全自动条件继续。
- `lock-screen/unlock-screen` 直接驱动 TimerEngine 锁屏门禁；锁屏期间输入不得恢复计时，解锁后等待下一有效样本。检测持续失败时，用户显式继续启用临时手动回退，下一有效样本、锁屏、睡眠或重启取消回退。
- Tray 菜单、窗口、通知都调用同一 TimerEngine，不复制状态。
- Tray 只在展示秒数、可用操作或状态改变时重建菜单；完成通知依赖成功持久化后的完成计数，跳过轮次不发“轮次完成”。
- 关闭窗口在 Windows 上隐藏到托盘，退出菜单设置退出标记后真正退出；macOS 遵循应用生命周期。
- `contextIsolation`、sandbox、CSP、禁止导航和外部链接 allowlist 必须保持。
- macOS 窗口使用 `hiddenInset` 时，Main 仅配置原生 traffic-light 位置；Renderer 根据浏览器平台标记预留受控标题栏安全区。Windows 使用默认原生标题栏，不继承 macOS 留白，最小尺寸换算仍以内容区域为准。
- 首次启动使用常规模式 360×478；常规最小内容区域为 320×300，首次进入迷你模式和迷你最小区域均为 220×240。显式切回常规恢复之前的常规 bounds；模式和 bounds 仅在本次进程内保留，不写入 SQLite。常规模式保持竖向圆环构图、状态与操作同行，CSS 根据可用空间连续调整圆环、字号与留白；迷你模式保持状态与操作上下排列，拖动不改变构图或模式。
- 托盘资源与应用图标分离：macOS 从 `trayTemplate.png` 和 `trayTemplate@2x.png` 创建透明黑色 template `NativeImage` 并设置 tooltip；Windows 只加载 `.ico`，Dock 继续使用 `.icns`。
- 原生验收使用独立临时 `userData`，由 Main 的真实 PID、`app.getPath("userData")` 和当前 Tray 的 `getBounds()` 确认实例。只有显式设置 `POMODORO_DIAGNOSTICS=1` 时，Node inspector 才可通过 Main 内部的只读 symbol 查询窗口、Tray 及其实际图像倍率；该能力不进入 preload 或 IPC。其他常驻应用无需退出。

## 4. SQLite

数据库文件为 `pomodoro.sqlite`。迁移保留原有 `schema_migrations`、`settings`、`timer_snapshot`、`completed_focus_sessions` 表；版本 1/2 保持既有校验和，版本 3 为计时快照状态扩展。完成专注的稳定业务 ID、下一轮快照和完成记录在一个 SQLite 事务中提交，避免重启后重复统计；SQLite 仅由 Main 访问。

`better-sqlite3` 12.x 是当前 Electron 33 / Node 20 构建目标的实现选择。打包前由 electron-builder 重建原生模块；升级 Electron 或数据库驱动时必须重新验证构建。

静止状态对相同业务快照去重，运行中保留每秒检查点。初始化失败由 Store 复制数据库及现存 WAL/SHM 到时间戳备份目录并关闭连接；Main 默认退出，仅在用户明确选择后归档原文件并重建。运行时存储异常由 Main 统一捕获，调用 TimerEngine 的无写入故障冻结接口，停止后台轮询并广播不可恢复 `core.error`；退出不再尝试写入失败的连接。

完成事务提交后，Store 的进程内完成修订号驱动 Main 发布 `stats.changed`。日期变化也触发统计刷新；所有统计日期由同一墙钟采样以本地日历推算，计时仍只用单调时钟。

## 5. 测试边界

`TimerEngine` 用注入的单调时钟、墙钟和 Store 独立测试；Renderer 测试验证 Main 模式事件、菜单可达性、休息自动等待文案、故障可见和布局操作不发送计时命令。Electron E2E 验证真实 preload/IPC、显式模式切换与尺寸恢复、常规窄矮布局、控制、设置和事件同步。macOS/Windows 的 idle、通知、托盘和睡眠恢复仍需真实设备手工验证。

`npm run test:store` 使用与 Electron 相同 ABI 的运行时验证真实 SQLite 的旧库兼容、校验和、事务回滚、去重及包含 WAL 的恢复副本。普通 PR CI 与发布 CI 均运行原生数据库测试和 Electron E2E；模拟电源事件只验证事件接线，不能替代真实锁屏和睡眠验收。

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

## 2. 进程边界

React 只渲染快照、导航设置/统计视图、维护临时表单和紧凑布局判断。Preload 只暴露 `getSnapshot`、`command`、`getSettings`、`updateSettings`、`getCapabilities`、`getStatistics`、`subscribe`。Main 验证调用来源和 payload，广播经 Zod 校验的状态事件。

`TimerEngine` 保存轮次、剩余时间、运行状态、手动暂停锁、输入 presence、设置生效边界，并在完整专注结束时调用 Store 写入一条记录。它使用单调时间派生剩余时长；Store 只保存状态快照、设置和完成记录。

## 3. 平台集成

- `powerMonitor.getSystemIdleTime()` 每秒采样。仅传递闲置秒数，不传递输入内容。
- `powerMonitor` 的 suspend/resume 事件让运行轮次进入 `auto-paused`，恢复后由用户或安全自动条件继续。
- Tray 菜单、窗口、通知都调用同一 TimerEngine，不复制状态。
- 关闭窗口在 Windows 上隐藏到托盘，退出菜单设置退出标记后真正退出；macOS 遵循应用生命周期。
- `contextIsolation`、sandbox、CSP、禁止导航和外部链接 allowlist 必须保持。
- macOS 窗口使用 `hiddenInset` 时，Main 仅配置原生 traffic-light 位置；Renderer 根据浏览器平台标记预留受控标题栏安全区。Windows 使用默认原生标题栏，不继承 macOS 留白，最小尺寸换算仍以内容区域为准。
- 托盘资源与应用图标分离：macOS 从 `trayTemplate.png` 和 `trayTemplate@2x.png` 创建透明黑色 template `NativeImage` 并设置 tooltip；Windows 只加载 `.ico`，Dock 继续使用 `.icns`。
- 原生验收使用独立临时 `userData`，由 Main 的真实 PID、`app.getPath("userData")` 和当前 Tray 的 `getBounds()` 确认实例。只有显式设置 `POMODORO_DIAGNOSTICS=1` 时，Node inspector 才可通过 Main 内部的只读 symbol 查询窗口、Tray 及其实际图像倍率；该能力不进入 preload 或 IPC。其他常驻应用无需退出。

## 4. SQLite

数据库文件为 `pomodoro.sqlite`。迁移保留原有 `schema_migrations`、`settings`、`timer_snapshot`、`completed_focus_sessions` 表；版本 1/2 保持既有校验和，版本 3 为计时快照状态扩展。完成专注的稳定业务 ID、下一轮快照和完成记录在一个 SQLite 事务中提交，避免重启后重复统计；SQLite 仅由 Main 访问。

`better-sqlite3` 12.x 是当前 Electron 33 / Node 20 构建目标的实现选择。打包前由 electron-builder 重建原生模块；升级 Electron 或数据库驱动时必须重新验证构建。

## 5. 测试边界

`TimerEngine` 用注入的单调时钟、墙钟和 Store 独立测试；Electron E2E 验证真实 preload/IPC、窗口缩放、控制、设置和事件同步。macOS/Windows 的 idle、通知、托盘和睡眠恢复仍需真实设备手工验证。

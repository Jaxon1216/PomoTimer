# 前端请求流程

本文按当前代码实际执行的顺序说明：前端的一个动作会经过哪些 Electron 和 Go 代码，最后如何返回。它是学习参考，不替代 `docs/contracts.md` 中的正式协议定义。

## 先记住四层

```text
React Renderer
  -> Preload
  -> Electron Main
  -> Go Core
  -> SQLite
```

- **Renderer**：React 界面。它只能调用 `window.pomodoro`，不能直接调用 Electron、Go 或 SQLite。
- **Preload**：把少量安全的 IPC 方法放到 `window.pomodoro` 上，并校验前后数据。
- **Main**：确认调用来源、校验 IPC 参数、管理 Go 子进程。
- **Go Core**：计时状态的唯一权威；它决定命令是否允许、修改快照并保存。
- **SQLite**：只由 Go Core 读写。

## 0. 应用启动：先启动 Go，再显示前端

这不是用户点击产生的请求，但它决定后续请求能否成功。

1. Electron 就绪后执行 [`app.whenReady`](../apps/desktop/src/main/index.ts#L112-L138)。
2. Main 先注册 IPC 处理器：[`installIpcHandlers`](../apps/desktop/src/main/index.ts#L84-L106)。
3. Main 调用 [`core.start()`](../apps/desktop/src/main/index.ts#L130)。
4. [`CoreSupervisor.start`](../apps/desktop/src/main/sidecar.ts#L95-L126) 找到 Go 可执行文件，使用 `spawn` 启动它。
5. `start` 调用私有方法 [`request("core.initialize", ...)`](../apps/desktop/src/main/sidecar.ts#L113-L120)，通过子进程 `stdin` 写入一行 JSON-RPC。
6. Go 入口 [`main`](../apps/core/cmd/pomodoro-core/main.go#L17-L55) 从 `stdin` 循环读取。
7. [`protocol.ReadRequest`](../apps/core/internal/protocol/protocol.go#L54-L76) 按换行读取一条 JSON，并拒绝超长或未知字段。
8. Go 调用 [`Server.Handle`](../apps/core/internal/service/service.go#L136-L166)，将 `core.initialize` 分派给 [`Server.initialize`](../apps/core/internal/service/service.go#L172-L221)。
9. `initialize` 调用 [`store.Open`](../apps/core/internal/store/store.go#L24-L49)，打开 SQLite、执行迁移，并调用 [`loadOrCreateSnapshot`](../apps/core/internal/service/service.go#L227-L255) 加载或创建快照。
10. Go 用 [`protocol.WriteMessage`](../apps/core/internal/protocol/protocol.go#L84-L96) 把初始化结果写到 `stdout`。
11. Main 的 [`attachProcessHandlers`](../apps/desktop/src/main/sidecar.ts#L186-L217) 收到 `stdout`，按换行拆出一条消息。
12. [`handleLine` 与 `handleResponse`](../apps/desktop/src/main/sidecar.ts#L219-L241) 根据 JSON-RPC `id` 找到等待中的 Promise，`start()` 取得初始化结果。
13. Main 最后调用 [`createWindow`](../apps/desktop/src/main/index.ts#L22-L63)，React 页面开始运行。

初始化结果中的 `settings` 和 `capabilities` 被 Main 保存在 `CoreSupervisor.initialized` 中，供当前版本的 UI 直接读取。

## 1. 用户点击“开始”：完整命令链

暂停、继续、下一轮、重置的路径相同，只有命令值分别为 `pause`、`resume`、`next`、`reset`。

```text
点击按钮
  -> App.runCommand("start")
  -> window.pomodoro.command("start")
  -> ipcRenderer.invoke("pomodoro:command", "start")
  -> ipcMain.handle("pomodoro:command")
  -> CoreSupervisor.command("start")
  -> stdin: {"method":"timer.start","params":{}}
  -> Go Server.Handle
  -> Go Server.command("timer.start")
  -> Server.persist
  -> SQLite Store.SaveSnapshot
  -> stdout: {"result":{"snapshot":...}}
  -> CoreSupervisor.handleResponse
  -> Promise 返回到 React
  -> setData 更新界面
```

逐步对应代码如下：

1. 用户点击 `AppShell` 的按钮，调用传入的 `onCommand`，例如 [`onCommand(action.command)`](../apps/desktop/src/renderer/App.tsx#L177-L179)。
2. `onCommand` 对应 [`App.runCommand`](../apps/desktop/src/renderer/App.tsx#L231-L246)。它先禁用按钮，再调用 `window.pomodoro.command(command)`。
3. Preload 中的 [`api.command`](../apps/desktop/src/preload/index.ts#L21-L25) 用 `timerCommandSchema` 校验命令只能是 `start`、`pause`、`resume`、`next`、`reset`，然后调用 `ipcRenderer.invoke`。
4. Main 中 [`"pomodoro:command"` 处理器](../apps/desktop/src/main/index.ts#L97-L100) 先执行 `assertMainWindow(event)`，拒绝非主窗口的调用；再用同一个 schema 校验命令。
5. Main 调用 [`CoreSupervisor.command`](../apps/desktop/src/main/sidecar.ts#L137-L144)，将前端命令映射为 Go 方法名，例如 `start` 变成 `timer.start`。
6. [`CoreSupervisor.request`](../apps/desktop/src/main/sidecar.ts#L247-L276) 分配递增的 JSON-RPC `id`，写入 Go 子进程的 `stdin`。
7. Go 入口 [`main`](../apps/core/cmd/pomodoro-core/main.go#L23-L52) 调用 [`protocol.ReadRequest`](../apps/core/internal/protocol/protocol.go#L54-L76)，验证 JSON-RPC 外壳。
8. [`Server.Handle`](../apps/core/internal/service/service.go#L136-L166) 确认 Core 已初始化、参数为空，并将 `timer.start` 分派给 [`Server.command`](../apps/core/internal/service/service.go#L261-L305)。
9. `Server.command` 检查当前状态是否可以开始，然后调用 `enterRunning`。接着更新 `revision` 和 `emittedAt`。
10. `Server.command` 调用 [`Server.persist`](../apps/core/internal/service/service.go#L437-L443)，它把快照编码为 JSON，再调用 [`Store.SaveSnapshot`](../apps/core/internal/store/store.go#L155-L175) 写入 `timer_snapshot` 表。
11. Go 入口通过 [`protocol.WriteMessage`](../apps/core/internal/protocol/protocol.go#L84-L96) 把带有最新 `snapshot` 的成功结果写入 `stdout`。
12. Main 在 [`handleLine`](../apps/desktop/src/main/sidecar.ts#L219-L227) 中解析响应，并在 [`handleResponse`](../apps/desktop/src/main/sidecar.ts#L229-L241) 用 `id` 唤醒第 6 步的 Promise。
13. 响应按原路回到 Preload；[`api.command`](../apps/desktop/src/preload/index.ts#L21-L25) 再次用 `timerSnapshotSchema` 校验。
14. `runCommand` 得到 `snapshot`，调用 `setData`，React 用新状态重新渲染按钮、状态文字和倒计时。

## 2. 页面首次加载：三个并行请求

[`App` 的第一个 `useEffect`](../apps/desktop/src/renderer/App.tsx#L248-L272) 同时发出以下三个 Promise：

| 前端方法 | IPC channel | Main 最终读取位置 | 是否再次请求 Go |
| --- | --- | --- | --- |
| `getSnapshot()` | `pomodoro:get-snapshot` | [`core.getSnapshot`](../apps/desktop/src/main/index.ts#L85-L88) | 是，发出 `timer.getSnapshot` |
| `getSettings()` | `pomodoro:get-settings` | [`core.getInitializeResult().settings`](../apps/desktop/src/main/index.ts#L89-L92) | 否，读启动握手缓存 |
| `getCapabilities()` | `pomodoro:get-capabilities` | [`core.getInitializeResult().capabilities`](../apps/desktop/src/main/index.ts#L93-L96) | 否，读启动握手缓存 |

### `getSnapshot()` 的后半段

`core.getSnapshot()` 会调用 [`CoreSupervisor.getSnapshot`](../apps/desktop/src/main/sidecar.ts#L128-L135)，再经 `request("timer.getSnapshot", {})` 进入 Go。

Go 的 [`Server.Handle`](../apps/core/internal/service/service.go#L140-L151) 调用 [`currentSnapshot`](../apps/core/internal/service/service.go#L311-L334)：

- 不是 `running`：直接返回当前快照副本。
- 是 `running`：用 `runningSince` 和当前时间计算剩余毫秒数。
- 剩余时间到 `0`：推进到下一轮、保存新快照，再返回它。

此请求不会在普通运行中的每次读取都写 SQLite；只有轮次归零时才会保存。

### `getSettings()` 与 `getCapabilities()` 为什么不进 Go

它们的值已经随第 0 节的 `core.initialize` 响应返回并保存在 Main 内存中。当前版本还没有实现设置表的读写，因此 `settings` 是 Core 初始化时给出的默认设置，而不是一次新的 SQLite 查询；`capabilities` 也是启动时确定的能力声明。

[`updateSettings`](../apps/desktop/src/main/index.ts#L101-L105) 目前会校验参数后明确抛错，不能当成已完成的后端调用链。

## 3. 计时运行中：每 500ms 的快照刷新

当 `snapshot.status === "running"` 时，[`App` 的第三个 `useEffect`](../apps/desktop/src/renderer/App.tsx#L285-L297) 每 500ms 调用一次 [`syncSnapshot`](../apps/desktop/src/renderer/App.tsx#L224-L229)。

它走第 2 节的 `getSnapshot()` 链路，不走第 1 节的命令链路：

```text
Renderer syncSnapshot
  -> Preload getSnapshot
  -> Main pomodoro:get-snapshot handler
  -> CoreSupervisor.getSnapshot
  -> Go timer.getSnapshot
  -> Server.currentSnapshot
  -> 返回 snapshot
```

这解释了两个行为：

- Go 才计算权威的剩余时间，React 不自行减少权威值。
- 刷新通常只读取内存并返回；倒计时每 500ms 刷新不意味着每 500ms 写一次 SQLite。

## 4. 出错时响应如何返回

- **前端命令不合法**：Preload 的 Zod 校验先抛错，请求不会离开 Renderer 进程。
- **调用来源不合法**：Main 的 `assertMainWindow` 抛错，请求不会进入 Go。
- **Core 未启动、退出或协议损坏**：`CoreSupervisor` 抛出 `CoreUnavailableError`；[`runCommand`](../apps/desktop/src/renderer/App.tsx#L239-L245) 显示错误并重新启用按钮。
- **Go 拒绝状态转换**：例如空闲状态点击暂停，`Server.command` 返回 JSON-RPC 错误；Main 用请求 `id` 找回 Promise 并拒绝它，随后错误回到 React。
- **SQLite 写入失败**：Go 返回 `local storage is unavailable`；React 不会把本地临时状态当作成功结果。

## 调用入口速查

| 你想跟踪的动作 | 从这里开始看 | 下一站 |
| --- | --- | --- |
| 应用启动 Go Core | [`index.ts: core.start`](../apps/desktop/src/main/index.ts#L130) | [`sidecar.ts: start`](../apps/desktop/src/main/sidecar.ts#L95-L126) |
| 点击开始/暂停等 | [`App.tsx: runCommand`](../apps/desktop/src/renderer/App.tsx#L231-L246) | [`preload: api.command`](../apps/desktop/src/preload/index.ts#L21-L25) |
| 读取最新剩余时间 | [`App.tsx: syncSnapshot`](../apps/desktop/src/renderer/App.tsx#L224-L229) | [`preload: api.getSnapshot`](../apps/desktop/src/preload/index.ts#L16-L20) |
| Main 接收前端命令 | [`index.ts: pomodoro:command`](../apps/desktop/src/main/index.ts#L97-L100) | [`sidecar.ts: command`](../apps/desktop/src/main/sidecar.ts#L137-L144) |
| Go 接收所有请求 | [`main.go: main`](../apps/core/cmd/pomodoro-core/main.go#L17-L55) | [`service.go: Handle`](../apps/core/internal/service/service.go#L136-L166) |
| Go 执行计时命令 | [`service.go: command`](../apps/core/internal/service/service.go#L261-L305) | [`service.go: persist`](../apps/core/internal/service/service.go#L437-L443) |

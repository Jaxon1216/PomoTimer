# 技术架构

## 1. 架构目标

应用需要同时满足以下条件：

- macOS 和 Windows 的大部分界面与业务代码可共享。
- 计时在多个窗口、托盘菜单与应用重启之间保持单一真相。
- 系统闲置、系统睡眠、通知、窗口和摄像头权限等平台能力不暴露给 Renderer。
- Go 是业务核心，而不是只做一个无状态 HTTP 服务。
- 本地摄像头处理不泄露原始帧或生物信息。

采用 Electron 主进程、React Renderer、Go 本地侧车和 SQLite 的四层结构，而不让 Renderer 直接管理计时或持久化。

```text
React Renderer(s)
  |  typed window.pomodoro API
Preload bridge
  |  validated Electron IPC
Electron Main
  |-- windows / tray / notifications / permission policy
  |-- powerMonitor idle-time and suspend/resume events
  |-- Go sidecar supervisor
  |      newline-delimited JSON-RPC 2.0 over stdin/stdout
  v
Go Core
  |-- timer state machine and automation policy
  |-- settings and SQLite migrations
  |-- completed focus records and statistics aggregation
  v
SQLite in the OS application-data directory
```

## 2. 技术选型

| 层 | 选择 | 原因 |
| --- | --- | --- |
| 桌面运行时 | Electron | macOS/Windows 共享 UI，提供窗口、托盘、通知、`powerMonitor` 与打包能力。 |
| 构建 | `electron-vite` + npm | Vite 开发体验，清晰区分 main/preload/renderer，符合当前 Node/npm 环境。 |
| Renderer | React + TypeScript strict | 用户指定技术方向，适合同步多窗口的状态订阅与可组合 UI。 |
| 样式 | CSS Modules + CSS design tokens | 为紧凑挂件和完整工作台提供稳定的主题变量与局部样式。 |
| 图标 | Lucide React | 使用可访问的标准图标，避免手绘控制图标。 |
| 核心 | Go `1.24+` | 练习 Go，并把确定性状态机、JSON-RPC 和本地数据放在独立进程。 |
| 数据库 | SQLite + `modernc.org/sqlite` | 嵌入式、本地离线、纯 Go 驱动，避免 CGO 和跨平台原生编译链。 |
| 前端测试 | Vitest + React Testing Library | 测试纯组件、preload 类型和 UI 绑定。 |
| Electron E2E | Playwright Electron | 启动打包前 Electron、操作窗口并验证 IPC 与截图。 |
| Go 测试 | 标准 `testing` | 覆盖状态机、协议、迁移和统计。 |

Phase 2 在 Renderer 中增加 `@mediapipe/tasks-vision`。模型和 WASM 均随应用打包，禁止请求外部推理服务。

## 3. 计划目录

```text
apps/
  desktop/
    src/
      main/             Electron lifecycle, windows, tray, IPC, sidecar
      preload/          Typed, narrow bridge
      renderer/         React views, local UI state, Phase 2 camera module
      shared/           Protocol types generated or copied from contracts
    resources/
      core/             Per-platform Go sidecar binary at package time
      mediapipe/        Phase 2 WASM and model files
  core/
    cmd/pomodoro-core/  Sidecar entrypoint
    internal/
      protocol/         JSON-RPC framing and request validation
      timer/            State machine, sequence, monotonic clock
      policy/           Input/camera signal interpretation
      store/            SQLite migration, snapshot, sessions, statistics
docs/
tests/
scripts/
```

`apps/desktop/src/shared` and `apps/core/internal/protocol` intentionally mirror the contract names in `docs/contracts.md`. Phase 0 chooses a generation approach only after the protocol is stable; until then, contract parity tests must catch drift.

## 4. Process Responsibilities

### 4.1 React Renderer

Renderer responsibilities:

- Render the small widget, normal timer, settings and statistics views.
- Maintain ephemeral UI state such as selected tab, open popover, window layout mode and pending command feedback.
- Subscribe to `timer.snapshot`, `timer.roundCompleted` and `stats.changed` events from preload.
- In Phase 2 only, request the camera after explicit user intent, run local MediaPipe inference and send boolean camera-presence events.

Renderer must not:

- Call Electron APIs, Node APIs, filesystem APIs or SQLite.
- Calculate authoritative remaining time, sequence transitions or daily statistics.
- Read camera video in a second window. A single camera owner sends only boolean state to other windows.
- Log raw camera device labels, images or face geometry.

### 4.2 Preload

Preload is an allowlist, not a generic IPC proxy. It exposes methods such as:

```ts
window.pomodoro = {
  getSnapshot: () => Promise<TimerSnapshot>,
  command: (command: TimerCommand) => Promise<TimerSnapshot>,
  getSettings: () => Promise<Settings>,
  updateSettings: (patch: SettingsPatch) => Promise<Settings>,
  subscribe: (listener: CoreEventListener) => Unsubscribe,
  reportCameraPresence: (sample: CameraPresenceSample) => Promise<void>,
  getCapabilities: () => Promise<Capabilities>
}
```

Arguments are validated before forwarding. Event payloads are validated before crossing into the Renderer. Preload never exposes `ipcRenderer`, channels, `send`, `invoke`, filesystem paths or sidecar transport handles.

### 4.3 Electron Main

Main is the platform adapter and sidecar supervisor.

- Creates and coordinates widget, main/settings and optional statistics windows.
- Keeps a single tray menu synchronized with the latest Core snapshot.
- Routes renderer commands only after runtime schema validation.
- Starts, watches and restarts the Go sidecar.
- Polls `powerMonitor.getSystemIdleTime()` once per second while monitoring is required, then sends `signal.inputIdle` to Core.
- Forwards `powerMonitor` suspend/lock events as `system.suspend`; forwards resume/unlock as `system.resume`.
- Shows opt-in native notifications and owns camera permission policy.
- Applies a strict Electron permission request handler. Phase 2 permits only `media`/camera, only after an explicit renderer request correlated to the settings action.

Electron's `powerMonitor.getSystemIdleTime()` is the planned system-input adapter for both macOS and Windows. It must be verified on real macOS and Windows devices during Phase 1. If it does not meet the documented behavior on a supported platform, Main gains a small platform adapter that uses the native equivalent, such as Windows `GetLastInputInfo`; it must retain the same `idleSeconds` contract.

### 4.4 Go Core

Go Core is a single local process. It is authoritative for:

- Current cycle sequence, current round, remaining duration and timer state.
- Manual-pause lock, automatic pause/resume and stale signal rejection.
- Settings validation and the "current round versus next round" application rule.
- SQLite migrations, crash-safe timer snapshots, completed focus sessions and aggregate queries.
- Event publication to Electron over stdout.

Go Core does not:

- Open windows, access tray APIs, show notifications or invoke platform permissions.
- Capture input events or camera streams.
- Listen on a TCP/HTTP port.
- Persist raw detection events.

### 4.5 SQLite

The database lives in the operating system's user application-data directory, never beside the executable.

Initial tables:

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Applied migration versions and checksums. |
| `settings` | Versioned key/value settings owned by Go. |
| `timer_snapshot` | One current durable snapshot used to restore as `auto-paused`. |
| `completed_focus_sessions` | One row per completed focus round. |

Use one writer connection in Go and transactionally write a state snapshot after every meaningful state transition. Tick snapshots may be throttled to avoid a write per second; remaining time is recalculated from monotonic time while running.

## 5. Timer and Signal Data Flow

### 5.1 User command

```text
Renderer click
  -> preload validates TimerCommand
  -> Main validates sender/window and command schema
  -> Main sends JSON-RPC request to Go Core
  -> Core transitions state, persists durable change
  -> Core emits timer.snapshot
  -> Main updates tray and broadcasts typed event
  -> every Renderer updates from the same snapshot
```

### 5.2 System-input monitoring

```text
Main timer (1 second)
  -> powerMonitor.getSystemIdleTime()
  -> signal.inputIdle { observedAt, sequence, idleSeconds }
  -> Go policy maps idleSeconds to present/away
  -> current round rule decides run, auto-pause, or auto-resume
```

Main sends no keyboard or mouse event data. Core ignores samples whose sequence is older than the last accepted sample or whose timestamp exceeds the allowed clock-skew window.

### 5.3 Phase 2 camera monitoring

```text
One Renderer owns getUserMedia stream
  -> MediaPipe local face-presence model
  -> reportCameraPresence { observedAt, sequence, present }
  -> Main validates source window and rate
  -> signal.cameraPresence to Go Core
  -> Core applies camera debounce and focus/active-break policy
```

The camera stream is released when camera mode is disabled, the owner window closes, permission is revoked, or the app shuts down. The Go Core only receives boolean presence data and never knows camera device details.

### 5.4 Timer ticking

Core stores:

- `remainingAtStateChangeMs`
- a monotonic `runningSince` value valid only while `running`
- current `round`, `status`, `manualPauseLocked`, and config snapshot

When queried or when it emits a tick, Core derives:

```text
remaining = remainingAtStateChange - monotonicNow + runningSince
```

It transitions at zero exactly once, transactionally writes the completed focus record if applicable, and generates the following round. Wall-clock time is used only when creating a completed-session date in the user's local timezone.

## 6. Sidecar Protocol and Lifecycle

### 6.1 Transport

Electron Main launches the sidecar with a pipe for stdin, stdout and stderr. stdin/stdout carry one UTF-8 JSON object per newline using JSON-RPC 2.0. stderr is structured diagnostic output owned by Main and never shown directly in Renderer.

No local HTTP or WebSocket server is started. This prevents port conflicts and makes the Core unreachable from other local processes by default.

### 6.2 Startup

1. Main resolves the bundled sidecar path from Electron resources and checks it exists and is executable.
2. Main spawns the process with a per-launch instance identifier.
3. Main calls `core.initialize` with protocol version, user-data directory and application locale/timezone.
4. Core opens/migrates SQLite, loads a snapshot, converts a recovered running snapshot to `auto-paused`, and returns capabilities plus `TimerSnapshot`.
5. Main starts window/tray subscriptions only after the handshake succeeds.

### 6.3 Failure behavior

- A malformed stdout line is a protocol failure. Main stops accepting timer mutations, records a bounded diagnostic, terminates the sidecar and attempts one restart.
- If restart succeeds, Core restores the snapshot as `auto-paused`. Main clearly shows the recovered state; a later valid automation signal or an explicit user resume determines whether it runs again.
- If restart fails, UI remains readable but commands are disabled behind a clear "计时核心不可用" state. No cached Renderer state is treated as authoritative.
- Main never retries commands with uncertain mutation outcomes. Instead it restarts, requests a fresh snapshot and asks the user to repeat a command only when necessary.

### 6.4 Versioning

`protocolVersion` is a single integer. Main and Core must match exactly for Phase 1. A mismatch is a fatal startup error with an update/reinstall instruction; Main does not attempt compatibility guessing.

## 7. Platform Integration

| Concern | macOS | Windows | Shared behavior |
| --- | --- | --- | --- |
| System idle time | Electron `powerMonitor` verified against system input | Electron `powerMonitor` verified against system input / native fallback if necessary | Normalized to integer `idleSeconds`. |
| Camera permission | `NSCameraUsageDescription` in app bundle plus Electron permission handler | Windows Settings privacy permission plus Electron handler | Camera is opt-in; denial falls back to input mode. |
| Notifications | Native Notification Center | Native Windows notifications | User setting controls automatic notifications. |
| Tray | Menu bar icon and menu | Notification-area icon and menu | Uses same Core snapshot and commands. |
| Power events | suspend/resume/lock handling | suspend/resume/lock handling | Active timer switches to `auto-paused`. |
| Sidecar packaging | Universal or architecture-matched executable in `extraResources` | Architecture-matched `.exe` in `extraResources` | Main resolves sidecar without shell interpolation. |
| Signing | Hardened runtime, notarization before production release | Authenticode signing before production release | Untested unsigned bundles are not production artifacts. |

## 8. Electron Security Baseline

Every BrowserWindow uses:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
enableRemoteModule: false
```

Other mandatory controls:

- Disable or deny unneeded navigation, new-window creation, permissions and external protocols.
- Enforce a CSP such as `default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; media-src 'self' blob: mediastream:; worker-src 'self' blob:`.
- Permit only bundled app content. No remote renderer URLs, CDN scripts, remote fonts or remote model assets.
- Use runtime schemas for IPC and JSON-RPC payloads; TypeScript types alone are insufficient at process boundaries.
- Treat renderer input, camera-presence events and all sidecar output as untrusted until validated.

Consult Electron's [security tutorial](https://www.electronjs.org/docs/latest/tutorial/security) and [powerMonitor API](https://www.electronjs.org/docs/latest/api/power-monitor) against the chosen Electron version during Phase 0.

## 9. Testing Strategy

| Layer | Required coverage |
| --- | --- |
| Go state machine | All statuses/transitions, manual-pause lock, sequence generation, suspend/restart and zero-duration boundaries. |
| Go policy | Input threshold, camera debounce, source switch, stale samples and active/desk break inversion. |
| Go store | Fresh migration, upgrade migration, transaction rollback, corrupt-database backup and date aggregation. |
| Protocol | JSON line framing, schema violations, request IDs, events, restart and version mismatch. |
| Electron Main | Sidecar supervisor, IPC allowlist, tray synchronization, idle adapter and power event forwarding. |
| React | Snapshot rendering, compact layout, disabled state, accessibility labels, theme and statistics views. |
| Playwright Electron | Default cycle, auto-pause, manual lock, break modes, restart restore, multi-window synchronization. |
| Manual hardware | macOS and Windows idle detection, tray, sleep/resume, notification, compact window and Phase 2 camera permissions. |

No feature may use a platform placeholder that reports "always active" in a production build.

# PomoTimer · Pomodot

面向 macOS 和 Windows 的本地桌面番茄钟。用可配置的专注与休息节奏、系统输入闲置检测和本地统计，记录真正完成的专注轮次。

仓库名为 **PomoTimer**，安装包以 **Pomodot** 发布，应用内名称为 **Pomodoro Timer**。

[下载安装包](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.2) · [设计文档](docs/README.md) · [路线图](docs/roadmap.md) · [问题反馈](https://github.com/Jaxon1216/PomoTimer/issues)

## 下载与安装

当前公开版本为 **v0.1.0-beta.2（预发布）**，供体验与反馈使用，尚未完成全部真实设备验收。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [EXE 安装向导](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/Pomodot-0.1.0-beta.2-windows-x64-setup.exe) |
| macOS Apple Silicon | [ARM64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/Pomodot-0.1.0-beta.2-mac-arm64.dmg) |
| macOS Intel | [x64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/Pomodot-0.1.0-beta.2-mac-x64.dmg) |

- macOS：打开与芯片类型匹配的 DMG，将应用拖入 Applications。
- Windows：运行 EXE 安装向导，可选择安装目录。
- 下载后可与同一发布中的 [SHA256SUMS](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/SHA256SUMS) 核对文件校验值。
- 当前安装包**未使用开发者证书签名，macOS 也未公证**。系统可能阻止打开或提示未知发布者；请先核对来源与校验值，不要全局关闭系统安全保护。

### 版本与已知限制

**主分支不等于已发布安装包。** `main` 已合入[计时器故障恢复、数据保护和实时统计修复（#2）](https://github.com/Jaxon1216/PomoTimer/pull/2)，这些改动尚未包含在上面的 beta.2 安装包中；体验主分支需从源码运行。以下功能和开发说明以当前主分支为准，下载版以[对应发布说明](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.2)为准。

beta.2 已知问题：

- 锁屏事件尚未接入，锁屏前请手动暂停。
- 部分旧快照可能无法升级恢复，升级前请备份本地数据。
- 统计页停留期间不会实时刷新，重新进入页面可刷新。
- 输入检测持续故障时，手动继续可能再次被暂停。

安装包已在 GitHub runner 完成构建和打包应用自动化检查；真实设备的系统输入、通知、锁屏、睡眠及人工安装验证仍未全部完成。模拟事件和自动化启动测试不代表真实平台验收，详见 [Phase 1 发布门](docs/roadmap.md#phase-1-发布门)。

## 主要功能

- **可配置节奏**：默认 `30 / 5 / 30 / 5 / 30 / 10` 分钟，三轮专注后进入长休；可调整各轮时长和每周期专注轮数。
- **输入闲置检测**：默认连续 40 秒无系统输入后暂停专注，恢复输入后按状态自动继续；手动暂停不会被自动解除。
- **两种休息模式**：活动休息与桌前休息。当前均基于无输入信号判断开始与暂停，不代表已验证离席、走动或运动。
- **本地统计**：今日、本周和最近 52 周热力图；只有完整完成的专注轮才计入统计，跳过或重置不计入。
- **桌面控制**：常规/迷你窗口、置顶、托盘菜单、系统通知，以及浅色/深色/跟随系统主题。
- **恢复与数据保护（主分支）**：睡眠与重启不补计离线时间；锁屏门禁、输入故障下的显式手动计时、单实例保护、SQLite 故障备份与用户确认重建。

### 基本使用

1. 打开应用，点击开始进入第一轮专注。
2. 专注完整结束后进入休息轮。休息默认等待无输入条件，也可手动开始；再次输入仍可能自动暂停休息。
3. 使用暂停/继续控制当前轮，或点击下一步跳过；下一轮专注需要手动开始。
4. 在“更多操作”中打开设置、统计或切换迷你模式。修改节奏不会重置正在运行的轮次，具体生效时机见[产品规格](docs/product-spec.md#2-默认配置与设置)。

## 本地数据与隐私

应用离线运行，设置、计时快照和完成记录保存在当前设备的 SQLite 数据库中，文件为 Electron `app.getPath("userData")` 下的 `pomodoro.sqlite`。

系统输入检测只读取“距最近一次系统输入的秒数”，不记录按键内容、鼠标位置、活动窗口或屏幕内容。当前没有账号、云同步或遥测，也没有启用摄像头检测；摄像头在场和手动站立专注属于后续阶段，Linux 不在当前支持范围。

## 从源码开发

使用 macOS 或 Windows、Git、**Node.js 24 和 npm**（与当前 CI 一致）。

```sh
git clone https://github.com/Jaxon1216/PomoTimer.git
cd PomoTimer
npm ci
npm run dev
```

项目使用 npm workspaces 和根目录 `package-lock.json`。`dev` 会先为当前 Electron 重建原生依赖，再启动 electron-vite；需要可用的本机图形环境，不能用普通浏览器替代完整桌面验证。

在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm run lint` | ESLint 检查，警告视为失败 |
| `npm run typecheck` | Main/preload 与 renderer 的 TypeScript 检查 |
| `npm run test` | Vitest 单元与组件测试 |
| `npm run test:store` | 重建原生依赖，使用 Electron 运行时验证真实 SQLite |
| `npm run test:e2e` | 构建、重建原生依赖并运行 Playwright Electron E2E |
| `npm run build` | 构建应用代码 |
| `npm run package` | 使用 electron-builder 生成当前平台安装包 |

安装包输出在 `apps/desktop/dist/`。打包后，可在对应系统运行 `node scripts/smoke-packaged.mjs` 检查打包应用；开发启动与原生回归说明见[开发验证文档](docs/README.md#本地原生回归)。

CI 在 macOS 和 Windows 上运行 lint、类型检查、单元测试、原生数据库测试和 Electron E2E。发布工作流额外构建 Windows x64、macOS ARM64 和 macOS x64 安装包，但不替代人工验收。

## 架构与目录

```text
React renderer
    ↓ 类型化 window.pomodoro API
受限 preload
    ↓ 白名单 IPC + Zod 校验
Electron main
    ├─ TimerEngine：唯一计时状态，使用单调时钟
    ├─ SqliteStore：唯一数据库访问层
    └─ 窗口、托盘、通知与 powerMonitor
```

React 负责展示和交互，不拥有权威计时或数据库；计时核心是独立于 Electron API 的 TypeScript 模块。当前不使用 Go/Rust 侧车或 HTTP/WebSocket 服务。

```text
apps/desktop/src/main/      Electron 集成、计时核心、统计和 SQLite
apps/desktop/src/preload/   受限的类型化桌面 API
apps/desktop/src/renderer/  React 界面与样式
apps/desktop/src/shared/    IPC 类型与运行时 schema
tests/e2e/                 Electron 跨进程测试
scripts/                   原生验证、打包检查和发布辅助脚本
docs/                      产品、架构、契约与路线图
```

## 文档与反馈

- [产品规格](docs/product-spec.md)：默认值、计时规则和交互边界。
- [技术架构](docs/architecture.md)：进程职责、平台集成和数据保护。
- [IPC 与持久化契约](docs/contracts.md)：类型、事件和数据库模型。
- [分阶段路线图](docs/roadmap.md)：当前范围、未来能力和发布门。
- [协作约定](AGENTS.md) · [第三方资源说明](docs/third-party-notices.md)。

欢迎通过 [Issues](https://github.com/Jaxon1216/PomoTimer/issues) 反馈问题。请附上操作系统、芯片架构、安装包版本或源码 commit、复现步骤，以及预期与实际结果；分享截图或日志前请先移除个人信息和本地路径。

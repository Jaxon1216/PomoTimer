<p align="center">
  <img src="apps/desktop/resources/icons/pomodoro-timer-master.png" width="96" height="96" alt="Pomodot 折纸回环应用图标">
</p>

<h1 align="center">PomoTimer · Pomodot</h1>

<p align="center">
  为电脑前的工作与学习安排专注和休息。<br>
  macOS / Windows 本地番茄钟，支持输入闲置自动暂停、桌面小窗与专注统计。
</p>

<p align="center">
  <a href="https://github.com/Jaxon1216/PomoTimer/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Jaxon1216/PomoTimer/ci.yml?branch=main&amp;label=CI" alt="main 分支 CI 状态"></a>
  <a href="https://github.com/Jaxon1216/PomoTimer/releases"><img src="https://img.shields.io/github/v/release/Jaxon1216/PomoTimer?include_prereleases&amp;label=pre-release" alt="最新预发布版本"></a>
</p>

<p align="center">
  <a href="#下载与安装">下载安装</a> ·
  <a href="#基本使用">开始第一轮</a> ·
  <a href="#从源码开发">源码运行</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="CHANGELOG.md">更新记录</a> ·
  <a href="https://github.com/Jaxon1216/PomoTimer/issues">反馈问题</a>
</p>

## 界面预览

| 开始一轮专注 | 缩成桌面小窗 |
| :---: | :---: |
| [<img src="docs/assets/screenshots/timer-light.png" width="320" alt="第一轮专注显示 30:00、准备开始和圆形播放按钮">](docs/assets/screenshots/timer-light.png) | [<img src="docs/assets/screenshots/long-break-waiting-compact.png" width="220" alt="220×240 小窗显示 10 分钟长休，等待无输入条件后自动开始">](docs/assets/screenshots/long-break-waiting-compact.png) |

截图来自 macOS 上的真实 Electron **开发版**测试窗口。下文使用与功能说明以当前 `main` 为准，已发布安装包的布局和能力有所不同，见[版本与已知限制](#版本与已知限制)。[截图来源与重现方法](docs/README.md#产品截图)

## 下载与安装

当前公开版本为 **[v0.1.0-beta.2（预发布）](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.2)**，供体验与反馈使用，尚未完成全部真实设备验收。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [EXE 安装向导](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/Pomodot-0.1.0-beta.2-windows-x64-setup.exe) |
| macOS Apple Silicon | [ARM64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/Pomodot-0.1.0-beta.2-mac-arm64.dmg) |
| macOS Intel | [x64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/Pomodot-0.1.0-beta.2-mac-x64.dmg) |

- macOS：打开与芯片类型匹配的 DMG，将应用拖入 Applications。
- Windows：运行 EXE 安装向导，可选择安装目录。
- 下载后可与同一发布中的 [SHA256SUMS](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.2/SHA256SUMS) 核对文件校验值。
- 当前安装包**未使用开发者证书签名，macOS 也未公证**。系统可能阻止打开或提示未知发布者；请先核对来源与校验值，不要全局关闭系统安全保护。

使用 beta.2 时，**锁屏前请手动暂停，升级前请备份本地数据**。仓库名为 **PomoTimer**，安装包以 **Pomodot** 发布，应用内名称为 **Pomodoro Timer**。

### 版本与已知限制

`main` 中的窗口缩放、锁屏暂停、故障恢复和实时统计等更新尚未发布到 beta.2。体验这些改动请[从源码运行](#从源码开发)；下载版的具体能力以[发布说明](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.2)为准。

<details>
<summary>展开查看 beta.2 已知问题、源码更新与验收状态</summary>

beta.2 已知问题：

- 锁屏事件尚未接入，锁屏前请手动暂停。
- 部分旧快照可能无法升级恢复，升级前请备份本地数据。
- 统计页停留期间不会实时刷新，重新进入页面可刷新。
- 输入检测持续故障时，手动继续可能再次被暂停。

当前源码已合入[故障恢复、数据保护与实时统计修复（#2）](https://github.com/Jaxon1216/PomoTimer/pull/2)，以及[拖动缩成桌面小窗（#5）](https://github.com/Jaxon1216/PomoTimer/pull/5)。其中包含锁屏暂停、输入故障下的显式手动计时、单实例保护、SQLite 故障备份与用户确认重建；更多变化见 [Unreleased](CHANGELOG.md#unreleased)。部分旧快照仍可能无法恢复，应用会保留备份，仅在用户选择后归档并重建。

安装包已在 GitHub runner 完成构建和打包应用自动化检查；真实设备的系统输入、通知、锁屏、睡眠及人工安装验证仍未全部完成。模拟事件和自动化启动测试不代表真实平台验收，详见 [Phase 1 发布门](docs/roadmap.md#phase-1-发布门)。

</details>

## 基本使用

以默认的第一轮专注为例：

1. **开始专注**：打开应用，看到 `30:00` 和“准备开始”，点击圆形播放按钮（开始计时），倒计时开始递减。
2. **按需暂停**：连续 40 秒无系统输入时，专注自动暂停；恢复输入后按状态自动继续。如果主动点击暂停，只有你点击继续才会恢复。
3. **进入休息**：完整完成这轮后，应用进入 5 分钟短休的等待状态。达到无输入条件后自动开始，也可点击“手动开始休息”；再次输入仍可能自动暂停休息。
4. **查看结果**：点击右上角的统计图标。在没有其他完成记录的情况下，今日统计会显示 **1 轮、30 分钟**。专注未完成就跳过或重置时，不计入统计；下一轮专注需要手动开始。

默认周期（分钟）：

```text
专注 30 → 短休 5 → 专注 30 → 短休 5 → 专注 30 → 长休 10
```

通过“更多操作”打开设置，可调整专注与休息时长、每周期轮数和输入闲置阈值。修改节奏后，正在运行的轮次仍按原计划计时，详见[设置生效时机](docs/product-spec.md#2-默认配置与设置)。

想把计时器留在桌面一角，可以拖动窗口边缘缩小，拖动留白移动，再在设置中开启置顶。开发版最小内容区域为 **160×180**，高度最多为宽度的 1.5 倍（宽 160 px 时最高 240 px）；小窗保留轮次、剩余时间、暂停原因、圆形操作按钮与统计入口。[查看最小窗口](docs/assets/screenshots/drag-minimum-interrupted-break.png)

## 主要功能

| 功能 | 具体行为 |
| --- | --- |
| 可配置节奏 | 默认三轮专注后进入长休，可调整时长与每周期轮数。 |
| 输入闲置检测 | 默认连续 40 秒无输入后暂停专注，手动暂停不会被自动解除。 |
| 两种休息模式 | 活动休息与桌前休息，当前均依据无输入信号判断开始与暂停。 |
| 本地统计 | 今日、本周与最近 52 周热力图，仅统计完整完成的专注轮。 |
| 桌面控制 | 窗口缩放、置顶、托盘菜单和系统通知；浅色、深色与跟随系统主题。 |
| 恢复与保护 | 睡眠、重启不补计离线时间；开发版增加锁屏暂停与存储故障保护。 |

输入检测只知道有没有操作电脑，不能确认用户是否离席、走动或运动。阅读、思考等没有输入的活动也可能触发自动暂停，可按需调整闲置阈值。

## 本地数据与隐私

应用离线运行，设置、计时快照和完成记录保存在当前设备的 SQLite 数据库中，文件为 Electron `app.getPath("userData")` 下的 `pomodoro.sqlite`。

系统输入检测只读取“距最近一次系统输入的秒数”，不记录按键内容、鼠标位置、活动窗口或屏幕内容。当前没有账号、云同步或遥测，也没有启用摄像头检测；摄像头在场和手动站立专注属于后续阶段，Linux 不在当前支持范围。

开发版只在内存中使用闲置秒数和推断出的在场状态。重启后会恢复轮次和剩余时间，等新的输入采样再判断在场状态。从旧版本升级时，已有备份保留原样；详见[更新记录](CHANGELOG.md)。

## 从源码开发

使用 macOS 或 Windows、Git、**Node.js 24 和 npm**（与当前 CI 一致）。

```sh
git clone https://github.com/Jaxon1216/PomoTimer.git
cd PomoTimer
npm ci
npm run dev
```

首次运行且没有已有数据时，应出现上图中的计时器：第一轮专注、`30:00`、等待开始。点击播放按钮即可按[基本使用](#基本使用)走完一轮；再次打开会恢复上次轮次与剩余时间。

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

<details>
<summary>展开查看源码目录</summary>

```text
apps/desktop/src/main/      Electron 集成、计时核心、统计和 SQLite
apps/desktop/src/preload/   受限的类型化桌面 API
apps/desktop/src/renderer/  React 界面与样式
apps/desktop/src/shared/    IPC 类型与运行时 schema
apps/desktop/resources/     打包进应用的图标与托盘资源
tests/e2e/                 Electron 跨进程测试
scripts/                   原生验证、打包检查和发布辅助脚本
.github/                    PR 模板、检查与发布工作流
docs/                      产品、架构、契约与路线图
docs/assets/screenshots/   供阅读文档使用的产品截图
```

</details>

## 文档与反馈

- 新接手开发时，先读[协作约定](AGENTS.md)，从[更新记录](CHANGELOG.md)了解已发布与待发布的改动，再按[文档索引](docs/README.md)找到本次改动涉及的规格、代码入口和验收要求。
- [产品规格](docs/product-spec.md)：默认值、计时规则和交互边界。
- [技术架构](docs/architecture.md)：进程职责、平台集成和数据保护。
- [IPC 与持久化契约](docs/contracts.md)：类型、事件和数据库模型。
- [分阶段路线图](docs/roadmap.md)：当前范围、未来能力和发布门。
- [第三方资源说明](docs/third-party-notices.md)：字体和视觉参考来源。

欢迎通过 [Issues](https://github.com/Jaxon1216/PomoTimer/issues) 反馈问题。请附上操作系统、芯片架构、安装包版本或源码 commit、复现步骤，以及预期与实际结果；分享截图或日志前请先移除个人信息和本地路径。

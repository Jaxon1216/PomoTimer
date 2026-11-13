# PomoTimer · Pomodot

面向 macOS 和 Windows 的本地桌面番茄钟。安排专注与长短休，把计时器缩成桌面挂件，记录完整完成的专注轮次。

默认根据键盘、鼠标或触控板的输入活动自动暂停和恢复，也可选择摄像头在场感知。无需账号，数据留在本机。

[下载安装包](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.3) · [更新记录](CHANGELOG.md) · [文档索引](docs/README.md) · [问题反馈](https://github.com/Jaxon1216/PomoTimer/issues)

| 初始窗口 · 等待开始 | 拖小窗口 · 等待活动休息 |
| --- | --- |
| <img src="docs/assets/screenshots/timer-light.png" width="360" alt="初始窗口显示第一轮专注、30 分钟倒计时和开始按钮"> | <img src="docs/assets/screenshots/long-break-waiting-compact.png" width="220" alt="小窗显示 10 分钟长休，等待离席后自动开始"> |

这两张图来自开发版在 macOS 上的真实 Electron 测试窗口。[截图版本与重现方法](docs/README.md#产品截图)

## 下载与安装

当前版本为 **v0.1.0-beta.3（预发布）**，供体验与反馈使用，尚未完成全部真实设备验收。下载对应安装包即可使用，无需安装 Node.js 或配置开发环境。

仓库名为 **PomoTimer**，安装包以 **Pomodot** 发布，应用内名称为 **Pomodoro Timer**。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [EXE 安装向导](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/Pomodot-0.1.0-beta.3-windows-x64-setup.exe) |
| macOS Apple Silicon | [ARM64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/Pomodot-0.1.0-beta.3-mac-arm64.dmg) |
| macOS Intel | [x64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/Pomodot-0.1.0-beta.3-mac-x64.dmg) |

- macOS：M 系列芯片选择 ARM64，Intel 芯片选择 x64。打开对应 DMG，将应用拖入 Applications，再从 Applications 启动。
- Windows：运行 EXE 安装向导，可选择安装目录。
- 下载后可与同一发布中的 [SHA256SUMS](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/SHA256SUMS) 核对文件校验值。
- macOS 安装包使用免费的 **ad hoc 完整性签名**，没有 Developer ID 签名或 Apple 公证，首次打开仍可能需要手动批准。Windows 安装包未使用开发者证书签名，可能显示未知发布者；请先核对来源与校验值。

### macOS 首次打开

1. 从 Applications 打开 **Pomodoro Timer**。如果提示“无法验证开发者”或“Apple 无法验证是否包含恶意软件”，先点“完成”或取消。
2. 进入“系统设置 → 隐私与安全性”，找到“已阻止 Pomodoro Timer”旁的“仍要打开”，按系统提示再次确认。需要认证时，请在电脑上使用 Touch ID 或管理员密码。
3. 批准后通常可从 Applications 正常启动；升级或更换构建后，系统可能重新要求批准。受组织管理的电脑可能不允许添加例外。

上述操作仅为已确认来源的这个应用添加例外，见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。ad hoc 签名用于验证代码完整性，不提供 Apple 认可的开发者身份。如果提示“已损坏”“将损坏你的电脑”，或没有“仍要打开”，请记录完整提示、macOS 版本及安装包文件名后[反馈](https://github.com/Jaxon1216/PomoTimer/issues)，不要全局关闭系统安全保护。

## 开始使用

1. **开始一轮专注**：打开应用，点击开始或按空格。默认使用输入活动感知，界面称为「触控模式」；连续 40 秒无输入会自动暂停。
2. **按节奏休息**：默认节奏是 `30 / 5 / 30 / 5 / 30 / 10` 分钟。专注结束后进入休息轮，满足无输入或离席条件后自动计时。
3. **调整成顺手的样子**：拖动窗口边缘缩成桌面挂件；在“更多操作 → 设置”中调整时长、轮数和外观。点击统计图标查看完成记录。

摄像头不是必需的。若需要，可将右上角的模式切换为「监控」并授权；它只做本机在场检测，不录像。

<details>
<summary>展开查看自动暂停、摄像头、休息和窗口操作细节</summary>

1. 安装后打开应用，默认使用触控模式。点击开始或按空格进入第一轮专注；连续无输入达到默认 40 秒后自动暂停，恢复输入后按状态继续。
2. 如需摄像头感知，点击计时器右上角、统计按钮左侧的模式按钮切换为监控，并允许摄像头访问。在场后自动开始专注，离席时暂停专注；切回触控即关闭摄像头。摄像头不可用时会提示并回退触控。
3. 专注完成后自动进入短休或长休，满足离席或无输入条件后开始休息计时。默认活动休息使用当前感知模式，桌前休息始终依据无输入。输入准备期的最后 10 秒会显示倒数，第 40 秒才开始完整的休息时长；中途有输入则重新等待。
4. 空格可开始、暂停或继续，也可点击下一步跳过当前轮。专注中的手动暂停需要主动继续；休息按过暂停后，满足条件仍会自动计时。设置、统计、输入框和菜单中的空格保留原有操作。
5. 拖动窗口边缘缩成桌面挂件，拖动计时器上的留白移动窗口。最小内容区域为 160×180，小窗仍显示时间、轮次、暂停原因及操作。设置中可分别开关置顶、自动淡化和 macOS 的跟随桌面与全屏。[查看最小窗口](docs/assets/screenshots/drag-minimum-interrupted-break.png)
6. 点击统计图标查看今日、本周和热力图记录；只有完整完成的专注轮才计入。点击“更多操作”打开设置，调整专注、长短休时长和轮数。正在进行的轮次保留原计划时长。[设置生效时机](docs/product-spec.md#2-默认配置与设置)

</details>

## 已知限制

- 物理摄像头的首次授权、不同光照、设备断开和权限撤销，尚未完成 macOS/Windows 全部真机验收。
- 系统输入、通知、锁屏、睡眠和人工安装仍有待验收项目。桌面挂件的 macOS 原生全屏、缩放和 Cmd-Tab 已有本机探针记录，桌面滑动、Split View、外接屏及 Windows 原生窗口体验仍待人工验收。
- 部分旧计时快照可能无法恢复。应用会保留数据库备份，仅在用户选择后归档并重建；升级前建议备份本地数据。

模拟媒体流、模拟系统事件和自动化启动检查不代表全部真实设备验收已通过。具体范围见 [Phase 1 发布门](docs/roadmap.md#phase-1-发布门)、[摄像头验证门](docs/roadmap.md#摄像头验证门)与[桌面挂件验证记录](docs/desktop-widget-validation.md)。版本改动以[对应发布说明](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.3)为准。

## 主要功能

- **可配置节奏**：默认 `30 / 5 / 30 / 5 / 30 / 10` 分钟，三轮专注后进入长休；可调整各轮时长和每周期专注轮数，底部周期条按计划时长分配宽度并标明当前位置。
- **输入闲置检测**：默认连续 40 秒无系统输入后暂停专注，恢复输入后按状态自动继续；专注中的手动暂停不会被自动解除。
- **两种感知模式**：输入活动感知（触控模式）使用系统输入闲置信号；摄像头在场感知（监控模式）需主动选择并授权。监控确认在场后自动开始专注，离席后自动计时活动休息；摄像头失败时提示并回退触控。
- **两种休息模式**：活动休息在监控模式下依据摄像头离席，在触控模式下依据无输入；桌前休息始终依据无输入。准备期最后 10 秒可见倒数，不抵扣正式休息时长；休息按过暂停仍可自动恢复，不代表已验证走动或运动。
- **本地统计**：今日、本周和最近 52 周热力图；只有完整完成的专注轮才计入统计，跳过或重置不计入。
- **桌面挂件**：拖动边缘缩放到最小 160×180，拖动留白移动；置顶、自动淡化独立控制，macOS 可跟随桌面与全屏。另有托盘菜单、系统通知，以及浅色/深色/跟随系统主题。
- **恢复与数据保护**：睡眠与重启不补计离线时间；锁屏暂停、输入故障下的显式手动计时、单实例保护、SQLite 故障备份与用户确认重建。

## 本地数据与隐私

应用离线运行，设置、计时快照和完成记录保存在当前设备的 SQLite 数据库中，文件为 Electron `app.getPath("userData")` 下的 `pomodoro.sqlite`。

系统输入检测只读取“距最近一次系统输入的秒数”，不记录按键内容、鼠标位置、活动窗口或屏幕内容。摄像头感知需要主动选择监控，画面只在本机瞬时处理，不保存、不上传，不识别身份。当前没有账号、云同步或遥测；手动站立专注属于后续阶段，Linux 不在当前支持范围。

闲置秒数和推断出的在场状态只在内存中使用。重启后会恢复轮次和剩余时间，等选中来源的新样本再判断在场状态。从旧版本升级时，已有备份保留原样；详见[更新记录](CHANGELOG.md)。

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

<details>
<summary>展开查看 CI、架构与目录</summary>

CI 在 macOS 和 Windows 上运行 lint、类型检查、单元测试、原生数据库测试和 Electron E2E。PR 更新只触发 PR 检查，`main` 更新触发主分支检查；同一 PR 或分支的新提交会取消旧运行。`main` 合并要求分支保持最新，且 GitHub Actions 的 `macos-latest`、`windows-2022` 检查均通过，管理员也受此限制；配置和维护命令见 [CI 与合并门槛](docs/ci.md)。发布工作流额外构建 Windows x64、macOS ARM64 和 macOS x64 安装包，但不替代人工验收。

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

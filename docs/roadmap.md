# 分阶段路线图

## 当前交付：Phase 1

当前实现以 Electron + React + TypeScript 为唯一运行架构，不再有 Go/Rust sidecar。代码和自动化验证已覆盖以下闭环；发布门仍需完成真实平台验证：

- 主进程唯一 TimerEngine：默认 `30/5/30/5/30/10`、开始/暂停/继续/下一轮/重置、手动暂停锁、自动暂停与恢复、睡眠/重启安全恢复。
- `powerMonitor.getSystemIdleTime()` 系统级输入采样，输入故障可见且进入手动安全回退。
- active/desk 休息策略、设置持久化与当前轮/下一轮生效边界。
- SQLite 事务迁移、完成专注记录、今日/本周/最近 52 周统计。
- 托盘、通知、关闭到托盘、置顶、事件广播、浅色/深色/跟随系统主题。拖动窗口边缘可缩成 160×180 的挂件，高度最多为宽度的 1.5 倍。小窗仍显示轮次、剩余时间、暂停原因、圆形操作按钮和统计入口。
- 受限 preload、严格 CSP、Zod 运行时 IPC 校验、Vitest 状态机测试和 Playwright Electron E2E。
- 单实例数据保护、锁屏门禁、检测故障下显式手动计时、字段级设置错误恢复、存储故障备份与用户选择重建、实时统计事件；静止检查点和托盘更新去重。

## Phase 1 发布门

1. `npm run lint`、`npm run typecheck`、`npm run test`、`npm run test:store`、`npm run build` 和适用的 E2E 全部通过。
2. macOS 手工验证真实输入、托盘、通知、睡眠/恢复，以及自动休息等待和手动开始。拖到 160×180，再保持宽 160 px 向下拉，核对内容高度止于 240 px。检查交通灯与统计入口的间距、圆形继续按钮，并从留白拖动窗口。
3. Windows 手工验证真实 idle、托盘、通知、睡眠/恢复、原生模块重建和安装包。核对系统标题栏以下的内容区可缩到 160×180，按 Alt 后不被菜单挤占；高度上限按内容宽度计算，宽矮窗口仍可操作。验证拖动留白、查看统计、返回计时器和直接继续。
4. SQLite 旧数据库升级、完成记录去重和跨日统计通过。
5. macOS 的 x64 与 ARM64 分别打包后执行 `npm run test:packaging`，用真实 `codesign` 检查最终 `.app`，并验证临时副本中的资源和原生模块遭篡改后会被拒绝；再通过 DMG 检查，以及经浏览器下载后的人工安装与首次打开。普通 CI 与发布 CI 的两个 macOS runner 执行这套签名回归，Windows 不执行。免费分发使用 ad hoc 签名并保留 hardened runtime，不提供 Developer ID 身份或公证；记录 Gatekeeper 提示和用户批准结果，不能把本地直接启动当作系统信任验收。

### 安装分发验证

当前公开下载仍为 `v0.1.0-beta.2`，不包含新增的 ad hoc 签名配置和 DMG 检查。新版尚未发布；截至 2026-11-06，自动化与人工验收状态如下：

| 平台与构建 | 构建机自动化 | 浏览器下载、安装与首次打开 |
| --- | --- | --- |
| macOS Intel x64，新增签名配置后的构建 | PR 与 push CI 的签名回归、DMG 检查通过 | 待真实 Intel Mac 验证 |
| macOS Apple Silicon ARM64，新增签名配置后的构建 | 本地完整打包、签名与 DMG 检查通过；PR 与 push CI 通过 | Chrome 下载、Finder 解压复制与安装后验签通过；已走到“仍要打开”，等待设备使用者完成系统身份认证 |
| Windows x64 | PR 与 push CI 通过；不执行 macOS 签名回归 | EXE 安装、SmartScreen 提示及真实使用仍需人工验收 |

本地自动化：Apple Silicon、macOS 26.4.1（25E253）、Node.js 24.15，源码 [5449d66](https://github.com/Jaxon1216/PomoTimer/commit/5449d66)。`npm run package -- --mac dmg --arm64 --publish never` 完整通过；lint、typecheck、120 个单元/组件测试、12 个真实 SQLite 测试和 14 个 Electron E2E 通过。最终应用验签、资源与原生 `.node` 篡改拒绝、DMG 复制后启动及清理均通过，真实 SIGINT 中断后的清理也通过。这些检查使用隔离数据目录，没有验证 Gatekeeper 的用户批准。

本地 DMG 文件名仍为 `Pomodot-0.1.0-beta.2-mac-arm64.dmg`，但它是未发布的新构建，与公开 beta.2 文件不同；SHA256 为 `60849bfc96a09affa3d451ee16c35a069d970c46f3841ef6e7deaed9cb9354fc`。

CI 自动化：源码 `5449d66` 的 [PR 检查](https://github.com/Jaxon1216/PomoTimer/actions/runs/42187712745)和 [push 检查](https://github.com/Jaxon1216/PomoTimer/actions/runs/42187706071)均在 Windows x64、macOS ARM64、macOS Intel x64 三个平台通过。PR 产物为 [ARM64 DMG](https://github.com/Jaxon1216/PomoTimer/actions/runs/42187712745/artifacts/13488491818)和 [Intel x64 DMG](https://github.com/Jaxon1216/PomoTimer/actions/runs/42187712745/artifacts/13487899158)；这些 artifact 仅用于验证，不是 GitHub Release。

浏览器与 Finder 验证：在同一台 Apple Silicon、macOS 26.4.1（25E253）上，使用 Chrome 下载源码 `56e21ef` 的 [ARM64 artifact](https://github.com/Jaxon1216/PomoTimer/actions/runs/42186699357/artifacts/13488291172)，再用 Finder 解压并将 DMG 内的应用复制到用户 Applications 下的独立测试目录。Chrome 下载产生的 quarantine 标记全程保留，安装后的完整签名检查通过。该构建与 `5449d66` 的应用代码和签名实现相同。

| 浏览器验证产物 | SHA256 |
| --- | --- |
| Chrome 下载的 artifact ZIP | `096269d80a8cd7e400390dff8a22f882129a79f216506ccdb0480022c0f2264f` |
| Finder 解压后的 ARM64 DMG | `08af3edbbd749f1020a832d9090b96f374b3a110b2db46520aca2ad4968abfb6` |

首次从 Finder 打开时，系统显示“未打开‘Pomodoro Timer’”，正文为“Apple 无法验证‘Pomodoro Timer’是否包含可能危害 Mac 安全或泄漏隐私的恶意软件”，仅有“完成”和“移到废纸篓”按钮。点击“完成”，进入“系统设置 → 隐私与安全性 → 仍要打开”，再在“打开‘Pomodoro Timer’？”确认框中选择“仍要打开”后，系统要求“使用管理员触控 ID 或输入管理员密码允许此次操作”。当前等待设备使用者本人完成认证，尚未观察到应用窗口；不能将等待中的进程视为启动成功。

人工验收交接：分支 `codex/free-mac-distribution`，实现提交 `5449d66`，[PR #6](https://github.com/Jaxon1216/PomoTimer/pull/6)。下一步为完成当前系统身份认证，确认已安装测试应用窗口出现，正常退出后再从 Finder 打开，并补录本节结果。Intel Mac 的同一路径仍需在真实 Intel 设备验证。

每条实测记录须包含 OS 版本与 build、芯片、源码 commit、安装包版本与 SHA256、下载方式、完整系统提示，以及首次批准、再次启动和开始/暂停的结果。macOS 15 及以上通过“系统设置 → 隐私与安全性”批准可信应用；不存在入口或出现损坏、恶意软件提示时，记录实际失败并继续诊断，不以全局关闭安全保护作为通过条件。CI 的自动启动与签名验证结果应单独记录。

### 窗口拖动验证记录

2026-11-05，在 Apple Silicon、macOS 26.4.1（25E253）、Electron 33.4.11 的本地开发构建上，通过系统鼠标事件拖动独立测试窗口的四条边和右下角。收窄至 160 px 或在宽 160 px 时拉高，内容高度均止于 240 px。在 160×180 窗口中实际点击开始、暂停、继续、统计和更多均成功，拖动圆环也能移动窗口。Windows 真机的窗口边框和拖动手感待验收。

## Phase 2：本地摄像头在场

仅在 Phase 1 发布门通过后实现。Renderer 在显式授权和 OS permission 后本地处理帧，只发送布尔 presence；不做身份识别、医疗判断或强活体反欺骗。失败时回退输入检测并可见提示。

## Phase 3：手动站立专注与产品硬化

可增加手动站立预设、可访问性审计、Developer ID 及 Windows 发布者签名、macOS 公证、更新和有界诊断；不推断实际姿态或健康结果。Phase 1 的免费 ad hoc 签名不包含这些身份与公证服务。任何账号、云同步、日历和 Linux 支持都需单独需求确认。

# 番茄钟设计文档

首次了解产品可先读[项目首页](../README.md)；准备开发时，先确认[协作约定](../AGENTS.md)、[最近的改动](../CHANGELOG.md)和 [Phase 1 发布门](./roadmap.md#phase-1-发布门)，再按问题查阅下表。

| 要确认的问题 | 从哪里看 |
| --- | --- |
| 用户会看到什么，怎样判断行为正确？ | [产品规格](./product-spec.md)含计时状态机、设置、界面、故障与验收场景。 |
| 现在做什么，还有哪些真机检查？ | [路线图](./roadmap.md)区分当前阶段、发布门和后续阶段。 |
| 谁持有计时状态，谁能读写数据库？ | [技术架构](./architecture.md)定义进程职责、时间来源和测试边界。 |
| 可以发送哪些命令和事件？数据怎样保存？ | [IPC 与持久化契约](./contracts.md)列出接口、快照、事件和数据库模型。 |
| 一个界面操作怎样传到 Main 并返回？ | [前端请求流程](./request-flow.md)追踪命令、采样和统计，并说明原生窗口缩放。 |
| 为什么采用这样的节奏和隐私边界？ | [研究与决策](./research-and-decisions.md)记录证据、取舍和重新评估条件。 |
| 如何给跨进程和状态机代码写注释？ | [代码注释约定](./code-commenting.md)含格式和示例。 |
| 字体和视觉参考从哪里来？ | [第三方声明](./third-party-notices.md)说明素材来源。 |

固定原则：本地离线、macOS/Windows 首发、默认 `30/5/30/5/30/10`、输入只传递闲置秒数、不记录敏感输入或相机内容、完成专注才统计、失败检测不伪造可靠 presence。

## 产品截图

以下截图取自 macOS 26.4.1（Apple Silicon）上的真实 Electron 测试窗口，使用独立临时数据目录。计时器的三张截图来自当前开发版。设置和统计截图取自较早的提交，当时的包版本为 `0.1.0-beta.2`。[历史截图对应提交 f90e522](https://github.com/Jaxon1216/PomoTimer/commit/f90e5228f04fa2105de747dfa5681daad079ad52)

| 界面 | 可查看的状态 |
| --- | --- |
| [初始计时器](./assets/screenshots/timer-light.png) | 第一轮专注，等待用户开始。 |
| [拖小窗口](./assets/screenshots/long-break-waiting-compact.png) | 220×240 小窗等待开始 10 分钟活动休息，测试的闲置阈值为 600 秒。 |
| [最小窗口](./assets/screenshots/drag-minimum-interrupted-break.png) | 在 160×180 的窗口中，短休因输入暂停，可直接点击圆形播放按钮继续。 |
| [设置](./assets/screenshots/settings-dark.png) | 切换到深色主题，开启常驻顶部。 |
| [统计](./assets/screenshots/stats-dark.png) | 独立测试数据中还没有完成的专注轮。 |

在仓库根目录运行 `npm run test:e2e`，可从 `apps/desktop/test-results/` 的对应测试输出中取同名文件。截图用例见[桌面 E2E](../tests/e2e/phase0.e2e.ts)。界面有可见变化时，只更新受影响的图并核对内容、平台和版本。这里仅收录用于描述产品的截图，完整运行日志和诊断图保留在测试输出目录。

## 安装包与预发布

安装包发布在 [GitHub Releases](https://github.com/Jaxon1216/PomoTimer/releases)：Windows x64 使用 EXE 安装向导，Apple 芯片与 Intel Mac 分别使用对应 DMG。

发版前，把[变更记录](../CHANGELOG.md)的 `Unreleased` 条目整理到与 tag 对应的版本段（例如 `## [0.1.0-beta.2]`），填写「改动」和「已知问题」。[发布脚本](../scripts/prepare-release.mjs)会读取这个版本段，和安装包链接一起生成 GitHub 发布说明。

推送与根目录及 desktop package version 一致的 `v*` tag，会触发 Release 工作流。三个平台分别运行检查、E2E、安装包构建及打包应用启动测试；macOS 还检查签名和 DMG 内的应用。全部成功后才上传 SHA256SUMS 并发布预发布版本。

当前源码的 macOS 免费分发配置使用 ad hoc 签名并保留 hardened runtime。ad hoc 不含 Developer ID 身份，也不提供公证；完整性校验通过不代表 Gatekeeper 会自动允许运行。上游 Electron 运行时、嵌套可执行代码和原生模块需要随最终应用一起验证。公开 beta.2 包未包含这次配置与验证改动，不能用新构建结果替它背书。

在 macOS 的仓库根目录先打包，再运行以下检查；路径参数应指向本次构建产物：

```sh
npm run package
npm run test:packaging
node scripts/smoke-packaged.mjs
node scripts/verify-mac-signature.mjs "/path/to/Pomodoro Timer.app"
node scripts/smoke-mac-dmg.mjs "/path/to/Pomodot-version-mac-arch.dmg"
```

`test:packaging` 仅在 macOS 执行，默认读取已构建的当前架构 `.app`；也可用 `npm run test:packaging -- "/path/to/Pomodoro Timer.app"` 指定路径。它调用真实 `codesign` 验证原包，复制到临时目录后分别篡改签名覆盖的资源与原生 `.node` 模块，并断言验签拒绝这些副本。测试不会修改原包。

`verify-mac-signature.mjs` 检查最终应用的签名；`smoke-mac-dmg.mjs` 只读挂载 DMG，将应用复制到临时目录后验签并运行 Playwright 启动检查。后者不会模拟或删除 quarantine 下载标记。普通 CI 和发布 CI 的 ARM64、Intel x64 两个 macOS runner 均在打包后执行这些检查；Windows 不运行 macOS 签名回归。

上述自动化不能证明经浏览器下载后，Finder 首次打开与“隐私与安全性”的批准流程可用；这些结果必须按 OS、芯片、构建和文件校验值单独记录在[路线图](./roadmap.md#安装分发验证)。

真实系统输入、通知、锁屏、睡眠及人工安装验证仍属发布门。每次发布说明必须列出签名、公证状态和尚未修复的已知问题，不能把自动化启动测试当作平台验收。用户安装步骤和不同系统警告的处理边界见[首页](../README.md#macos-首次打开)。

## 本地原生回归

`npm run test:e2e` 使用临时数据目录启动真实 Electron，核对 Main 的 PID、实际 `userData`、窗口布局和 Tray。`npm run package` 后执行 `node scripts/smoke-packaged.mjs` 验证打包应用；macOS 开发入口另执行 `node scripts/smoke-dev.mjs`。后者通过 `npm run dev -- -- -- <Electron 参数>` 跨两层 npm 将 inspector 和 `--user-data-dir` 传给 electron-vite，验证 Vite 页面来源及 IPC，结束时关闭自己启动的进程。不能仅设置 `ELECTRON_CLI_ARGS`，因为 electron-vite CLI 会用其解析出的参数覆盖该环境变量。显式诊断启动还会在打开数据库前核对实际目录与预期目录，参数未透传时立即退出。

`npm run test:store` 重建 Electron 原生依赖，并用 Electron 的 Node 运行时验证真实 SQLite 升级、事务回滚、去重、损坏备份和 WAL 恢复；测试只使用临时数据。普通 PR 和发布 CI 都运行该命令及完整 E2E。E2E 中的锁屏事件和输入故障为受控注入，不能视为真实设备的电源、输入或通知验收。

系统级截图应依据测试实例实际 Tray 的 `getBounds()` 和 PID 归属定位。其他应用或已有真实数据实例可以继续运行，不需要全局清理进程。Chromium 模拟 API 截图仅用于布局诊断，不能替代 Electron E2E 或原生菜单栏验收。诊断日志、未精选的截图和临时数据库放在已忽略的 `test-results/` 或 `diagnostics/` 目录。

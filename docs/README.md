# 番茄钟设计文档

首次了解产品可先读[项目首页](../README.md)；准备开发时，先确认[协作约定](../AGENTS.md)、[最近的改动](../CHANGELOG.md)和 [Phase 1 发布门](./roadmap.md#phase-1-发布门)，再按问题查阅下表。

| 要确认的问题 | 从哪里看 |
| --- | --- |
| 周期、阶段和完成量有什么区别？ | [领域词汇](../GLOSSARY.md)区分当前位置、已完成专注和休息准备期。 |
| 用户会看到什么，怎样判断行为正确？ | [产品规格](./product-spec.md)含计时状态机、设置、界面、故障与验收场景。 |
| 现在做什么，还有哪些真机检查？ | [路线图](./roadmap.md)区分当前阶段、发布门和后续阶段。 |
| 谁持有计时状态，谁能读写数据库？ | [技术架构](./architecture.md)定义进程职责、时间来源和测试边界。 |
| 可以发送哪些命令和事件？数据怎样保存？ | [IPC 与持久化契约](./contracts.md)列出接口、快照、事件和数据库模型。 |
| 一个界面操作怎样传到 Main 并返回？ | [前端请求流程](./request-flow.md)追踪命令、采样和统计，并说明原生窗口缩放。 |
| 为什么采用这样的节奏和隐私边界？ | [研究与决策](./research-and-decisions.md)记录证据、取舍和重新评估条件。 |
| 如何给跨进程和状态机代码写注释？ | [代码注释约定](./code-commenting.md)含格式和示例。 |
| 本地摄像头感知做了哪些验证？ | [摄像头开发验证](./camera-presence-validation.md)记录自动化、打包检查和真机边界。 |
| 自动休息、空格和模式按钮这轮改了什么？ | [交互对齐记录](./sensing-interaction-design.md)与[修订验证](./sensing-interaction-validation.md)记录已确认规则和交付检查。 |
| 置顶、桌面跟随和交互淡化如何区分？ | [桌面挂件设计](./desktop-widget-design.md)记录已确认目标、macOS 全屏方案和待确认项，尚未实施。 |
| 字体和视觉参考从哪里来？ | [第三方声明](./third-party-notices.md)说明素材来源。 |

固定原则：本地离线、macOS/Windows 首发、默认 `30/5/30/5/30/10`、输入只传递闲置秒数、不记录敏感输入或相机内容、完成专注才统计、失败检测不伪造可靠 presence。

## 产品截图

以下截图取自 macOS 26.4.1（Apple Silicon）上的真实 Electron 测试窗口，使用独立临时数据目录。初始计时器、监控感知、准备倒数和最小休息窗口随交互修订更新；监控图使用 Chromium 模拟摄像头和真实本地模型，不采集物理摄像头。其他截图保留此前开发版本，可在对应 Git 历史中复现。[较早截图对应提交 f90e522](https://github.com/Jaxon1216/PomoTimer/commit/f90e5228f04fa2105de747dfa5681daad079ad52)

| 界面 | 可查看的状态 |
| --- | --- |
| [初始计时器](./assets/screenshots/timer-light.png) | 第一轮专注，等待用户开始。 |
| [监控感知](./assets/screenshots/camera-monitor.png) | 无脸画面识别为离开，专注自动暂停；可直接切回触控。 |
| [休息准备倒数](./assets/screenshots/break-preparation.png) | 无输入达到第 35 秒，提示 5 秒后开始，正式休息仍为完整 5 分钟。 |
| [拖小窗口](./assets/screenshots/long-break-waiting-compact.png) | 220×240 小窗等待开始 10 分钟活动休息，测试的闲置阈值为 600 秒。 |
| [最小窗口](./assets/screenshots/drag-minimum-interrupted-break.png) | 在 160×180 的窗口中，短休因输入暂停，可直接点击圆形播放按钮继续。 |
| [设置](./assets/screenshots/settings-dark.png) | 切换到深色主题，开启常驻顶部。 |
| [统计](./assets/screenshots/stats-dark.png) | 独立测试数据中还没有完成的专注轮。 |

在仓库根目录运行 `npm run test:e2e`，可从 `apps/desktop/test-results/` 的对应测试输出中取同名文件。截图用例见[桌面 E2E](../tests/e2e/phase0.e2e.ts)。界面有可见变化时，只更新受影响的图并核对内容、平台和版本。这里仅收录用于描述产品的截图，完整运行日志和诊断图保留在测试输出目录。

## 安装包与预发布

安装包发布在 [GitHub Releases](https://github.com/Jaxon1216/PomoTimer/releases)：Windows x64 使用 EXE 安装向导，Apple 芯片与 Intel Mac 分别使用对应 DMG。

发版前，把[变更记录](../CHANGELOG.md)的 `Unreleased` 条目整理到与 tag 对应的版本段（例如 `## [0.1.0-beta.2]`），填写「改动」和「已知问题」。[发布脚本](../scripts/prepare-release.mjs)会读取这个版本段，和安装包链接一起生成 GitHub 发布说明。

推送与根目录及 desktop package version 一致的 `v*` tag，会触发 Release 工作流。三个平台分别运行检查、E2E、安装包构建及打包应用启动测试；全部成功后才上传 SHA256SUMS 并发布预发布版本。打包应用的检查可在对应系统执行 `node scripts/smoke-packaged.mjs`。

当前构建没有开发者证书签名或 macOS 公证，真实系统输入、通知、锁屏、睡眠及人工安装验证仍属发布门。每次发布说明必须列出尚未修复的已知问题，不能把自动化启动测试当作平台验收。

## 本地原生回归

`npm run test:e2e` 使用临时数据目录启动真实 Electron，核对 Main 的 PID、实际 `userData`、窗口布局和 Tray。`npm run package` 后执行 `node scripts/smoke-packaged.mjs` 验证打包应用；macOS 开发入口另执行 `node scripts/smoke-dev.mjs`。后者通过 `npm run dev -- -- -- <Electron 参数>` 跨两层 npm 将 inspector 和 `--user-data-dir` 传给 electron-vite，验证 Vite 页面来源及 IPC，结束时关闭自己启动的进程。不能仅设置 `ELECTRON_CLI_ARGS`，因为 electron-vite CLI 会用其解析出的参数覆盖该环境变量。显式诊断启动还会在打开数据库前核对实际目录与预期目录，参数未透传时立即退出。

`npm run test:store` 重建 Electron 原生依赖，并用 Electron 的 Node 运行时验证真实 SQLite 升级、事务回滚、去重、损坏备份和 WAL 恢复；测试只使用临时数据。普通 PR 和发布 CI 都运行该命令及完整 E2E。E2E 中的锁屏事件和输入故障为受控注入，不能视为真实设备的电源、输入或通知验收。

系统级截图应依据测试实例实际 Tray 的 `getBounds()` 和 PID 归属定位。其他应用或已有真实数据实例可以继续运行，不需要全局清理进程。Chromium 模拟 API 截图仅用于布局诊断，不能替代 Electron E2E 或原生菜单栏验收。诊断日志、未精选的截图和临时数据库放在已忽略的 `test-results/` 或 `diagnostics/` 目录。

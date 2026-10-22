# 番茄钟设计文档

本文档集描述本项目当前的 Electron 主进程计时实现和 Phase 1 产品边界。

阅读顺序：

1. [产品规格](./product-spec.md)：用户行为、默认值、规则和验收标准。
2. [技术架构](./architecture.md)：Main、preload、React、TimerEngine 和 SQLite 的职责。
3. [IPC 与持久化契约](./contracts.md)：运行时 schema、事件和数据库模型。
4. [研究与决策](./research-and-decisions.md)：默认节奏、活动休息和隐私边界。
5. [路线图](./roadmap.md)：阶段范围和发布门。
6. [前端请求流程](./request-flow.md)：当前真实调用链。

固定原则：本地离线、macOS/Windows 首发、默认 `30/5/30/5/30/10`、输入只传递闲置秒数、不记录敏感输入或相机内容、完成专注才统计、失败检测不伪造可靠 presence。

## 安装包与预发布

安装包发布在 [GitHub Releases](https://github.com/Jaxon1216/PomoTimer/releases)：Windows x64 使用 EXE 安装向导，Apple 芯片与 Intel Mac 分别使用对应 DMG。

推送与根目录及 desktop package version 一致的 `v*` tag，会触发 Release 工作流。三个平台分别运行检查、E2E、安装包构建及打包应用启动测试；全部成功后才上传 SHA256SUMS 并发布预发布版本。打包应用的检查可在对应系统执行 `node scripts/smoke-packaged.mjs`。

当前构建没有开发者证书签名或 macOS 公证，真实系统输入、通知、锁屏、睡眠及人工安装验证仍属发布门。每次发布说明必须列出尚未修复的已知问题，不能把自动化启动测试当作平台验收。

## 本地原生回归

`npm run test:e2e` 使用临时数据目录启动真实 Electron，核对 Main 的 PID、实际 `userData`、窗口布局和 Tray。`npm run package` 后执行 `node scripts/smoke-packaged.mjs` 验证打包应用；macOS 开发入口另执行 `node scripts/smoke-dev.mjs`。后者通过 `npm run dev -- -- -- <Electron 参数>` 跨两层 npm 将 inspector 和 `--user-data-dir` 传给 electron-vite，验证 Vite 页面来源及 IPC，结束时关闭自己启动的进程。不能仅设置 `ELECTRON_CLI_ARGS`，因为 electron-vite CLI 会用其解析出的参数覆盖该环境变量。显式诊断启动还会在打开数据库前核对实际目录与预期目录，参数未透传时立即退出。

`npm run test:store` 重建 Electron 原生依赖，并用 Electron 的 Node 运行时验证真实 SQLite 升级、事务回滚、去重、损坏备份和 WAL 恢复；测试只使用临时数据。普通 PR 和发布 CI 都运行该命令及完整 E2E。E2E 中的锁屏事件和输入故障为受控注入，不能视为真实设备的电源、输入或通知验收。

系统级截图应依据测试实例实际 Tray 的 `getBounds()` 和 PID 归属定位。其他应用或已有真实数据实例可以继续运行，不需要全局清理进程。Chromium 模拟 API 截图仅用于布局诊断，不能替代 Electron E2E 或原生菜单栏验收。诊断日志、截图和临时数据库放在已忽略的 `test-results/` 或 `diagnostics/` 目录。

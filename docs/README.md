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

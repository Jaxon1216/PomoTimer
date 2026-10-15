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

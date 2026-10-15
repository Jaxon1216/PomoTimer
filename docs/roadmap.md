# 分阶段路线图

## 当前交付：Phase 1

当前实现以 Electron + React + TypeScript 为唯一运行架构，不再有 Go/Rust sidecar。代码和自动化验证已覆盖以下闭环；发布门仍需完成真实平台验证：

- 主进程唯一 TimerEngine：默认 `30/5/30/5/30/10`、开始/暂停/继续/下一轮/重置、手动暂停锁、自动暂停与恢复、睡眠/重启安全恢复。
- `powerMonitor.getSystemIdleTime()` 系统级输入采样，输入故障可见且进入手动安全回退。
- active/desk 休息策略、设置持久化与当前轮/下一轮生效边界。
- SQLite 事务迁移、完成专注记录、今日/本周/最近 52 周统计。
- 托盘、通知、关闭到托盘、置顶、事件广播、浅色/深色/跟随系统和紧凑挂件。
- 受限 preload、严格 CSP、Zod 运行时 IPC 校验、Vitest 状态机测试和 Playwright Electron E2E。

## Phase 1 发布门

1. `npm run lint`、`npm run typecheck`、`npm run test`、`npm run build` 和适用的 E2E 全部通过。
2. macOS 真实输入、托盘、通知、睡眠/恢复和最小尺寸手工通过。
3. Windows 真实 idle、托盘、通知、睡眠/恢复、原生模块重建和安装包手工通过。
4. SQLite 旧数据库升级、完成记录去重和跨日统计通过。

## Phase 2：本地摄像头在场

仅在 Phase 1 发布门通过后实现。Renderer 在显式授权和 OS permission 后本地处理帧，只发送布尔 presence；不做身份识别、医疗判断或强活体反欺骗。失败时回退输入检测并可见提示。

## Phase 3：手动站立专注与产品硬化

可增加手动站立预设、可访问性审计、签名、公证、更新和有界诊断；不推断实际姿态或健康结果。任何账号、云同步、日历和 Linux 支持都需单独需求确认。

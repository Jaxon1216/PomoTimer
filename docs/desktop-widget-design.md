# 桌面挂件交互设计

日期：2026-11-09。状态：第一轮需求已确认；新安装置顶默认值、独立淡化开关与 Dock 约束待第二轮回答，尚未实施。

本记录用于收敛设计，不代表当前安装包已具备下列功能。当前行为仍以产品规格、架构、契约和测试为准；实施时同步更新这些权威文档。

## 已确认的产品规则

| 方面 | 已确认的目标 |
| --- | --- |
| 桌面跟随 | macOS 普通桌面空间和其他应用的原生全屏空间都纳入目标，默认跟随。 |
| 常驻顶部 | 使用普通悬浮置顶，保留设置开关；与桌面跟随独立控制。 |
| 交互淡化 | 仅计时器页在鼠标离开两秒后淡化背景和辅助控件；倒计时、状态和操作保持可读可用。设置与统计页保持清晰。 |

鼠标停留在计时器上不动不触发淡化。交互淡化不属于输入在场判定，不得改变计时、自动暂停或感知模式。相关术语见[领域词汇](../GLOSSARY.md)。

“参与当前空间的显示”和“盖在其他窗口之上”分别由桌面跟随与常驻顶部决定。二者独立；取消置顶并不等于关闭桌面跟随。单个窗口跨桌面不等于在多台实体显示器上各创建一个副本。

## 当前实现与原因

基线为 `origin/main` 的 `852de26`。Main 在创建窗口和保存设置时调用 `setAlwaysOnTop`，没有调用 `setVisibleOnAllWorkspaces`，所以置顶窗口仍留在原来的桌面空间。当前依赖为 Electron 33.4.11。

对应入口：

- [窗口创建与重新打开](../apps/desktop/src/main/index.ts)：`createWindow`、`showWindow` 和 `pomodoro:update-settings`。
- [共享设置契约](../apps/desktop/src/shared/contracts.ts)：现有常驻顶部字段及严格设置校验。
- [设置持久化](../apps/desktop/src/main/store.ts)：旧设置兼容需通过真实 SQLite 验证。
- [Renderer](../apps/desktop/src/renderer/App.tsx)及[样式](../apps/desktop/src/renderer/styles.css)：页面、控件和淡化状态。

## macOS 方案证据

### 普通桌面

`setVisibleOnAllWorkspaces(true)` 可设置加入所有普通桌面空间；它与 `setAlwaysOnTop` 设置的窗口层级不同。两者的应用入口须集中在 Main，并覆盖冷启动、设置变化和窗口关闭后的重建。不要在每次无关设置保存或快照广播时重复调用。

Windows 不使用该跨桌面 API。[Electron 33 API 文档](https://github.com/electron/electron/blob/v33.4.11/docs/api/base-window.md#winsetvisibleonallworkspacesvisible-options-macos-linux)

### 原生全屏与应用入口

候选 A：普通窗口使用 `visibleOnFullScreen: true`。Electron 33.4.11 默认调用 `DockHide` 并转为 UIElement；调用链没有自动恢复。关闭全屏选项时调用 `DockShow`，转回 Foreground。不能把全屏选项当作纯显示标志，也不能承诺 Dock 和 Cmd-Tab 行为保持原样。[Spaces 实现](https://github.com/electron/electron/blob/v33.4.11/shell/browser/native_window_mac.mm#L1161-L1182)、[Dock 实现](https://github.com/electron/electron/blob/v33.4.11/shell/browser/browser_mac.mm#L451-L508)

候选 B：macOS 使用 `type: "panel"`。Electron 官方文档明确其可浮在其他应用原生全屏空间上并参与所有 Spaces；该类型通过窗口样式和集合行为实现，不要求转换整个应用的进程类型。其窗口激活方式不同，保留 Dock、Cmd-Tab、键盘输入和原生窗口控件的实际体验仍须实机验证。[窗口类型文档](https://github.com/electron/electron/blob/v33.4.11/docs/api/structures/base-window-options.md)

Panel 在 Electron 33 内会强制附加跨桌面与全屏辅助标志，不能仅靠 `setVisibleOnAllWorkspaces(false)` 关闭跟随。如采用该候选，须在关闭跟随时评估重建为普通窗口，Main 的唯一 TimerEngine 与 Store 继续存在，Renderer 重建的导航、表单和感知状态须纳入验收。

`skipTransformProcessType: true` 仅跳过进程转换，不能单凭该参数证明普通窗口可以跟随其他应用的全屏空间。当前不选屏保级强置顶，也不将参考项目的数值层级当作本项目方案。

## 第二轮待确认

1. 桌面跟随默认开启已确认；进一步建议新安装时将常驻顶部和自动淡化也默认开启，并提供三个独立开关；升级时保留已保存的置顶选择。待确认新增的默认值与开关策略。
2. 全屏跟随是否必须保留正常的 Dock 图标和 Cmd-Tab 入口。建议保留，作为候选方案的验收约束。

上述答案到达后更新本记录，再检查是否还有真正影响体验的未决选择。实施前按本次调用的 grilling 流程确认共同理解。

## 实施与验收边界

- Main 负责原生窗口类型、层级与 Spaces 行为；Renderer 只管理页面淡化与临时交互状态，不获得通用 Electron 或原生调用能力。
- 新增设置须使用严格共享 schema，兼容旧设置，并验证实际 SQLite 的读写、升级和已有选择保留；不修改已发布迁移。
- 淡化须覆盖鼠标重新进入、键盘操作、菜单、弹层、拖动和缩放。焦点、故障、暂停原因及主要操作保持清楚，不出现透明而不可操作的关键入口。
- 组件和布局检查覆盖两秒延迟、取消延迟、页面切换、最小窗口、主题和键盘访问。
- Electron E2E 覆盖开关独立性、持久化、重启、窗口重建和 Windows 原有行为。`isVisibleOnAllWorkspaces()` 仅能证明普通桌面标志，不能代替真实全屏显示验收。
- macOS 实机覆盖左右滑动、原生全屏、Split View、Dock、Cmd-Tab、焦点与输入、关闭重开，以及外接显示器各自切换桌面；分别记录 OS、构建与结果。
- 实施完成时同步 `docs/product-spec.md`、`docs/architecture.md`、`docs/contracts.md`、`docs/roadmap.md` 和 `CHANGELOG.md`，再更新本记录的状态与验证结果。

## 接续位置

分支：`codex/desktop-widget-behavior`，从最新 `origin/main` 的 `852de26` 创建。原来的 `codex/resize-to-widget` 工作区与本地修改保持原样。

已完成需求第一轮与源码调查，未改应用代码、未运行应用测试。下一步先收取第二轮回答，确定全屏与 Dock 约束，再进入 Main 的 `createWindow` 方案验证；原生显示结果必须通过独立测试实例实机确认。

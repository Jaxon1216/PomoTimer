# 桌面挂件交互设计

日期：2026-11-09。状态：两轮需求均已确认，已实现；自动化、本机原生全屏、缩放与实际 Cmd-Tab 探针通过，其余实机发布门见验证记录。

本记录保留需求和方案取舍，产品规格、架构、契约与本轮实现同步更新。当前开发改动不代表已发布安装包或真机验收全部完成，实际检查结果见[验证记录](desktop-widget-validation.md)。

## 已确认的产品规则

| 方面 | 已确认的目标 |
| --- | --- |
| 桌面跟随 | macOS 普通桌面空间和其他应用的原生全屏空间都纳入目标，默认跟随。 |
| 常驻顶部 | 使用普通悬浮置顶，保留设置开关；与桌面跟随独立控制。 |
| 交互淡化 | 仅计时器页在鼠标离开两秒后淡化背景和辅助控件；倒计时、状态和操作保持可读可用。设置与统计页保持清晰。 |

鼠标停留在计时器上不动不触发淡化。交互淡化不属于输入在场判定，不得改变计时、自动暂停或感知模式。相关术语见[领域词汇](../GLOSSARY.md)。

“参与当前空间的显示”和“盖在其他窗口之上”分别由桌面跟随与常驻顶部决定。二者独立；取消置顶并不等于关闭桌面跟随。单个窗口跨桌面不等于在多台实体显示器上各创建一个副本。

## 问题基线与实现入口

问题基线为 `origin/main` 的 `852de26`。当时 Main 在创建窗口和保存设置时仅调用 `setAlwaysOnTop`，没有跨 Spaces 行为，所以置顶窗口仍留在原来的桌面空间。当前依赖为 Electron 33.4.11，本轮选用 panel 窗口实现桌面和全屏跟随，普通悬浮置顶单独控制。

对应入口：

- [窗口创建与重新打开](../apps/desktop/src/main/index.ts)：`createWindow`、`showWindow` 和 `pomodoro:update-settings`。
- [共享设置契约](../apps/desktop/src/shared/contracts.ts)：`alwaysOnTop`、`followWorkspaces`、`autoFade` 及严格设置校验。
- [设置持久化](../apps/desktop/src/main/store.ts)：仅在读取旧设置时补缺失的新字段，兼容结果通过真实 SQLite 验证。
- [Renderer](../apps/desktop/src/renderer/App.tsx)、[局部淡化](../apps/desktop/src/renderer/use-timer-fade.ts)及[样式](../apps/desktop/src/renderer/styles.css)：页面、控件和淡化状态。
- [临时页面标识](../apps/desktop/src/shared/window-view.ts)：只允许计时器、设置和统计三个页面在重建后恢复。

## macOS 方案证据

### 普通桌面

`setVisibleOnAllWorkspaces(true)` 可设置加入所有普通桌面空间；它与 `setAlwaysOnTop` 设置的窗口层级不同。本轮还要求原生全屏跟随与正常 Dock 入口，采用下文的 panel 方案，Main 不调用该跨桌面 API。窗口策略覆盖冷启动、设置变化和关闭后的重建，不在快照广播中反复修改原生行为。

Windows 不使用该跨桌面 API。[Electron 33 API 文档](https://github.com/electron/electron/blob/v33.4.11/docs/api/base-window.md#winsetvisibleonallworkspacesvisible-options-macos-linux)

### 原生全屏与应用入口

未采用的方案：普通窗口使用 `visibleOnFullScreen: true`。Electron 33.4.11 默认调用 `DockHide` 并转为 UIElement；调用链没有自动恢复。关闭全屏选项时调用 `DockShow`，转回 Foreground。该行为不满足保留正常 Dock 和 Cmd-Tab 入口的约束。[Spaces 实现](https://github.com/electron/electron/blob/v33.4.11/shell/browser/native_window_mac.mm#L1161-L1182)、[Dock 实现](https://github.com/electron/electron/blob/v33.4.11/shell/browser/browser_mac.mm#L451-L508)

已采用的方案：macOS 在开启跟随时使用 `type: "panel"`，关闭时使用普通窗口。Electron 官方文档明确 panel 可浮在其他应用原生全屏空间上并参与所有 Spaces；该类型通过窗口样式和集合行为实现，不要求转换整个应用的进程类型。其激活方式与普通窗口不同，因此跨全屏、Dock、Cmd-Tab、键盘输入和原生窗口控件的实际体验仍列为实机发布门。[窗口类型文档](https://github.com/electron/electron/blob/v33.4.11/docs/api/structures/base-window-options.md)

Panel 在 Electron 33 内会强制附加跨桌面与全屏辅助标志，不能仅靠 `setVisibleOnAllWorkspaces(false)` 关闭跟随。因此保存跟随设置后，在下一事件循环异步重建为对应窗口类型；恢复原有位置、尺寸和当前页面，新窗口就绪后销毁旧窗口。Main 的唯一 TimerEngine 与 Store 继续存在，计划内重建暂时清空摄像头样本并签发新代次，保持用户选中的监控模式，不因旧窗口关闭而错误回退触控。

`skipTransformProcessType: true` 仅跳过进程转换，不能单凭该参数证明普通窗口可以跟随其他应用的全屏空间。当前不选屏保级强置顶，也不将参考项目的数值层级当作本项目方案。

## 已确认的默认值与应用入口

1. 新安装时常驻顶部、桌面跟随和自动淡化全部默认开启，各自提供独立开关。升级保留已保存的置顶选择；旧设置缺少新增字段时各补 `true`，已有的显式 `false` 不覆盖。
2. 全屏跟随必须保留正常的 Dock 图标和 Cmd-Tab 入口，不采用隐藏应用入口的模式。

用户已接受上述两项推荐，需求已收敛。Windows 保留普通窗口与置顶、淡化能力，桌面跟随选项不可操作；不将 macOS 的 panel 类型扩展到 Windows。

## 平台淡化策略

macOS 使用透明原生背景与局部 CSS 淡化；Windows 保留不透明原生窗口，通过表面色与辅助信息淡化。这样保留 Windows 原生缩放和最大化行为，避免 Electron 对透明可缩放窗口的限制；不调用整窗 `setOpacity`。[Electron 官方限制](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations)

## 实施与验收边界

- Main 负责原生窗口类型、层级与 Spaces 行为；Renderer 只管理页面淡化与临时交互状态，不获得通用 Electron 或原生调用能力。
- 新增设置使用严格共享 schema，只有 Store 的兼容读取 schema 补旧字段；真实 SQLite 回归覆盖读写、升级和已有选择保留，不修改已发布迁移。
- 淡化须覆盖鼠标重新进入、键盘操作、菜单、弹层、拖动和缩放。焦点、故障、暂停原因及主要操作保持清楚，不出现透明而不可操作的关键入口。
- 组件和布局检查覆盖两秒延迟、取消延迟、页面切换、最小窗口、主题和键盘访问。
- Electron E2E 覆盖开关独立性、持久化、重启、窗口重建和 Windows 原有行为。`isVisibleOnAllWorkspaces()` 仅能证明普通桌面标志，不能代替真实全屏显示验收。
- macOS 实机覆盖左右滑动、原生全屏、Split View、Dock、Cmd-Tab、焦点与输入、关闭重开，以及外接显示器各自切换桌面；分别记录 OS、构建与结果。
- 本轮同步 `docs/product-spec.md`、`docs/architecture.md`、`docs/contracts.md`、`docs/roadmap.md` 和 `CHANGELOG.md`，逐项检查结果写入[验证记录](desktop-widget-validation.md)，未执行的实机检查保持待验收。

## 接续位置

分支：`codex/desktop-widget-behavior`，从最新 `origin/main` 的 `852de26` 创建。原来的 `codex/resize-to-widget` 工作区与本地修改保持原样。

设计记录起始提交为 `3ce6176`，实现提交为 `da60f68`，本地 arm64 测试包已就绪。自动化、原生全屏和原生边缘缩放结果见[验证记录](desktop-widget-validation.md)；下一步继续桌面滑动、Split View、外接屏和 Windows 发布门，不以窗口标志代替实际操作。

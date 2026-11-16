# 桌面挂件验证记录

日期：2026-11-09。分支：`codex/desktop-widget-behavior`。基线为 `852de26`，设计记录起始提交为 `3ce6176`，实现提交为 `da60f68`。本轮功能和文档已实现，以下记录区分自动化结果、原生探针证据和仍需人工操作的发布门。

规则与实现取舍见[设计记录](desktop-widget-design.md)。本地环境为 Node.js 24.15.0、Electron 33.4.11、macOS 26.4.1（25E253）、Apple Silicon arm64。Windows 尚未在本轮使用真实设备验证。

## 自动化检查

| 命令或范围 | 结果 |
| --- | --- |
| `npm ci` | 通过，使用 Node.js 24。 |
| `npm run lint` | 通过。 |
| `npm run typecheck` | 通过。 |
| `npm run test` | 通过，222 项。 |
| `npm run test:store` | 通过，22 项真实 SQLite 测试，覆盖旧字段补值、保留已有置顶选择、独立关闭和异常类型备份。 |
| `npm run build` | 通过。 |
| `npx playwright test`（在 `apps/desktop` 执行） | 最终完整回归通过，25 项；包含本地模型的模拟摄像头检测、真实 IPC、开关独立性、重启、窗口重建及加载失败回退。 |
| `node scripts/validate-renderer-layout.mjs` | 通过；最小窗口浅色/深色淡化截图已目视检查，背景、数字、状态和主要操作符合规则。 |
| `node scripts/validate-macos-spaces.mjs` | 通过；最后一轮以 `POMODORO_SPACES_EXECUTABLE` 指定实际打包应用，验证全屏、边缘拖动及真实 Cmd-Tab。 |
| `npm run package` | 通过，生成本地 arm64 应用与 DMG。 |
| `node scripts/smoke-packaged.mjs` | 通过，独立临时数据目录验证打包应用启动、SQLite、真实托盘、IPC、计时操作和统计。 |
| `hdiutil verify apps/desktop/dist/Pomodot-0.1.0-beta.2-mac-arm64.dmg` | 通过，磁盘镜像校验有效。 |

本轮开发包沿用 `0.1.0-beta.2` 包版本，没有创建发布 tag，也未签名或公证。DMG 位于本地 `apps/desktop/dist/`；SHA-256 为 `f62fe2a3ca6466dd2a77186c97eadb7673e14db427500b56caaf08cb19b3696a`。Main 构建文件 SHA-256 为 `33d9e8274a06f1b6d9374a802aed2fd5d725249e9d222208d37db88ec8b76a29`。

## 原生全屏、拖动与 Cmd-Tab 证据

在上述 macOS 环境中，脚本分别启动隔离 Electron 实例和自建的普通 AppKit 测试应用。测试应用进入真正的原生全屏并成为活跃应用后，Window Server 的当前屏幕可见列表仍包含精确的计时器窗口 ID；计时器实际层级为普通 floating 的 `3`，高于全屏测试窗口的 `0`，且其边界完整落在同一显示器的全屏区域内。Electron 的 Dock 可见状态前后均为 `true`。

原生输入权限原本已可用，脚本没有请求新权限。向自身计时器窗口边缘发送系统鼠标拖动后，内容尺寸由 `360×478` 增长至 `440×478`，再通过右下角拖动收缩至最小的 `160×180`。该结果验证了本机透明 panel 的真实边缘缩放，而不是仅调用 `setContentSize`。

同轮对实际打包的产品应用（bundle ID 为 `com.easton.pomodotimer`）执行了真正的 Cmd-Tab：先依次激活两个自建进程并确认，再发送完整的 Command+Tab 键序列，产品应用随后实际变为 active，Dock 状态仍为 `true`。脚本仅对产品 bundle ID 运行此检查，避免开发 Electron 共享 bundle ID 时切换器聚合到其他实例；无现成输入权限时明确跳过并不申请权限。

机器可读证据保存在本地忽略目录 `test-results/macos-spaces/result.json`。脚本不截取桌面图像、不输出其他进程窗口信息；结束时关闭自己的实例和全屏探针，并清理临时数据目录。这些证据不替代滑动手势、Split View 或外接屏的实际操作检查。

## 本轮锁定的失败回归

- 新窗口加载失败时恢复仍可见的旧窗口及其 IPC、媒体权限和摄像头就绪状态，提示可重试错误。已验证再次保存可成功切换窗口，计时进度与设置页保持。
- 页面 fragment 导航会触发 Electron 的 `did-start-loading`，却不触发 `did-finish-load`。初轮完整 E2E 暴露此路径使摄像头就绪门禁无法恢复；现仅在主 frame 的非同文档 `did-start-navigation` 中失效就绪。最终回归验证页面内导航保持检测代次，真实 reload 更新代次并拒绝旧报告。

## 仍需人工操作的发布门

| 场景 | macOS | Windows |
| --- | --- | --- |
| 常驻顶部独立开关、重启与关闭重开 | Electron E2E 通过，日常交互待验收 | 待验收 |
| 左右滑动切换普通桌面空间 | 手势待验收；原生全屏另有探针证据 | 不适用：本轮不增加 Windows 跨桌面能力 |
| 其他应用原生全屏 | 独立原生探针通过；常用应用体验待验收 | 不适用 |
| Split View、关闭跟随后撤销及重新开启的真实显示 | 待验收；开关与重建自动化通过 | 不适用 |
| Dock、Cmd-Tab 和窗口激活 | 实际打包应用的 Cmd-Tab 与 Dock 状态均通过；日常键盘交互待验收 | 不适用 |
| 外接屏下各屏切换 Spaces，保持单一计时器 | 待验收 | 不适用 |
| 跟随切换保持位置、尺寸、页面、计时，监控模式等待新样本 | 重建/导航/计时 E2E 通过；物理摄像头待验收 | 不适用：无该窗口重建开关 |
| 两秒局部淡化与恢复，设置统计不透明 | 组件、布局和 Electron E2E 通过；日常体验待验收 | Chromium 布局模拟不代表 Windows 真机通过 |
| 原生边缘缩放、最小窗口、交通灯及点击区域 | 本机原生边缘缩放通过；其余日常操作待验收 | 原生标题栏、缩放、最大化和点击区域待验收 |
| 安装包、托盘隐藏/重开、睡眠恢复 | arm64 打包启动通过；签名、公证和人工安装未完成 | 待验收 |

## 接续位置

本轮实现、回归和本地 arm64 测试包已就绪；继续使用 `codex/desktop-widget-behavior`。后续按[路线图发布门](roadmap.md#桌面挂件发布门)执行桌面滑动、Split View、外接屏和 Windows 检查，并分别补 OS、架构、构建及实际结果。原工作区的无关修改保持原样。

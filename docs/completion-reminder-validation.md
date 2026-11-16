# 无声完成提醒与窗口层级验证

日期：2026-11-10。分支：`codex/visibility-reminder-design`，基线 `7e350c3`，设计记录起点 `7e68444`。规则与范围见[设计记录](visibility-and-completion-reminder-design.md)。

本轮本机为 macOS 26.4.1（25E253）、Apple Silicon arm64、Node.js 24.15.0、Electron 33.4.11。只启动独立临时数据目录及合成测试窗口，不读取或修改用户数据库，不记录其他应用的内容。

## 自动化检查

| 范围 | 本轮结果 |
| --- | --- |
| `npm ci` | 通过，使用 Node.js 24。 |
| 计时元数据测试 | 先红 9 项，再通过；仅成功自然完成更新完成身份和时间，跳过/重置/重启排除，持久化失败可重试。 |
| 完成卡片 Electron 回归 | 基线先红：自然完成后等待 5 秒仍没有提醒窗口；实现后两项通过，覆盖隐藏主窗、其他窗口继续输入、无系统完成通知、独立 preload、替换/旧确认、锁屏、开关和重启。 |
| `npm run lint`、`npm run typecheck` | 通过。 |
| `npm run test` | 通过，280 项；包括提醒 IPC 来源/严格字段、旧确认、加载失败恢复、生命周期、组件替换与读取竞态。提醒原生操作错误隔离另先红 8 项，再通过，覆盖 show/hide/send/layout/teardown 和错误提示失败。 |
| `npm run test:store` | 通过，22 项真实 SQLite 检查；本轮没有修改迁移或持久化结构。 |
| `npm run test:e2e` | 通过，27 项完整 Electron 回归，含模拟摄像头、本地模型和本轮两项卡片用例。 |
| `npm run build` | 通过；两个 preload 均自包含，沙箱受限 require 模拟仅加载 `electron`。 |
| `node scripts/smoke-dev.mjs` | 通过，真实 `npm run dev`、隔离目录及开发 URL 下的提醒显示/确认和专用桥接。 |
| 实际打包应用的卡片回归 | 两项通过；在 `apps/desktop` 执行 `POMODORO_REMINDER_EXECUTABLE="<本次 app 内的绝对可执行路径>" npx playwright test completion-reminder.e2e.ts`，直接使用 `dist/mac-arm64/Pomodoro Timer.app`，没有使用开发入口。 |
| 340×240 提醒布局 | 浅色/深色专注、深色休息及确认失败重试状态均目视检查，正文、时间与按钮可见，无横纵溢出或控制台错误；此项为 Chromium 布局检查。 |

## 置顶原生探针

`node scripts/validate-window-layering.mjs` 使用独立 AppKit 普通窗口与当前计时器实际窗口 ID，检查重叠后的 Window Server 顺序、两者层级及合成应用的活跃/键盘焦点；不把 `isAlwaysOnTop` 标志当作可见性证明。`--negative-control` 关闭计时器置顶，同一遮挡断言应失败。

基线冷启动、无关设置保存、置顶关闭/开启及 12 次其他应用激活均通过：计时器层级为 3，普通探针为 0；探针保留活跃及键盘焦点。反例退出码为 1，明确检出普通应用覆盖计时器。用户原始间歇遮挡未复现，因此未作推测性窗口层级修改。

最终命令结果：默认 panel 的 `node scripts/validate-window-layering.mjs` 通过 20 项，`--no-follow` 普通窗口通过 21 项，`--with-reminder` 通过 5 项，`--negative-control` 按预期退出 1。生命周期覆盖隐藏/被动显示、最小化/恢复、模拟 suspend/resume 和关闭重建；显式用户恢复或重新打开允许取得焦点，与被动显示的严格焦点断言分开记录。

提醒探针等待实际“专注完成”/“休息结束”标题和“知道了”按钮，再按真实确认 IPC 隐藏卡片；下一轮在自建 AppKit 应用原生全屏中自然完成，确认复用了同一原生窗口且提醒 ID 更新。桌面与全屏均实际重叠、在屏、floating 层级 3 高于普通窗口 0，其他应用仍活跃且保持 key window；产品应用未被激活。测试只使用自建两个进程。机器可读证据位于本地忽略目录 `test-results/macos-layering/`。

## 本地测试包

`npm run package` 已生成并完成 ad hoc 签名的 Apple Silicon 应用，应用签名验证通过，上述实际应用卡片回归也通过。但 DMG 阶段失败：`hdiutil resize` 持续返回“资源暂时不可用”（退出 35）；此命令整体记为失败，不记作安装器通过。已卸载本次失败任务拥有的临时磁盘映像，没有处理其他任务的磁盘。

另外使用 `ditto` 保留资源元数据，生成本地 ZIP 预览包 `apps/desktop/dist/Pomodot-reminder-preview-mac-arm64.zip`；它沿用 `0.1.0-beta.3` 版本，仅供本地验证，没有发布 tag 或远程发布。SHA-256：`16338c94cbaf0e347b01af4dbaaa43eca9c99125b9ff7cadd6475e822fac7f2c`。ZIP 解压后的签名校验通过；此包不替代 DMG/Windows 安装器发布门。

## 尚未完成的真实场景

桌面滑动手势、Split View、外接屏与特定应用交互，以及 Windows 原生窗口、焦点和安装包检查仍须分别记录真实 OS、构建及结果。注入的锁屏/睡眠事件不等同真实系统电源操作；本机合成探针通过也不代表原始间歇遮挡已解决。

## 1 分钟专注范围补充

2026-11-10，按用户调试需要，将专注设置从 5–120 分钟扩展为 1–120 分钟。默认仍为 30 分钟，已分配的当前轮次保持原时长，新设置从下一轮专注生效；共享 IPC/Store schema 的下限同步为 60 秒，不修改数据库结构或计时迁移。

契约与表单回归先红 6 项、再通过；真实 SQLite 新用例先因 300 秒下限拒绝重载，再通过。最终 `npm run lint`、`npm run typecheck`、`npm run test`（290 项）、`node scripts/test-store-native.mjs`（23 项）、`npm run build` 和 `npx playwright test completion-reminder.e2e.ts`（3 项）通过。状态机覆盖当前轮不缩短、下一轮 60 秒、暂停不扣时间及自然完成只记录一次；Electron 用真实设置表单保存 1 分钟，注入测试进程的单调时间源完成 60 秒专注，验证完成卡片、1 分钟统计及重启后设置保留。全部使用独立测试数据，不改变用户正在运行的轮次。

# 大站与完成提醒整合验证

日期：2026-11-16。分支：`codex/standing-break`。本记录区分远端主线合并、联合源码检查与本机安装交付，不替代 Windows 或真实摄像头／电源事件验收。

小窗入口修正构建 `0.1.0-beta.3-standing-entry.28ef106` 的历史记录见文末。当前本机版本见[大站休息验证记录](standing-break-validation.md)。

## 问题与合并范围

用户记得专注完成后出现独立弹窗。核对实际安装包发现：先前安装版含 `reminder.html`、独立提醒 preload 和提醒 IPC；本地大站构建 `0.1.0-beta.3-standing.dbbb634` 只有系统通知逻辑。原因是大站与提醒分别基于 `7e350c3` 开发，提醒所在 PR 当时未合入主线，单独打包大站遗漏了该功能。

按用户授权，[PR #10](https://github.com/Jaxon1216/PomoTimer/pull/10) 已合入 `main`，合并提交为 `9832a2151ef0cf918bfdc7381b6529719674d493`，提醒分支 head 为 `ff853240e5c7c451df7f5a8ea776ecfae8f6118c`。合并前核对对应 PR CI 已成功；主线合并没有绕过保护规则。随后将 `origin/main` 合入大站分支，保留两项功能及 1 分钟专注设置。

## 冲突处理

- Main 保留单向 `publishSnapshot → syncCamera(snapshot)`，再展示已经成功提交的轮次完成卡片；不恢复旧的递归摄像头广播链。
- TimerEngine 同时保留大站 `hasStarted`、实际来源 `none`、手动恢复，以及只在持久化成功后产生的进程内完成元数据。跳过、重置、失败提交和重启不补发卡片。
- 专注下限采用主线的 60 秒，保留两个可空大站时长字段，默认休息模式继续只允许 `active/desk`。
- 保留提醒独立 session、严格 sender 校验及自包含 preload；计时窗口和提醒窗口权限不互相扩大。构建同时输出两个 renderer HTML 和两个 preload。
- 用户文档及变更记录同时描述准备期大站和独立无声卡片；完成卡片不会控制后续轮次或抢走键盘焦点。

## 联合检查

环境：macOS 26.4.1（25E253）、Apple Silicon arm64、Node.js 24.15.0、Electron 33.4.11。所有自动化使用独立数据目录；摄像头用受控媒体源，时间推进仅修改隔离测试 Main 的单调时钟，不修改真实用户计时。

| 检查 | 结果与范围 |
| --- | --- |
| `npm run lint`、`npm run typecheck` | 通过。 |
| `npm test` | 336 项通过，14 个文件；包含默认／自定义短长大站与持久化失败重试的完成元数据联合回归。 |
| `npm run test:store` | 38 项真实 SQLite 检查通过；1 分钟专注与大站设置、恢复和检查点隐私均保留。 |
| `npm run build` | 通过；输出主页面、提醒页面及两个自包含 preload。 |
| 联合 Electron 用例 | 1/1 通过；专注完成卡片未确认时进入大站，大站自然完成更新同一卡片，摄像头恢复新代次，专注统计仍只增加一次。 |
| 全量 Electron 回归 | 完整诊断曾 32/32 通过；移除诊断后的最后一轮按用户要求停止，不计为通过。具体异常与证据见下文。 |
| ARM64 打包与静态核对 | 本地版本 `0.1.0-beta.3-standing-reminder.52a3194` 构建成功；应用完整签名及 DMG 校验通过；ASAR 同时含提醒页面、独立 preload、提醒 IPC 和大站命令。 |
| 本机替换与打开 | 已从上述 DMG 安装到 `/Applications/Pomodoro Timer.app`，安装 ASAR 与构建一致；正常打开原有计时页面，11 条原有专注记录全部保留。 |

全量前两轮为 31/32、30/32。既有缩放用例的几何检查通过，但读取到意外的手动暂停；第二轮另有长时长设置／切轮断言失败。trace 未能确定额外操作的来源，不能据此声称已找到根因。未修改产品实现或放宽断言：缩放用例独立连续复跑 5/5、相关三个用例按序连续复跑 9/9 通过，随后继续完整序列诊断，最终结果补充在上表。

完整诊断一轮 32/32 通过，下一轮纯内存记录中，缩放与长时长用例均通过且没有额外业务命令；两个提醒用例却在卡片产生前未能建立原生窗口焦点。随后 CUA 实际返回 Mac 已锁屏，需要用户手动解锁。此证据解释了当时无法完成焦点前置检查，不能倒推为前期意外暂停的已证实根因。测试明确建立探针焦点后仍保留卡片出现后的全部焦点断言；此准备步骤使用 [Electron `app.focus`](https://www.electronjs.org/docs/latest/api/app#appfocusoptions)。临时命令与 DOM 诊断均已移除。用户解锁后启动最终回归，随后用户明确要求“不用测了”，因此停止该轮并关闭其隔离测试进程；不再运行后续测试。

## 本机安装交付

源码整合提交：`52a31946ce5b7b4f106f20ba86a409c9275a32e6`（父提交为此前大站记录 `93fd020` 与主线合并 `9832a21`）。本地构建通过 `extraMetadata.version` 标记版本，不修改源码包版本，不创建发布 tag。

| 产物 | SHA-256 |
| --- | --- |
| `apps/desktop/dist/Pomodot-0.1.0-beta.3-standing-reminder.52a3194-mac-arm64.dmg` | `f12baedd7646fada535b60f0f66ea8f22a1312b34834c9e03e02431360daa7b4` |
| `apps/desktop/dist/mac-arm64/Pomodoro Timer.app/Contents/Resources/app.asar` | `6eda98e91096f04283dc5d8fc7ca28e02f6ad4359788d89cd107d05d3e602033` |

旧的 `apps/desktop/dist` 已移到 `~/.Trash/Pomodot-old-packages-6r8y5q03`，没有清空废纸篓。用户解锁后经 CUA 正常退出旧应用，再从上述 DMG 复制并替换 `/Applications/Pomodoro Timer.app`；安装版本为 `0.1.0-beta.3-standing-reminder.52a3194`，安装 ASAR 的 SHA-256 与上表一致，签名核对成功。旧应用保留于 `~/.Trash/Pomodot-old-installed-app-637kriu_/Pomodoro Timer.app`。

替换前已将真实用户数据目录中的 SQLite 备份到忽略目录 `diagnostics/installed-data-backup-t1uxfn9v`；正常退出后没有待备份的 WAL/SHM。应用数据目录仍为 `~/Library/Application Support/@pomodoro/desktop`。正常启动后只读比较备份与现库，原有 11 条专注记录全部保留；没有重置真实计时、设置或统计。CUA 观察到已安装 ASAR 的正常计时页面，显示第 3/3 轮专注、30:00 准备状态，应用保持打开。

用户停止测试后，没有运行计划中的最终 DMG 复制安装冒烟套件及实包提醒／大站 E2E。上述直接安装、签名／哈希确认及正常打开仅记录本机交付结果，不代替这些未执行的套件或完整真机验收。

## 接续位置

远端 `main` 已包含 PR #10；大站源码整合位于 `codex/standing-break` 的 `52a3194`，本机也已更新到对应整合版本。按用户要求停止后续测试，本次本地安装交付完成。若后续明确要求恢复回归，再运行全量 Electron、DMG 冒烟及实包提醒用例；不要将本次已停止的检查记作通过。

## 后续：小窗准备期的大站入口

用户反馈准备倒数时看不到大站提示。只读观察本机旧版：当前是已经开始过的长休，剩余 `05:28`、`hasStarted=true`，显示的是“无输入 40 秒继续休息”，此状态按已确认规则不再提供转换入口。另外，小窗宽度小于 320 px 或高度小于 360 px 时，旧 CSS 也会在首次准备期隐藏直接按钮，只保留未展开菜单中的入口，存在发现性问题。

修正提交 `28ef106b63fd9c19d8c513c5f8448dccc71aff6f` 仅调整 Renderer：将同一个直接按钮移到轮次标题旁，小窗显示「开始大站」，常规布局显示「已站立，开始大站」，不再隐藏按钮。菜单入口、可访问名称、原命令与首次准备期条件保持一致，没有变更 TimerEngine、IPC 或数据库。

按用户此前要求，本次没有运行测试套件，也没有重置或跳过真实轮次来演示入口；仅完成生产构建与本机替换。ARM64 DMG 构建成功，版本为 `0.1.0-beta.3-standing-entry.28ef106`，已安装到 `/Applications/Pomodoro Timer.app` 并正常打开，原长休 `05:28` 进度保留。由于该轮已经开始，当前页面仍不显示大站按钮；首次准备期的实际布局本轮未另行验证。

- DMG：`apps/desktop/dist/Pomodot-0.1.0-beta.3-standing-entry.28ef106-mac-arm64.dmg`，SHA-256 `1e6936d46dbd16915bf2acb9b41fb170757ffd2fd18be8b911a769f0fb9238c5`。
- 安装 ASAR：SHA-256 `8267f42edeef199cdfe7e459e69bf1ed9924495d05a2547e44c4c3368df47890`，与构建及 DMG 复制结果一致。
- 用户 SQLite 备份：忽略目录 `diagnostics/installed-data-backup-qrg706hl`；安装流程未改动真实用户数据目录。
- 旧安装包目录：`~/.Trash/Pomodot-old-packages-a8d5gc63`；旧应用：`~/.Trash/Pomodot-old-installed-app-zb2d2te8/Pomodoro Timer.app`。没有清空废纸篓。

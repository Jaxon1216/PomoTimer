# 大站与完成提醒整合验证

日期：2026-11-16。分支：`codex/standing-break`。本记录区分远端主线合并、联合源码检查与本机安装交付，不替代 Windows 或真实摄像头／电源事件验收。

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
| 全量 Electron 回归 | 完整诊断曾 32/32 通过；最终移除诊断后的回归等待 Mac 解锁。具体异常与证据见下文。 |
| ARM64 打包与静态核对 | 本地版本 `0.1.0-beta.3-standing-reminder.52a3194` 构建成功；应用完整签名及 DMG 校验通过；ASAR 同时含提醒页面、独立 preload、提醒 IPC 和大站命令。 |

全量前两轮为 31/32、30/32。既有缩放用例的几何检查通过，但读取到意外的手动暂停；第二轮另有长时长设置／切轮断言失败。trace 未能确定额外操作的来源，不能据此声称已找到根因。未修改产品实现或放宽断言：缩放用例独立连续复跑 5/5、相关三个用例按序连续复跑 9/9 通过，随后继续完整序列诊断，最终结果补充在上表。

完整诊断一轮 32/32 通过，下一轮纯内存记录中，缩放与长时长用例均通过且没有额外业务命令；两个提醒用例却在卡片产生前未能建立原生窗口焦点。随后 CUA 实际返回 Mac 已锁屏，需要用户手动解锁。此证据解释了当时无法完成焦点前置检查，不能倒推为前期意外暂停的已证实根因。测试明确建立探针焦点后仍保留卡片出现后的全部焦点断言；此准备步骤使用 [Electron `app.focus`](https://www.electronjs.org/docs/latest/api/app#appfocusoptions)。临时命令与 DOM 诊断均已移除，待解锁后运行最终原样回归。

## 本机安装交付

源码整合提交：`52a31946ce5b7b4f106f20ba86a409c9275a32e6`（父提交为此前大站记录 `93fd020` 与主线合并 `9832a21`）。本地构建通过 `extraMetadata.version` 标记版本，不修改源码包版本，不创建发布 tag。

| 产物 | SHA-256 |
| --- | --- |
| `apps/desktop/dist/Pomodot-0.1.0-beta.3-standing-reminder.52a3194-mac-arm64.dmg` | `f12baedd7646fada535b60f0f66ea8f22a1312b34834c9e03e02431360daa7b4` |
| `apps/desktop/dist/mac-arm64/Pomodoro Timer.app/Contents/Resources/app.asar` | `6eda98e91096f04283dc5d8fc7ca28e02f6ad4359788d89cd107d05d3e602033` |

旧的 `apps/desktop/dist` 已移到 `~/.Trash/Pomodot-old-packages-6r8y5q03`，没有清空废纸篓。CUA 正常退出旧安装应用时返回 Mac 已锁屏；已请求用户手动解锁。当前 `/Applications/Pomodoro Timer.app` 仍为 `0.1.0-beta.3-standing.dbbb634`，尚未替换，现有用户数据未修改。

待解锁后运行最终全量 Electron 回归、最终 DMG 复制安装冒烟与实包提醒／大站联合场景；然后正常退出旧应用，备份现有 SQLite/WAL/SHM，替换应用并核对历史记录保留。实际交付结果在执行后补充。

## 接续位置

远端 `main` 已包含 PR #10；大站源码整合位于 `codex/standing-break` 的 `52a3194`。解锁后先正常退出旧安装应用，再在 `apps/desktop` 运行 `npx playwright test --output=/tmp/pomodot-standing-reminder-final`；通过后运行 `node scripts/smoke-mac-dmg.mjs <上述 DMG>`，将 `POMODORO_REMINDER_EXECUTABLE` 指向最终产物执行 `completion-reminder.e2e.ts`，最后按已有忽略目录中的安装备份流程替换。本机应用更新完成前不将主线合并等同于安装交付。

# 大站休息验证记录

日期：2026-11-15。分支：`codex/standing-break`。实现前提交：`16162e7`，功能提交：`dbbb634`。本轮已生成并安装本地构建 `0.1.0-beta.3-standing.dbbb634`，未改变公开 beta.3 安装包、源码版本或发布 tag。行为与取舍见[设计记录](standing-break-design.md)，传播材料见[调研记录](standing-break-research.md)。

后续已整合完成提醒并修正小窗的大站直接入口，当前本机版本为 `0.1.0-beta.3-standing-entry.28ef106`，最新交付及检查边界见[大站与完成提醒整合验证](standing-reminder-integration-validation.md)。下文保留本轮历史记录。

## 执行环境

- macOS 26.4.1（25E253），Apple Silicon / arm64。
- Node.js 24.15.0，Electron 33.4.11；本分支的开发构建、本地 ARM64 DMG 和安装后的应用。自动化使用独立临时 `userData`，正式替换后启动使用原用户数据目录。
- 摄像头 E2E 使用 Chromium 模拟媒体流和打包在构建中的真实本地模型；输入、锁屏与时间推进使用受控注入，不读取真实输入内容，不使用用户数据库。

## 自动化结果

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| `npm ci` | 通过 | 使用锁文件安装，Node 24。 |
| `npm run lint` | 通过 | Main、共享契约和 Renderer 的静态检查。 |
| `npm run typecheck` | 通过 | 严格 Main/preload/Renderer 类型检查。 |
| `npm test` | 264 项通过，10 个文件 | 含准备期大站、严格契约、组件表单与既有行为回归。 |
| `npm run test:store` | 37 项通过 | 重建 Electron 原生依赖；旧设置兼容、检查点恢复、事务和隐私边界。 |
| `npm run build` | 通过 | 构建 Main、preload、Renderer 和本地摄像头资源。 |
| Electron 大站专项 | 3 项通过 | 准备期选择、最小窗口与最长值、摄像头释放及自然完成后的恢复。 |
| `npm run test:e2e` | 全量 28/28 通过 | 覆盖摄像头、原生窗口、布局、设置、计时、统计和本轮大站。 |
| 本地 ARM64 DMG 打包 | 通过 | 仅以构建参数覆盖版本为 `0.1.0-beta.3-standing.dbbb634`，保持源码版本和应用标识。 |
| `node scripts/smoke-mac-dmg.mjs <本轮 DMG>` | 通过 | 只读挂载、复制安装、严格签名和原生 SQLite 校验；离线摄像头本地推理、托盘、挂件和设置操作。 |
| 使用本轮包执行摄像头大站 E2E | 1/1 通过 | 大站释放媒体流、重载保留偏好、自然归零后恢复新检测代次。 |
| `/Applications` 替换与正常启动 | 通过 | 从本轮 DMG 复制，安装后再次验签及核对 ASAR 哈希；正常打开并在原生窗口确认安装路径。 |

状态机和组件用例先取得新增场景失败，再完成实现。实际 SQLite 用例先验证旧设置缺少新字段失败，再补读取兼容。当前原生数据库四条迁移及校验和保持，未改写已发布迁移。

全量首轮发现 320×300 普通休息准备布局被直接入口挤压，圆环内文字越界。已在高度不足 360 px 时改用更多菜单入口，360×478 保留直接按钮；原失败用例及全量重跑通过，没有放宽几何断言。最终设置说明文案变更另补组件检查，并重建后复查设置最小窗口与大站准备入口。

## 本轮覆盖

- 大站入口仅在普通休息未开始时提供；原有无输入阈值和最后 10 秒倒数不延长。正式开始后，即使零耗时暂停或重启，也不能重新选择大站；显式重置恢复准备期。
- 短休、长休默认分别跟随普通设置两倍，独立自定义或恢复跟随。严格拒绝非整分钟、越界值、未知字段、全局大站默认和非法命令。
- 大站不受输入活动／闲置／故障、摄像头三态或感知设置切换控制；暂停、睡眠、锁屏和重启冻结，须手动继续，离线时间不补计。
- 真实 SQLite 保留 `standing`、本轮时长、剩余时间和 `hasStarted`；检查点没有 `automation`、presence、准备倒数或摄像头代次。旧设置缺字段只补 `null`，原有显式数值、`null` 与窗口选项 `false` 保留。
- 大站完成不增加专注统计；跳轮、重置及后续普通轮次沿用原周期。
- 摄像头临时停止后，实际模拟视频 track 结束、旧报告被拒绝，超过心跳期限不回退；重载大站窗口仍保留监控偏好。通过推进隔离 Main 的单调时钟验证自然归零，后续监控专注创建新代次并等待新样本。
- 160×180 窗口可通过更多菜单选择、暂停和继续大站，完整显示 `180:00`；常规窗口提供直接入口。

## 实机与发布边界

| 项目 | macOS | Windows |
| --- | --- | --- |
| 本分支 Electron 自动化、模拟输入／摄像头／电源事件 | 已执行，详见上表 | 未执行 |
| 物理摄像头指示灯在大站期间关闭、下一轮恢复 | 待验收 | 待验收 |
| 真实键鼠、锁屏、睡眠与手动继续 | 待验收 | 待验收 |
| 安装包与安装后检查 | ARM64 DMG 复制安装及自动化通过；本机正常打开通过，浏览器下载隔离首次批准未验 | 本轮未打包 |

自动化不能证明用户实际站立，也不替代真实系统权限、物理摄像头或安装验收。发布前按[路线图的大站验证门](roadmap.md#大站验证门)分别记录 OS、架构、最终构建／提交及结果。

## 本地安装交付

按用户要求替换本地旧软件，构建命令为：

```sh
npm run package --workspace=@pomodoro/desktop -- --mac dmg --arm64 --publish never -c.extraMetadata.version=0.1.0-beta.3-standing.dbbb634
```

- 安装包：`apps/desktop/dist/Pomodot-0.1.0-beta.3-standing.dbbb634-mac-arm64.dmg`。
- DMG SHA-256：`e7d5375d89a84475b0b2140da123c16d3adcbbf6007cb702eb0db5a93fdf6d40`。
- 包内与已安装 `app.asar` SHA-256：`ecd92db69063a4c97b8c2e6af0acd7b9e9f6457f06a5c82bf8c99f7bbb6c675b`。
- 安装位置：`/Applications/Pomodoro Timer.app`，应用标识仍为 `com.easton.pomodotimer`。保持原有 ad hoc 签名、hardened runtime 和受限媒体 entitlement，未改变系统安全设置。
- 旧应用移到废纸篓；此前五处旧打包产物也已移到废纸篓。新版本验证后再替换，没有删除用户数据库。
- 原 SQLite 数据库在应用退出后先备份到已忽略的 `diagnostics/installed-data-backup-v6_iby8e/`；正式启动后核对原完成专注记录逐条保留。预览数据目录没有导入正式数据。
- 正式安装版通过系统正常打开，进程和原生窗口均指向 `/Applications/Pomodoro Timer.app`；保留原来的轮次进度，没有为展示效果跳过或重置真实轮次。

本地构建及交付证据保存在已忽略的 `diagnostics/standing-install-build.json`、`standing-install-result.json` 和签名检查结果中。没有创建发布 tag，也没有上传或发布安装包。

## 接续位置

代码、测试与权威文档位于 `codex/standing-break`，功能提交为 `dbbb634`。本轮实现、自动化验收和本地 ARM64 安装交付完成；正式发布前继续上表的 macOS / Windows 实机门。验证日志与未精选截图位于已忽略的 `apps/desktop/test-results/`，精选截图见[文档索引](README.md#产品截图)。

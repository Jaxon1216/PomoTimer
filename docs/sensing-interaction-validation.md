# 感知交互修订验证

2026-11-08，按用户确认的交互规则修订 `codex/camera-presence`。计时规则提交为 `6710635`，界面、快捷键和跨进程测试提交为 `c4cea9a`；文档提交另行收尾。平台为 Apple Silicon、macOS 26.4.1（25E253）、Node.js 24.15.0、Electron 33.4.11。

## 结果

- 触控专注由按钮或空格开始；监控专注在确认在场后自动开始，包括首次和下一轮。专注手动暂停锁优先。
- 监控活动休息由摄像头离席启动，桌前休息由系统输入闲置启动。休息没暂停或按过暂停都继续参与自动计时，不建立手动锁；旧版本休息锁在重启时规范化，保留剩余时长。
- 输入休息准备期显示“无输入 40 秒开始休息”，最后十秒显示倒数；输入回归重新等待。准备时间不抵扣正式休息时长。
- 感知按钮位于统计按钮左侧；底部阶段条按计划时长分配宽度，文字区分当前位置与已完成量。

## 已执行检查

| 检查 | 结果 |
| --- | --- |
| `npm run lint`、`npm run typecheck` | 通过 |
| `npm run test` | 208 项通过，其中 TimerEngine 72、共享契约 12、Renderer 54 |
| `npm run test:store` | 17 项真实 SQLite 测试通过；包含旧休息锁恢复与准备提示不入检查点 |
| `npm run test:e2e` 后同步旧文案断言，再执行 `npx playwright test` | 完整 21 项通过；首轮仅两项旧文案断言不匹配，新行为测试已通过 |
| 真实空格键、主按钮原生激活回归 | 使用 Playwright `keyboard.press("Space")` 在已聚焦主按钮上开始、暂停、继续，单独重跑通过；设置说明修正后的 54 项组件测试也通过 |
| `node scripts/validate-renderer-layout.mjs` | 通过；160×180 下三个头部按钮可点击，不覆盖 macOS 原生按钮；实际阶段宽度符合 6:1 和 2:1 比例 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package --workspace=@pomodoro/desktop -- --config.directories.output=dist/interaction` | ARM64 应用与 DMG 生成成功，`hdiutil verify` 校验通过；未签名 |
| 指向新版打包应用运行 `camera.e2e.ts` | 6 项通过，包含真实本地模型推理、自动专注/活动休息、桌前输入休息、暂停逻辑或和空格操作 |

状态机和组件回归先在旧实现上见红，再修改实现。跨进程用例也确认旧版缺少右上角模式入口。所有自动化使用独立临时用户数据，摄像头用例使用 Chromium 模拟设备；没有替用户点击摄像头授权，也没有在测试中读取物理摄像头。

截图已同步：[触控初始页](assets/screenshots/timer-light.png)、[监控离开暂停](assets/screenshots/camera-monitor.png)、[休息准备倒数](assets/screenshots/break-preparation.png)、[最小休息窗口](assets/screenshots/drag-minimum-interrupted-break.png)。文档截图随当前开发版更新，历史截图可通过对应 Git 提交复现。

## 本地交付与边界

新版应用位于 `apps/desktop/dist/interaction/mac-arm64/Pomodoro Timer.app`，安装镜像位于 `apps/desktop/dist/interaction/Pomodot-0.1.0-beta.2-mac-arm64.dmg`。独立输出目录避免构建时覆盖用户正在运行的旧包。已正常退出旧实例并打开新版，核对界面资源路径指向新构建、模式按钮在统计左侧、页脚显示“第 1/3 轮专注”；保留原用户数据，没有代用户启动计时或摄像头。

Windows 真机、OS 授权撤销、物理摄像头在不同光照下的检测以及真实锁屏/睡眠仍需按[发布验证门](roadmap.md#摄像头验证门)验收。本轮模拟输入、媒体和电源事件不代替这些项目；尚未推送、合并或发布。

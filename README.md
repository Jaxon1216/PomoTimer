# PomoTimer · Pomodot

macOS / Windows 本地桌面番茄钟。可配置的专注与长短休节奏、可缩放桌面挂件，以及只记录完整专注轮次的本地统计。

[下载 beta.3](https://github.com/Jaxon1216/PomoTimer/releases/tag/v0.1.0-beta.3) · [更新记录](CHANGELOG.md) · [文档](docs/README.md) · [反馈](https://github.com/Jaxon1216/PomoTimer/issues)

| 初始窗口 · 等待开始 | 拖小窗口 · 等待活动休息 |
| --- | --- |
| <img src="docs/assets/screenshots/timer-light.png" width="360" alt="初始窗口显示第一轮专注、30 分钟倒计时和开始按钮"> | <img src="docs/assets/screenshots/long-break-waiting-compact.png" width="220" alt="小窗显示 10 分钟长休，等待离席后自动开始"> |

这两张图来自开发版在 macOS 上的真实 Electron 测试窗口。[截图版本与重现方法](docs/README.md#产品截图)

## 下载

**v0.1.0-beta.3 为预发布版**，供体验与反馈使用，尚未完成全部真实设备验收。安装包名为 **Pomodot**，应用内名称为 **Pomodoro Timer**。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [EXE 安装向导](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/Pomodot-0.1.0-beta.3-windows-x64-setup.exe) |
| macOS Apple Silicon | [ARM64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/Pomodot-0.1.0-beta.3-mac-arm64.dmg) |
| macOS Intel | [x64 DMG](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/Pomodot-0.1.0-beta.3-mac-x64.dmg) |

macOS 将应用拖入 Applications；Windows 运行安装向导。无需 Node.js。

> macOS 使用 ad hoc 完整性签名，没有 Developer ID 签名或 Apple 公证；Windows 未使用开发者证书签名。请确认下载来源，并核对 [SHA256SUMS](https://github.com/Jaxon1216/PomoTimer/releases/download/v0.1.0-beta.3/SHA256SUMS)。

<details>
<summary>macOS 首次打开提示无法验证开发者？</summary>

确认来源后，在“系统设置 → 隐私与安全性”中找到被阻止的 Pomodoro Timer，选择“仍要打开”并按系统提示确认。此操作只为该应用添加例外，详见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。

ad hoc 签名只验证完整性，不代表 Apple 认可开发者身份。若提示“已损坏”“将损坏你的电脑”，或没有“仍要打开”，请[反馈完整提示与系统版本](https://github.com/Jaxon1216/PomoTimer/issues)，不要全局关闭安全保护。受组织管理的电脑可能不允许添加例外。

</details>

## 使用

1. **开始专注**：点击开始或按空格。默认「触控模式」检测键盘、鼠标或触控板的输入活动；连续 40 秒无输入会暂停，恢复输入后可自动继续。手动暂停专注后需主动继续。
2. **按节奏休息**：默认 `30 / 5 / 30 / 5 / 30 / 10` 分钟。专注结束后，满足无输入或离席条件才开始休息；准备期不抵扣休息时长。
3. **按习惯调整**：拖动窗口边缘缩成挂件，拖动留白移动；在设置中调整时长、轮数、置顶与外观，点击统计查看今日、本周和热力图。

可选「监控模式」使用摄像头判断在场，需主动选择并授权；切回触控即关闭摄像头。感知结果不代表实际专注或运动。完整规则见[产品规格](docs/product-spec.md)。

## 隐私与限制

- 离线运行，无账号、云同步或遥测；设置和记录保存在本机 SQLite。
- 输入检测只读取闲置秒数，不记录按键内容、鼠标位置、活动窗口或屏幕内容。
- 摄像头画面仅在本机瞬时处理，不保存、不上传、不识别身份；不可用时提示并回退输入检测。
- 摄像头授权、系统事件和部分原生窗口体验仍待真机验收，自动化通过不代表全部设备验证完成。见[发布门与验收范围](docs/roadmap.md)。
- 部分旧计时快照可能无法恢复，升级前建议备份数据；重建数据库需用户确认，已有备份会保留。

## 开发

需要 macOS / Windows、Git、Node.js 24 和 npm，以及本机图形环境。

```sh
git clone https://github.com/Jaxon1216/PomoTimer.git
cd PomoTimer
npm ci
npm run dev
```

[协作约定](AGENTS.md) · [开发与验证](docs/README.md#本地原生回归) · [架构](docs/architecture.md) · [CI 与合并门槛](docs/ci.md) · [第三方资源](docs/third-party-notices.md)

反馈问题时请附系统、芯片架构、版本和复现步骤；截图或日志请先移除个人信息。

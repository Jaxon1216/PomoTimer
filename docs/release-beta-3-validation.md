# 0.1.0-beta.3 发布验证

日期：2026-11-10。发布分支：`codex/release-beta-3`，基线为最新 `origin/main` 的 `9b7668c`。版本由 `0.1.0-beta.2` 升为 `0.1.0-beta.3`，包含已合入的摄像头感知、休息交互和独立桌面挂件控制。原工作目录及其他 worktree 的本地改动未纳入本次发布。

本轮为安装包对齐和验收，没有修改 TimerEngine、持久化格式或应用运行时行为。移植了 PR #6 的免费 macOS 完整性签名与 DMG 检查，并为 hardened runtime 下的主应用及辅助进程补充摄像头 entitlement；没有麦克风授权。ad hoc 签名不等于 Developer ID 或 Apple 公证。

## 本地自动化结果

环境：Apple Silicon ARM64，macOS 26.4.1（25E253），Node.js 24.15.0，npm 11.12.1，Electron 33.4.11。以下均为本轮实际执行结果，不将过去开发轮次的通过结果挪作本次执行。

| 命令或检查 | 结果 |
| --- | --- |
| `npm ci` | 通过。 |
| `npm run lint`、`npm run typecheck` | 通过。 |
| `npm run test` | 222 项通过。 |
| `npm run test:store` | 22 项真实 SQLite 测试通过。 |
| `npm run test:e2e` | 构建及 25 项 Electron 跨进程测试通过。 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package --workspace=@pomodoro/desktop -- --mac dmg --arm64 --publish never` | 最终 ARM64 DMG 生成成功。 |
| `npm run test:packaging` | 主应用、辅助应用、框架与原生模块的完整签名和摄像头 entitlement 通过；篡改 ASAR 或原生 SQLite 模块均被拒绝。 |
| `node scripts/smoke-mac-dmg.mjs apps/desktop/dist/Pomodot-0.1.0-beta.3-mac-arm64.dmg` | 只读挂载、复制安装、安装后验签和增强 smoke 全部通过，临时应用及挂载已清理。 |
| `hdiutil verify apps/desktop/dist/Pomodot-0.1.0-beta.3-mac-arm64.dmg` | DMG 校验和有效。 |
| `POMODORO_SPACES_EXECUTABLE=… node scripts/validate-macos-spaces.mjs` | 实际打包应用的原生全屏跟随、系统边缘拖动至 160×180、Dock 和真实 Cmd-Tab 探针通过。 |

增强 smoke 从安装后的 `app.asar` 读取并验证模型 SHA-256、SIMD/非 SIMD WASM 魔数和 Apache 许可证，断网重载后使用真实 MediaPipe 检测器与 Chromium 模拟摄像头推断离席。默认触控没有请求摄像头；切回触控后视频轨道结束。另覆盖隐藏超过心跳期限、最小挂件的文字和操作可见性、置顶与淡化独立开关、macOS 跟随切换重建窗口及保留 Dock。无远程 HTTP/HTTPS 资源请求和 Renderer 未捕获错误。

本地 ARM64 DMG 的 SHA-256：`530e3d37f8ca80dafb2c1261c7564b5745f7e2c6feb2b04584fcb6d76f0b543e`。这是本地验收构建；GitHub 各平台重新构建的正式附件以发布页 `SHA256SUMS` 为准，不能用本地哈希代替。

## macOS 物理摄像头实测

在上述 macOS 和 ARM64 打包应用上，以独立临时 userData 启动，没有传入任何模拟媒体参数，也没有替换摄像头采集或推断。默认触控打开后，再主动切换监控：

- 系统摄像头授权状态从 `not-determined` 变为 `granted`。
- 真实检测得到 `present`，`cameraMonitoringAvailable=true`，首轮专注自动进入 `running`。
- 切回触控后，Main 摄像头会话停用；退出实例并清理测试数据。
- 只记录授权、在场三态和计时状态，不保存画面、检测框、设备标识或身份信息。

这次实测只证明本机的允许授权、真实设备初始化、在场自动开始和模式关闭链路。拒绝/撤销权限、不同光照、转头离席、外接设备拔插及物理摄像头在睡眠恢复后的行为仍待验收。

## 跨平台发布检查

PR CI 现在分别运行 macOS ARM64、macOS Intel x64 和 Windows x64。三个目标都构建最终安装包；macOS 从 DMG 复制安装，Windows 将最终 NSIS EXE 实际静默安装到普通用户的默认目录（含 `Pomodoro Timer` 空格），运行增强 smoke 后由真实卸载器移除应用、注册表项和快捷方式。安装前拒绝已有产品，应用数据使用独立临时目录。

发布 tag 的流程重复上述全部检查，只有三个目标均成功，才上传完整的三个安装包和 `SHA256SUMS`，最后公开预发布 Release。实际运行结果保留在 [CI](https://github.com/Jaxon1216/PomoTimer/actions/workflows/ci.yml) 和 [Release](https://github.com/Jaxon1216/PomoTimer/actions/workflows/release.yml) 的对应提交与 tag 中；本文的本地检查不代替这些跨平台结果。

## 验收边界

此版本仍为 beta 预发布。当前机器无法验证真实 Intel Mac 和 Windows 物理摄像头、SmartScreen/首次系统批准、各品牌设备或驱动；CI 不代表这些人工项目通过。新版构建的浏览器下载隔离与 Finder 首次批准也须与 DMG 复制安装分开验收。macOS 桌面滑动、Split View、外接屏、通知和真实睡眠/锁屏按[路线图](roadmap.md)继续逐项记录，未执行的项目保留待验收。

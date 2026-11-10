# CI 与合并门槛

## 触发与取消

`.github/workflows/ci.yml` 在 PR 创建、重新打开或更新时运行，也在 `main` 收到 push 时运行。未开 PR 的功能分支和 tag 不触发该工作流；发布 tag 继续由独立的 `release.yml` 处理。

一个 PR 的一次提交只运行一轮 CI，合并后再检查实际的 `main`。同一 PR 或分支的新提交会取消旧运行；不同 PR 以及 PR 和 `main` 的检查相互独立。

PR 和 `main` 的每轮 CI 均覆盖三个构建目标；发布工作流也分别构建这三个目标：

| 平台 / 架构 | PR / `main` 检查名称与 runner | 发布 runner | 最终安装包 |
| --- | --- | --- | --- |
| macOS Apple Silicon / ARM64 | `macos-latest` | `macos-15` | ARM64 DMG |
| Windows / x64 | `windows-2022` | `windows-2022` | x64 NSIS EXE |
| macOS Intel / x64 | `macos-15-intel` | `macos-15-intel` | x64 DMG |

三个目标均使用 Node.js 24，执行 `npm ci`、lint、类型检查、单元与组件测试、真实 SQLite 测试和完整 Electron E2E，然后构建最终安装包并运行安装后检查。任何步骤失败都会使该目标检查失败，并在有诊断产物时上传它们。

## 最终安装包检查

macOS 两个架构均使用不依赖开发者证书的 ad hoc 签名，PR 构建也启用该签名流程。`npm run test:packaging` 检查应用及原生 SQLite 模块的严格签名、hardened runtime、摄像头用途声明和 entitlement；再复制应用，分别篡改 `app.asar` 与原生模块，确认校验拒绝这两种改动。`smoke-mac-dmg.mjs` 随后只读挂载最终 DMG，保留扩展属性复制安装到独立临时目录，重新验签并启动复制后的应用。

Windows 使用 `smoke-windows-installer.mjs` 静默运行最终 NSIS EXE，按普通用户的默认当前用户目录安装（路径含 `Pomodoro Timer` 空格），检查版本注册、桌面与开始菜单快捷方式，并启动安装后的应用。结束时执行真正的卸载程序，核对注册项、快捷方式和可执行文件已移除，再清理临时测试目录。发现已有同名安装、安装键、默认目录或快捷方式时拒绝执行，避免覆盖用户安装；应用数据也使用隔离目录。测试不传 `/D=` 覆盖参数：固定的 electron-builder 25 模板会截断该参数中的空格，而交互安装向导和默认目录不走这条覆盖路径。

两种安装路径均运行增强的 `smoke-packaged.mjs`：验证打包 ASAR、SQLite、托盘资源、真实 preload/IPC、计时与统计、默认触控不请求摄像头、离线加载真实本地模型与 WASM、模拟视频流推断及停止摄像头，以及最小挂件、独立开关和淡化。macOS 另验证桌面跟随切换时窗口重建，Windows 验证该选项不可用。

这些安装检查通过进程启动应用，使用 Chromium 模拟摄像头；不代表浏览器下载、Finder 首次打开、Gatekeeper 用户批准或物理摄像头验收。实际执行结果和平台边界见 [beta.3 发布验证](release-beta-3-validation.md)。

## 主分支保护

`main` 必须通过 PR 更新，合并前分支须包含最新的 `main`。当前保护配置将 `macos-latest` 和 `windows-2022` 列为两项必需检查，绑定到 GitHub Actions（app ID `15368`），管理员同样受保护；Intel 检查也执行，但尚未列入该配置的必需检查。禁止强制推送和删除主分支。当前不要求额外批准人数，单人维护仍可在检查通过后自行合并。

保护配置保存在 [branch-protection-main.json](../.github/branch-protection-main.json)，GitHub 端设置需要有仓库管理员权限的身份单独应用；合并配置文件本身不会自动改变仓库设置。从仓库根目录执行：

```sh
gh api --method PUT repos/Jaxon1216/PomoTimer/branches/main/protection \
  --input .github/branch-protection-main.json
gh api repos/Jaxon1216/PomoTimer/branches/main/protection
```

如果修改 CI job 名称或来源应用，须同步修改并应用保护配置，避免必需检查永久等待。检查失败时修复或重跑对应 job，不能以关闭保护或管理员绕过代替验证。

## 主题回归边界

设置页的可见背景由 `.pageSurface` 绘制，`body` 按透明窗口设计保持透明。Electron E2E 在 macOS 和 Windows 验证设置页浅色、深色、系统深色和系统浅色背景；Windows 额外验证原生标题栏颜色。透明 `body` 本身不是主题失败。

Windows 原生标题栏仍须由 Windows CI 验证。本机 macOS 的通过结果不能代替 Windows，也不能代替发布门要求的真实设备验收。

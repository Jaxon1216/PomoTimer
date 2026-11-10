# CI 与合并门槛

## 触发与取消

`.github/workflows/ci.yml` 在 PR 创建、重新打开或更新时运行，也在 `main` 收到 push 时运行。未开 PR 的功能分支和 tag 不触发该工作流；发布 tag 继续由独立的 `release.yml` 处理。

一个 PR 的一次提交只运行一轮 CI，合并后再检查实际的 `main`。同一 PR 或分支的新提交会取消旧运行；不同 PR 以及 PR 和 `main` 的检查相互独立。

每轮 CI 保留两个稳定的检查名称：`macos-latest`、`windows-2022`。两者都执行依赖安装、lint、类型检查、单元与组件测试、真实 SQLite 测试和 Electron E2E。任何步骤失败都会使该平台检查失败，并在有诊断产物时上传它们。

## 主分支保护

`main` 必须通过 PR 更新，合并前分支须包含最新的 `main`，且上述两项检查都通过。必需检查绑定到 GitHub Actions（app ID `15368`），管理员同样受保护。禁止强制推送和删除主分支。当前不要求额外批准人数，单人维护仍可在检查通过后自行合并。

保护配置保存在 [branch-protection-main.json](../.github/branch-protection-main.json)，GitHub 端设置需要有仓库管理员权限的身份单独应用；合并配置文件本身不会自动改变仓库设置。从仓库根目录执行：

```sh
gh api --method PUT repos/Jaxon1216/PomoTimer/branches/main/protection \
  --input .github/branch-protection-main.json
gh api repos/Jaxon1216/PomoTimer/branches/main/protection
```

如果修改 CI job 名称或来源应用，须同步修改并应用保护配置，避免必需检查永久等待。检查失败时修复或重跑对应 job，不能以关闭保护或管理员绕过代替验证。

## 主题回归边界

设置页的可见背景由 `.pageSurface` 绘制，`body` 按透明窗口设计保持透明。Electron E2E 在两个平台验证设置页浅色、深色、系统深色和系统浅色背景；Windows 额外验证原生标题栏颜色。透明 `body` 本身不是主题失败。

Windows 原生标题栏仍须由 Windows CI 验证。本机 macOS 的通过结果不能代替 Windows，也不能代替发布门要求的真实设备验收。

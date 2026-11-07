# 摄像头感知开发验证

本次按用户需求实现默认触控、主动切换监控的本地在场感知。专注使用选中来源，两种休息仍使用系统输入。参考同目录 Pomotroid 的本地模型和检测阈值，计时、故障回退、权限门禁和持久化继续由本项目负责。

分支为 `codex/camera-presence`，基于 `origin/main` 的 `e530493`。功能与测试提交依次为 `36967f9`（状态机和契约）、`90f3856`（本地检测及模式入口）、`d2070bd`（跨进程、开发入口和小窗回归）；后续文档提交记录本次验证。开发使用独立 worktree，原工作目录的未提交修改保持原样。

验证平台：Apple Silicon，macOS 26.4.1（25E253），Node.js 24.15.0，Electron 33.4.11。以下检查于 2026-11-07 完成。

| 实际执行 | 结果 |
| --- | --- |
| `npm ci` | 成功安装锁定依赖 |
| `npm run lint` / `npm run typecheck` | 通过 |
| `npm run test` | 180 项通过，含计时、权限、严格契约、摄像头取消/故障清理和界面检查 |
| `npm run test:store` | 13 项通过，含模式持久化、冻结进度恢复及检查点不含在场结果 |
| `npm run build` | 通过，本地模型校验和匹配；SIMD/非 SIMD 运行时由锁定 npm 包生成 |
| `npm run test:e2e` | 19 项全部通过，含 5 项摄像头用例及既有计时、窗口、数据故障回归 |
| `node scripts/validate-renderer-layout.mjs` | 通过，覆盖最小窗口与多种宽高布局 |
| `POMODORO_CAMERA_SMOKE=1 node scripts/smoke-dev.mjs` | 真实 `npm run dev`、隔离数据目录、同源本地推理和设备释放通过 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package --workspace=@pomodoro/desktop -- --dir` | macOS ARM64 应用目录打包通过，未签名；本次没有生成或验收 DMG 安装过程 |
| 打包应用运行 `camera.e2e.ts` | 5 项通过，真实加载 ASAR 内本地模型和 WASM |
| 打包内容检查 | 模型、两套 JS/WASM、Apache 许可证均在 ASAR 中；Info.plist 含摄像头用途说明 |

摄像头 E2E 和开发入口验证始终使用 Chromium 模拟摄像头，没有采集物理摄像头。检测器使用真实本地 MediaPipe/BlazeFace，模拟无脸画面得到 `away`；请求记录确认生产检测没有 HTTP/HTTPS 资源请求，开发检测只访问本机 Vite 同源资源。另用受限 preload 上报受控三态样本，验证专注在场/离开、输入闲置隔离、手动暂停锁、睡眠后新代次、旧代次拒绝、重载和心跳过期回退。

模拟设备用例还验证窗口隐藏超过心跳期限仍持续检测、160×180 小窗可从更多菜单切回触控、视频轨道进入 `ended`。全量回归曾发现模式按钮压缩最小窗口圆环；修复后紧凑布局通过菜单切换，既有圆环尺寸检查与完整 E2E 均通过。截图见[初始触控](assets/screenshots/timer-light.png)和[监控离开暂停](assets/screenshots/camera-monitor.png)。

重新验证打包应用时，先执行上述打包命令，再在 `apps/desktop` 目录运行：

```sh
POMODORO_CAMERA_EXECUTABLE="$PWD/dist/mac-arm64/Pomodoro Timer.app/Contents/MacOS/Pomodoro Timer" \
  npx playwright test camera.e2e.ts --output=test-results/camera-packaged
```

Windows 真机、物理摄像头在不同光照下的检测、OS 首次授权/撤销、真实睡眠/锁屏以及签名安装包验收尚未执行。下一步按[摄像头验证门](roadmap.md#摄像头验证门)分别记录 macOS 和 Windows 的 OS、构建及结果；模拟媒体流和模拟电源事件不代替这些项目。本次未发布、推送或合并分支。

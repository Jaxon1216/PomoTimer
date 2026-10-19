#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 领域：Electron / 开发启动验证
// 顺序：Playwright -> npm run dev -> electron-vite -> Electron。
// 作用：跨过两层 npm 脚本，将调试端口和隔离 userData 传入 electron-vite 的 -- 参数区。
// 原因：只有检查实际 Main 的身份与数据路径，才能证明正在验收本次开发实例。
// 边界：不更换开发入口，不改变 Renderer 权限，不读取或终止既有用户进程。
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dataDirectory = args.find((argument) => argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (process.env.POMODORO_DIAGNOSTICS !== "1" || !dataDirectory
  || dirname(realpathSync(dataDirectory)) !== realpathSync(tmpdir())
  || !basename(dataDirectory).startsWith("pomodot-dev-smoke-")) {
  throw new Error("Development smoke requires an explicitly isolated temporary userData directory.");
}
const development = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--", "--", ...args], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
development.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
development.on("exit", (code) => { process.exitCode = code ?? 1; });

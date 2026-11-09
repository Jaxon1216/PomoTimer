import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") throw new Error("Native Spaces validation requires macOS.");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "apps/desktop");
const outputDirectory = join(root, "test-results", "macos-spaces");
await mkdir(outputDirectory, { recursive: true });

async function run(command, args, timeoutMs) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

const probeExecutable = join(outputDirectory, "fullscreen-probe");
await run("swiftc", [join(root, "tests/e2e/macos-spaces-probe.swift"), "-o", probeExecutable], 45_000);
const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-spaces-"));
let application;
try {
  application = await electron.launch({
    args: [join(desktop, "out/main/index.js"), `--user-data-dir=${dataDirectory}`],
    cwd: desktop,
    env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: dataDirectory },
    timeout: 30_000,
  });
  const page = await application.firstWindow();
  await page.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 15_000 });
  const identity = await application.evaluate(({ BrowserWindow, app }) => {
    const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect"));
    if (typeof inspect !== "function") throw new Error("Runtime diagnostics are missing");
    return { ...inspect(), mediaSourceId: BrowserWindow.getAllWindows()[0].getMediaSourceId(), dockVisible: app.dock.isVisible(),
      electronVersion: process.versions.electron };
  });
  assert.equal(await realpath(identity.userData), await realpath(dataDirectory));
  assert.equal(identity.window.configuredType, "panel");
  assert.equal(identity.window.alwaysOnTop, true);
  assert.equal(identity.window.followsWorkspaces, true);
  assert.equal(identity.dockVisible, true);
  const windowID = /^window:(\d+):/.exec(identity.mediaSourceId)?.[1];
  assert.ok(windowID, "Electron must identify its native window");

  const nativeResize = JSON.parse(await run(probeExecutable, ["--input-access"], 5_000));
  if (nativeResize.available) {
    const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    const drag = async (startX, startY, endX, endY) => {
      await run(probeExecutable, ["--drag", ...[startX, startY, endX, endY].map(String)], 5_000);
      await delay(600);
      return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
    };
    nativeResize.before = [bounds.width, bounds.height];
    nativeResize.afterGrowth = await drag(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2,
      bounds.x + bounds.width + 79, bounds.y + bounds.height / 2);
    nativeResize.grew = nativeResize.afterGrowth[0] > bounds.width + 20;
    if (nativeResize.grew) {
      const grown = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      nativeResize.afterMinimum = await drag(grown.x + grown.width - 1, grown.y + grown.height - 1,
        grown.x + 60, grown.y + 60);
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(360, 478));
  }

  // 领域：macOS / 独立原生验收
  // 顺序：隔离 Electron 实例 -> 自建全屏探针 -> Window Server 可见性证据。
  // 作用：在另一个测试进程的原生全屏空间中检查真实计时器窗口。
  // 原因：只读 Spaces 标志和普通页面截图不能代替跨应用全屏验证。
  // 边界：不控制用户已有应用，不截屏；仅启动和关闭本脚本自己的进程。
  const probe = JSON.parse(await run(probeExecutable, [String(identity.pid), windowID], 25_000));
  const dockVisibleAfter = await application.evaluate(({ app }) => app.dock.isVisible());
  const os = { version: (await run("sw_vers", ["-productVersion"], 5_000)).trim(),
    build: (await run("sw_vers", ["-buildVersion"], 5_000)).trim(), architecture: process.arch };
  const report = { kind: "macos-native-fullscreen", os, identity, nativeResize, probe, dockVisibleAfter };
  await writeFile(join(outputDirectory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(probe.error, undefined);
  assert.equal(probe.nativeFullscreen, true);
  assert.equal(probe.probeIsActive, true);
  const fullscreenWindow = probe.windows.find((window) => window.pid === probe.probePID && window.id === probe.probeWindowID);
  const timerWindow = probe.windows.find((window) => window.pid === identity.pid && window.id === Number(windowID));
  assert.ok(fullscreenWindow, "The probe's native fullscreen window must be on screen");
  assert.ok(timerWindow, "The exact timer window must remain on screen in the probe's fullscreen Space");
  assert.equal(timerWindow.onScreen, true);
  assert.ok(timerWindow.layer > fullscreenWindow.layer, "The timer must float above the probe window");
  assert.equal(timerWindow.layer, 3, "The timer uses the ordinary floating layer");
  const timerBounds = timerWindow.bounds;
  const fullscreenBounds = fullscreenWindow.bounds;
  assert.ok(timerBounds.X >= fullscreenBounds.X && timerBounds.Y >= fullscreenBounds.Y
    && timerBounds.X + timerBounds.Width <= fullscreenBounds.X + fullscreenBounds.Width
    && timerBounds.Y + timerBounds.Height <= fullscreenBounds.Y + fullscreenBounds.Height,
  "The timer must be on the same physical display as the fullscreen probe");
  assert.equal(dockVisibleAfter, true);
  if (nativeResize.available) {
    assert.equal(nativeResize.grew, true, "Dragging the real native edge must grow the transparent panel");
    assert.deepEqual(nativeResize.afterMinimum, [160, 180], "Native corner resizing must respect the minimum content size");
  }
  console.log(JSON.stringify(report, null, 2));
  if (!nativeResize.available) console.log("Native edge resizing was skipped because event-posting access is not already granted; no permission was requested.");
  console.log("Native fullscreen probe passed; Cmd-Tab, swipe gestures, Split View and external displays still require separate real-device checks.");
} finally {
  try { if (application) await application.close(); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}

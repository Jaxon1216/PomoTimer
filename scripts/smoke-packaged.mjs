import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "apps/desktop");
const defaultExecutablePath = process.platform === "darwin"
  ? join(desktop, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Pomodoro Timer.app/Contents/MacOS/Pomodoro Timer")
  : process.platform === "win32"
    ? join(desktop, "dist/win-unpacked/Pomodoro Timer.exe")
    : undefined;
if (!defaultExecutablePath) throw new Error("Packaged smoke tests support macOS and Windows only.");
const executablePath = process.env.POMODORO_SMOKE_EXECUTABLE ?? defaultExecutablePath;
if (!isAbsolute(executablePath)) throw new Error("The packaged smoke executable path must be absolute.");

const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-package-smoke-"));
let application;
try {
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${dataDirectory}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: dataDirectory },
    timeout: 30_000,
  });
  // Exercise packaged controls independently of the hosted runner's idle age.
  await application.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  let window = await application.firstWindow();
  await window.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 30_000 });
  const context = window.context();
  const requests = [];
  const rendererErrors = [];
  context.on("request", (request) => requests.push(request.url()));
  context.on("page", (page) => page.on("pageerror", (error) => rendererErrors.push(error.message)));
  window.on("pageerror", (error) => rendererErrors.push(error.message));
  await context.setOffline(true);
  await context.addInitScript(() => {
    // Replacement windows first open about:blank, before the trusted file page.
    if (location.protocol !== "file:") return;
    const probe = { requests: 0, streams: [] };
    Reflect.set(window, "packagedCameraProbe", probe);
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      probe.requests += 1;
      const stream = await getUserMedia(constraints);
      probe.streams.push(stream);
      return stream;
    };
  });
  // Reload offline before selecting camera mode; inference must use only ASAR assets.
  await window.reload();
  await window.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 30_000 });
  const identity = await application.evaluate(() => {
    const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect"));
    if (typeof inspect !== "function") throw new Error("Main-process runtime diagnostics were not enabled");
    return inspect();
  });
  assert.equal(await realpath(identity.userData), await realpath(dataDirectory));
  assert.equal(identity.packaged, true);
  assert.equal(identity.devServerUrl, null);
  assert.ok(identity.pid > 0 && identity.pid !== process.pid);
  assert.ok(identity.tray && identity.tray.size.width > 0);
  assert.equal(identity.tray.tooltip, "Pomodoro Timer");
  const appPath = await application.evaluate(({ app }) => app.getAppPath());
  assert.equal(appPath.endsWith(".asar"), true, "The smoke test must exercise the packaged ASAR.");
  assert.ok(decodeURIComponent(window.url()).includes("app.asar/out/renderer/"));
  if (process.platform === "darwin") {
    const info = await readFile(join(dirname(dirname(executablePath)), "Info.plist"), "utf8");
    assert.ok(info.includes("<key>NSCameraUsageDescription</key>"), "The installed Mac app must declare camera use.");
  }
  const cameraAssets = await window.evaluate(async () => {
    const names = ["blaze_face_short_range.tflite", "vision_wasm_internal.js", "vision_wasm_internal.wasm",
      "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm", "LICENSE.txt"];
    return Promise.all(names.map(async (name) => {
      const response = await fetch(new URL(`./mediapipe/${name}`, document.baseURI));
      if (!response.ok) throw new Error(`Packaged camera asset unavailable: ${name}`);
      const contents = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", contents);
      return { name, size: contents.byteLength,
        signature: Array.from(new Uint8Array(contents, 0, Math.min(4, contents.byteLength))),
        sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        apacheLicense: name === "LICENSE.txt" ? new TextDecoder().decode(contents).includes("Apache License") : undefined };
    }));
  });
  for (const asset of cameraAssets) {
    assert.ok(asset.size > 0, `${asset.name} must be included in the ASAR.`);
    if (asset.name.endsWith(".wasm")) assert.deepEqual(asset.signature, [0, 97, 115, 109]);
    if (asset.name === "LICENSE.txt") assert.equal(asset.apacheLicense, true);
    if (asset.name === "blaze_face_short_range.tflite") {
      assert.equal(asset.sha256, "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f");
    }
  }
  const environment = await application.evaluate(({ nativeImage }) => {
    const names = process.platform === "darwin"
      ? ["trayTemplate.png", "trayTemplate@2x.png"]
      : process.platform === "win32"
        ? ["pomodoro-timer.ico"]
        : ["pomodoro-timer.png"];
    const resources = names.map((name) => ({ name, empty: nativeImage.createFromPath(`${process.resourcesPath}/icons/${name}`).isEmpty() }));
    return { resources };
  });
  assert.equal(environment.resources.every((resource) => !resource.empty), true);
  if (process.platform === "darwin") {
    assert.equal(identity.tray.template, true);
    assert.ok(identity.tray.scales.includes(1) && identity.tray.scales.includes(2));
    assert.ok(identity.tray.bounds.width > 0 && identity.tray.bounds.height > 0);
  }
  const snapshot = await window.evaluate(() => window.pomodoro.getSnapshot());
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.round.kind, "focus");
  const settings = await window.evaluate(() => window.pomodoro.getSettings());
  assert.equal(settings.focusPresenceSource, "input");
  assert.equal(settings.alwaysOnTop, true);
  assert.equal(settings.followWorkspaces, true);
  assert.equal(settings.autoFade, true);
  assert.equal((await window.evaluate(() => window.pomodoro.getCameraState())).enabled, false);
  assert.equal(await window.evaluate(() => Reflect.get(window, "packagedCameraProbe").requests), 0,
    "A new installation must not request camera access in default touch mode.");
  await window.getByRole("button", { name: "开始计时" }).click();
  await window.getByRole("button", { name: "暂停计时" }).waitFor();
  await window.getByRole("button", { name: "暂停计时" }).click();
  assert.equal((await window.evaluate(() => window.pomodoro.getSnapshot())).status, "manual-paused");
  await window.getByRole("button", { name: "打开统计" }).click();
  await window.getByRole("heading", { name: "统计", exact: true }).waitFor();
  await window.getByRole("button", { name: "返回计时器" }).click();
  await window.evaluate(() => window.pomodoro.command("reset"));
  await window.getByRole("button", { name: "开始计时" }).click();
  const inferenceRequestStart = requests.length;
  await window.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
  // Chromium supplies synthetic non-face frames, while the real bundled detector
  // must initialize and infer "away"; no presence reports or model calls are mocked.
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).automation,
    { timeout: 20_000 }).toMatchObject({ activePresenceSource: "camera", cameraMonitoringAvailable: true, cameraPresence: "away", pauseReason: "camera-away" });
  const inferenceRequests = requests.slice(inferenceRequestStart);
  assert.ok(inferenceRequests.some((url) => url.endsWith(".wasm")), "Real inference must load the packaged WASM.");
  assert.ok(inferenceRequests.some((url) => url.endsWith("blaze_face_short_range.tflite")), "Real inference must load the packaged model.");
  assert.equal(await window.evaluate(() => Reflect.get(window, "packagedCameraProbe").requests), 1);
  await application.evaluate(({ BrowserWindow }) => new Promise((resolve) => {
    BrowserWindow.getAllWindows()[0].hide();
    setTimeout(resolve, 6_000);
  }));
  assert.equal((await window.evaluate(() => window.pomodoro.getCameraState())).enabled, true);
  assert.equal((await window.evaluate(() => window.pomodoro.getSnapshot())).automation.cameraMonitoringAvailable, true);
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show(); });

  const captionHeight = await window.locator("#root").evaluate((element) => element.getBoundingClientRect().top);
  await application.evaluate(({ BrowserWindow }, caption) => { BrowserWindow.getAllWindows()[0].setContentSize(160, 180 + caption); }, captionHeight);
  await expect.poll(() => window.locator("#root").evaluate((element) => [element.clientWidth, element.clientHeight])).toEqual([160, 180]);
  await expect(window.locator(".statePill")).toContainText("未检测到在场");
  await expect(window.getByRole("button", { name: "继续计时" })).toBeVisible();
  await expect(window.getByRole("button", { name: "打开统计" })).toBeVisible();
  const minimumLayout = await window.locator(".statePill, time, .timerControls button").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewportHeight: innerHeight };
    }));
  assert.ok(minimumLayout.every((box) => box.left >= 0 && box.right <= 160 && box.top >= 0 && box.bottom <= box.viewportHeight),
    "The minimum widget must retain visible time, pause reason and timer controls.");
  await window.getByRole("button", { name: "更多操作" }).click();
  await window.getByRole("menuitem", { name: "切换为触控感知" }).click();
  await expect.poll(() => window.evaluate(() => Reflect.get(window, "packagedCameraProbe").streams
    .flatMap((stream) => stream.getTracks().map((track) => track.readyState)))).toEqual(["ended"]);
  assert.equal((await window.evaluate(() => window.pomodoro.getCameraState())).enabled, false);

  await application.evaluate(({ BrowserWindow }, caption) => { BrowserWindow.getAllWindows()[0].setContentSize(360, 478 + caption); }, captionHeight);
  await window.getByRole("button", { name: "更多操作" }).click();
  await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByRole("checkbox", { name: "常驻顶部" }).uncheck();
  await window.getByRole("checkbox", { name: "自动淡化" }).uncheck();
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop())).toBe(false);
  assert.equal((await window.evaluate(() => window.pomodoro.getSettings())).autoFade, false);
  if (process.platform === "darwin") {
    for (const following of [false, true]) {
      const previous = window;
      await window.getByRole("checkbox", { name: "跟随桌面与全屏" }).setChecked(following);
      const replacement = application.waitForEvent("window");
      await window.getByRole("button", { name: "保存设置" }).click();
      window = await replacement;
      await window.getByRole("heading", { name: "设置", exact: true }).waitFor({ timeout: 30_000 });
      await expect.poll(() => previous.isClosed()).toBe(true);
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisibleOnAllWorkspaces())).toBe(following);
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), false);
      assert.equal(await application.evaluate(({ app }) => app.dock.isVisible()), true);
      await expect(window.getByRole("checkbox", { name: "自动淡化" })).not.toBeChecked();
    }
  } else {
    await expect(window.getByRole("checkbox", { name: "跟随桌面与全屏" })).toBeDisabled();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisibleOnAllWorkspaces()), false);
  }
  await window.getByRole("checkbox", { name: "自动淡化" }).check();
  await window.getByRole("button", { name: "保存设置" }).click();
  await window.getByRole("button", { name: "返回计时器" }).click();
  await window.mouse.move(180, 180);
  await expect(window.locator(".timerSurface")).toHaveAttribute("data-faded", "false");
  await window.mouse.move(-8, -8);
  await expect(window.locator(".timerSurface")).toHaveAttribute("data-faded", "true", { timeout: 4_000 });
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getOpacity()), 1);
  await window.mouse.move(180, 180);
  await expect(window.locator(".timerSurface")).toHaveAttribute("data-faded", "false");
  assert.deepEqual(requests.filter((url) => /^https?:/.test(url)), [], "The packaged renderer must work offline without remote requests.");
  assert.deepEqual(rendererErrors, [], "Packaged camera and widget interactions must not throw renderer errors.");
  console.log(JSON.stringify({ kind: "packaged-smoke", executablePath, identity, resources: environment.resources, cameraAssets,
    cameraInference: "real bundled detector / synthetic non-face stream / offline", widget: "minimum layout, independent controls, window replacement and fading" }, null, 2));
  console.log(`Packaged ${process.platform}/${process.arch}: startup, SQLite, tray, IPC, controls, statistics, offline camera inference and widget checks passed.`);
} finally {
  try {
    if (application) await application.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

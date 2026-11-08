import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") throw new Error("The dev-launch wrapper is currently verified on macOS only.");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-dev-smoke-"));
const cameraSmoke = process.env.POMODORO_CAMERA_SMOKE === "1";
let application;
try {
  application = await electron.launch({
    executablePath: join(root, "scripts/launch-development.mjs"),
    args: [`--user-data-dir=${dataDirectory}`, ...(cameraSmoke
      ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] : [])],
    cwd: root,
    env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: dataDirectory },
    timeout: 60_000,
  });
  await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await application.firstWindow();
  await window.getByRole("heading", { name: "专注", exact: true }).waitFor();
  const identity = await application.evaluate(() => {
    const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect"));
    if (typeof inspect !== "function") throw new Error("Main-process runtime diagnostics were not enabled");
    return inspect();
  });
  assert.equal(await realpath(identity.userData), await realpath(dataDirectory));
  assert.equal(identity.packaged, false);
  assert.equal(new URL(identity.devServerUrl).origin, "http://localhost:5174");
  assert.equal(new URL(window.url()).origin, new URL(identity.devServerUrl).origin);
  assert.ok(identity.pid > 0 && identity.pid !== process.pid);
  assert.ok(identity.tray && identity.tray.template && identity.tray.bounds.width > 0);
  const initial = await window.evaluate(() => window.pomodoro.getSnapshot());
  assert.equal(initial.status, "idle");
  assert.equal(initial.automation.activePresenceSource, "input");
  assert.equal((await window.evaluate(() => window.pomodoro.getSettings())).focusPresenceSource, "input");
  assert.equal((await window.evaluate(() => window.pomodoro.getCameraState())).enabled, false);
  await window.getByRole("button", { name: "开始计时" }).click();
  await window.getByRole("button", { name: "暂停计时" }).click();
  const paused = await window.evaluate(() => window.pomodoro.getSnapshot());
  assert.equal(paused.status, "manual-paused");
  let cameraResult;
  if (cameraSmoke) {
    // 领域：Electron / 开发摄像头验收
    // 顺序：真实 npm run dev 参数透传 -> Main 开关核验 -> 显式监控选择 -> 本地推理。
    // 作用：仅使用 Chromium 合成视频验证开发 URL 权限和本地模型资源链。
    // 原因：必须先证明两个 fake 开关到达实际 Electron，才能请求媒体而不打开真实摄像头。
    // 边界：使用独立 userData，不替换模型或推理实现；模式切换保留手动暂停锁。
    const fakeSwitches = await application.evaluate(({ app }) => ({
      device: app.commandLine.hasSwitch("use-fake-device-for-media-stream"),
      permission: app.commandLine.hasSwitch("use-fake-ui-for-media-stream"),
    }));
    assert.deepEqual(fakeSwitches, { device: true, permission: true });
    const requests = [];
    window.on("request", (request) => requests.push(request.url()));
    await window.evaluate(() => {
      const probe = { requests: 0, streams: [] };
      Reflect.set(window, "cameraSmokeProbe", probe);
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        probe.requests += 1;
        const stream = await getUserMedia(constraints);
        probe.streams.push(stream);
        return stream;
      };
    });
    await window.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
    await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).automation,
      { timeout: 25_000 }).toMatchObject({
      activePresenceSource: "camera", cameraMonitoringAvailable: true, cameraPresence: "away", manualPauseLocked: true,
    });
    assert.equal((await window.evaluate(() => window.pomodoro.getCameraState())).enabled, true);
    assert.ok(requests.some((url) => new URL(url).pathname.endsWith(".wasm")));
    assert.ok(requests.some((url) => new URL(url).pathname.endsWith("blaze_face_short_range.tflite")));
    const origin = new URL(identity.devServerUrl).origin;
    for (const request of requests.filter((url) => /^https?:/.test(url))) {
      assert.equal(new URL(request).hostname, "localhost");
      assert.equal(new URL(request).origin, origin);
    }
    const inferred = await window.evaluate(() => window.pomodoro.getSnapshot());
    assert.equal(inferred.status, "manual-paused");
    assert.equal(inferred.remainingMs, paused.remainingMs);
    await window.getByRole("button", { name: "感知模式：监控，切换为触控" }).click();
    await expect.poll(() => window.evaluate(() => Reflect.get(window, "cameraSmokeProbe").streams
      .flatMap((stream) => stream.getTracks().map((track) => track.readyState)))).toEqual(["ended"]);
    const restored = await window.evaluate(() => window.pomodoro.getSnapshot());
    assert.equal((await window.evaluate(() => window.pomodoro.getCameraState())).enabled, false);
    assert.equal(restored.automation.activePresenceSource, "input");
    assert.equal(restored.automation.manualPauseLocked, true);
    assert.equal(restored.status, "manual-paused");
    assert.equal(restored.remainingMs, paused.remainingMs);
    assert.equal(await window.evaluate(() => Reflect.get(window, "cameraSmokeProbe").requests), 1);
    cameraResult = { fakeSwitches, inference: "away", localResourceRequests: requests.length, released: true };
  }
  console.log(JSON.stringify({ kind: "development-smoke", command: "npm run dev", identity, rendererUrl: window.url(), camera: cameraResult }, null, 2));
  console.log("Development: real npm run dev, isolated userData, main/renderer identity, actual tray and IPC controls passed.");
  if (cameraSmoke) console.log("Development camera: explicit opt-in, synthetic device, real local inference, same-origin resources, manual pause lock and device release passed.");
} finally {
  try {
    if (application) await application.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

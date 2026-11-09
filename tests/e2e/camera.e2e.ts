import { test as baseTest, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { CameraState, Presence, TimerSnapshot } from "../../apps/desktop/src/shared/contracts";
import type {} from "../../apps/desktop/src/shared/window";

const workspaceRoot = process.cwd();
const desktopDirectory = existsSync(join(workspaceRoot, "apps/desktop/out/main/index.js"))
  ? join(workspaceRoot, "apps/desktop") : workspaceRoot;
const applicationEntry = join(desktopDirectory, "out/main/index.js");
const packagedExecutable = process.env["POMODORO_CAMERA_EXECUTABLE"];
type CameraProbe = { requests: number; streams: MediaStream[] };

const test = baseTest.extend<{ application: ElectronApplication; cameraWindow: Page }>({
  application: async ({}, use, testInfo) => {
    const userDataDirectory = testInfo.outputPath("camera-user-data");
    mkdirSync(userDataDirectory, { recursive: true });
    const application = await electron.launch({
      executablePath: packagedExecutable,
      args: [...(packagedExecutable ? [] : [applicationEntry]), `--user-data-dir=${userDataDirectory}`,
        "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
      cwd: desktopDirectory,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: userDataDirectory },
    });
    try {
      expect(await application.evaluate(({ app }) => app.getPath("userData"))).toBe(realpathSync(userDataDirectory));
      await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
      await use(application);
    } finally { await application.close(); }
  },
  cameraWindow: async ({ application }, use) => {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "感知模式：触控，切换为监控" })).toBeVisible({ timeout: 15_000 });
    await use(page);
  },
});

async function snapshot(page: Page): Promise<TimerSnapshot> {
  return page.evaluate(() => window.pomodoro.getSnapshot());
}

async function cameraState(page: Page): Promise<CameraState> {
  return page.evaluate(() => window.pomodoro.getCameraState());
}

async function report(page: Page, presence: Presence, generation: number): Promise<TimerSnapshot> {
  return page.evaluate(({ presence, generation }) => window.pomodoro.reportCameraPresence(presence, generation), { presence, generation });
}

async function probeCamera(page: Page, behavior: "real" | "denied" | "pending"): Promise<void> {
  await page.addInitScript((behavior) => {
    const probe: CameraProbe = { requests: 0, streams: [] };
    Reflect.set(window, "cameraTestProbe", probe);
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      probe.requests += 1;
      if (behavior === "denied") throw new DOMException("Test permission denied", "NotAllowedError");
      if (behavior === "pending") return new Promise<MediaStream>(() => {});
      const stream = await getUserMedia(constraints);
      probe.streams.push(stream);
      return stream;
    };
  }, behavior);
  await page.reload();
  await expect(page.getByRole("button", { name: "感知模式：触控，切换为监控" })).toBeVisible();
}

async function rejectedReport(page: Page, generation: number): Promise<string> {
  return page.evaluate(async (generation) => {
    try {
      await window.pomodoro.reportCameraPresence("present", generation);
      return "accepted";
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }, generation);
}

test("runs bundled camera inference only after opt-in and releases the fake device on switching back", async ({ application, cameraWindow }, testInfo) => {
  const requests: string[] = [];
  cameraWindow.on("request", (request) => requests.push(request.url()));
  await probeCamera(cameraWindow, "real");
  expect(await cameraState(cameraWindow)).toMatchObject({ enabled: false });
  expect(await cameraWindow.evaluate(() => (Reflect.get(window, "cameraTestProbe") as CameraProbe).requests)).toBe(0);
  await cameraWindow.getByRole("button", { name: "开始计时" }).click();
  await cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();

  // This uses Chromium's synthetic image source with the real bundled detector,
  // so an away result also proves the local JS/WASM/model initialization worked.
  await expect.poll(async () => (await snapshot(cameraWindow)).automation, { timeout: 15_000 }).toMatchObject({
    activePresenceSource: "camera", cameraMonitoringAvailable: true, cameraPresence: "away",
  });
  await expect(cameraWindow.locator(".monitorStatus")).toHaveText("监控感知 · 离开");
  expect(requests.some((url) => url.endsWith(".wasm"))).toBe(true);
  expect(requests.some((url) => url.endsWith("blaze_face_short_range.tflite"))).toBe(true);
  expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
  expect((await snapshot(cameraWindow)).automation.pauseReason).toBe("camera-away");
  await cameraWindow.screenshot({ path: testInfo.outputPath("camera-away.png") });
  // Stay hidden beyond the five-second Main watchdog to exercise real detection
  // heartbeats while Chromium would normally throttle a background window.
  await application.evaluate(({ BrowserWindow }) => new Promise<void>((resolve) => {
    BrowserWindow.getAllWindows()[0]?.hide();
    setTimeout(resolve, 6_000);
  }));
  expect(await cameraState(cameraWindow)).toMatchObject({ enabled: true });
  expect((await snapshot(cameraWindow)).automation.cameraMonitoringAvailable).toBe(true);
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show(); });
  const caption = await cameraWindow.evaluate(() => document.getElementById("root")!.getBoundingClientRect().top);
  await application.evaluate(({ BrowserWindow }, caption) => { BrowserWindow.getAllWindows()[0]?.setContentSize(160, 180 + caption); }, caption);
  await expect.poll(() => cameraWindow.locator("#root").evaluate((root) => [root.clientWidth, root.clientHeight])).toEqual([160, 180]);
  await expect(cameraWindow.locator(".statePill")).toContainText("未检测到在场");
  const statusGeometry = await cameraWindow.locator(".statePill").evaluate((pill) => {
    const box = pill.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, viewportHeight: innerHeight };
  });
  expect(statusGeometry.left).toBeGreaterThanOrEqual(0);
  expect(statusGeometry.right).toBeLessThanOrEqual(160);
  expect(statusGeometry.bottom).toBeLessThanOrEqual(statusGeometry.viewportHeight);
  await cameraWindow.screenshot({ path: testInfo.outputPath("camera-away-minimum.png") });
  await cameraWindow.getByRole("button", { name: "更多操作" }).click();
  await cameraWindow.getByRole("menuitem", { name: "切换为触控感知" }).click();
  await expect.poll(() => cameraWindow.evaluate(() =>
    (Reflect.get(window, "cameraTestProbe") as CameraProbe).streams.flatMap((stream) => stream.getTracks().map((track) => track.readyState)),
  )).toEqual(["ended"]);
  expect(await cameraState(cameraWindow)).toMatchObject({ enabled: false });
  expect((await snapshot(cameraWindow)).automation.activePresenceSource).toBe("input");
});

test("shows camera denial, returns to touch input, and preserves a manual pause", async ({ cameraWindow }) => {
  await probeCamera(cameraWindow, "denied");
  await cameraWindow.getByRole("button", { name: "开始计时" }).click();
  await cameraWindow.getByRole("button", { name: "暂停计时" }).click();
  const paused = await snapshot(cameraWindow);
  await cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
  await expect(cameraWindow.getByRole("alert")).toContainText("已切回触控感知");
  await expect(cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" })).toBeVisible();
  expect(await cameraState(cameraWindow)).toMatchObject({ enabled: false });
  const afterFailure = await snapshot(cameraWindow);
  expect(afterFailure.status).toBe("manual-paused");
  expect(afterFailure.remainingMs).toBe(paused.remainingMs);
  expect(afterFailure.automation.manualPauseLocked).toBe(true);
  expect(afterFailure.automation.activePresenceSource).toBe("input");
  expect(await cameraWindow.evaluate(() => (Reflect.get(window, "cameraTestProbe") as CameraProbe).requests)).toBe(1);
});

test("keeps camera focus authoritative across idle samples, manual pause and a new wake-up generation", async ({ application, cameraWindow }) => {
  await probeCamera(cameraWindow, "pending");
  await cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
  const original = await cameraState(cameraWindow);
  expect(original.enabled).toBe(true);
  await report(cameraWindow, "present", original.generation);
  await expect(cameraWindow.getByRole("button", { name: "暂停计时" })).toBeVisible();
  await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 600; });
  await expect.poll(async () => (await snapshot(cameraWindow)).automation.inputPresence).toBe("away");
  expect((await snapshot(cameraWindow)).status).toBe("running");

  const paused = await report(cameraWindow, "away", original.generation);
  expect(paused.status).toBe("auto-paused");
  expect(paused.automation.pauseReason).toBe("camera-away");
  await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  await expect.poll(async () => (await snapshot(cameraWindow)).automation.inputPresence).toBe("present");
  expect((await snapshot(cameraWindow)).remainingMs).toBe(paused.remainingMs);
  expect((await report(cameraWindow, "present", original.generation)).status).toBe("running");

  await cameraWindow.getByRole("button", { name: "暂停计时" }).click();
  const manuallyPaused = await report(cameraWindow, "away", original.generation);
  expect((await report(cameraWindow, "present", original.generation)).status).toBe("manual-paused");
  expect((await snapshot(cameraWindow)).remainingMs).toBe(manuallyPaused.remainingMs);
  await cameraWindow.getByRole("button", { name: "继续计时" }).click();
  await application.evaluate(({ powerMonitor }) => { powerMonitor.emit("suspend"); });
  expect(await cameraState(cameraWindow)).toMatchObject({ enabled: false });
  const suspended = await snapshot(cameraWindow);
  expect(suspended.status).toBe("auto-paused");
  expect(suspended.automation.cameraPresence).toBe("unknown");
  expect(await rejectedReport(cameraWindow, original.generation)).toContain("会话已失效");
  await application.evaluate(({ powerMonitor }) => { powerMonitor.emit("resume"); });
  const resumed = await cameraState(cameraWindow);
  expect(resumed.enabled).toBe(true);
  expect(resumed.generation).toBeGreaterThan(original.generation);
  expect(await rejectedReport(cameraWindow, original.generation)).toContain("会话已失效");
  expect((await snapshot(cameraWindow)).status).toBe("auto-paused");
  expect((await snapshot(cameraWindow)).remainingMs).toBe(suspended.remainingMs);
  expect((await report(cameraWindow, "present", resumed.generation)).status).toBe("running");
});


test("falls back visibly when a previously live camera stops sending heartbeats", async ({ cameraWindow }) => {
  await probeCamera(cameraWindow, "pending");
  await cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
  const original = await cameraState(cameraWindow);
  await report(cameraWindow, "present", original.generation);
  await expect(cameraWindow.getByRole("button", { name: "暂停计时" })).toBeVisible();
  await expect(cameraWindow.getByRole("alert")).toContainText("响应超时", { timeout: 8_000 });
  await expect(cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" })).toBeVisible();
  expect(await cameraState(cameraWindow)).toMatchObject({ enabled: false });
  expect((await snapshot(cameraWindow)).automation.activePresenceSource).toBe("input");
  expect((await snapshot(cameraWindow)).status).toBe("running");
  expect(await rejectedReport(cameraWindow, original.generation)).toContain("会话已失效");
});

test("invalidates camera reports across a renderer reload", async ({ cameraWindow }) => {
  await probeCamera(cameraWindow, "pending");
  await cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
  const original = await cameraState(cameraWindow);
  await report(cameraWindow, "present", original.generation);
  await expect(cameraWindow.getByRole("button", { name: "暂停计时" })).toBeVisible();
  await cameraWindow.reload();
  await expect(cameraWindow.getByRole("button", { name: "感知模式：监控，切换为触控" })).toBeVisible();
  const restored = await cameraState(cameraWindow);
  expect(restored.enabled).toBe(true);
  expect(restored.generation).toBeGreaterThan(original.generation);
  expect(await rejectedReport(cameraWindow, original.generation)).toContain("会话已失效");
  expect((await snapshot(cameraWindow)).status).toBe("auto-paused");
  expect((await snapshot(cameraWindow)).automation.cameraPresence).toBe("unknown");
  expect((await report(cameraWindow, "present", restored.generation)).status).toBe("running");
});

test("keeps camera readiness across same-document navigation and renews it only on a real reload", async ({ cameraWindow }) => {
  await probeCamera(cameraWindow, "pending");
  await cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
  const original = await cameraState(cameraWindow);
  expect(original.enabled).toBe(true);
  expect((await report(cameraWindow, "present", original.generation)).status).toBe("running");

  const expectSameSession = async (hash: string) => {
    await expect.poll(() => cameraWindow.evaluate(() => location.hash)).toBe(hash);
    expect(await cameraState(cameraWindow)).toEqual(original);
    await expect.poll(() => cameraWindow.evaluate(() => (Reflect.get(window, "cameraTestProbe") as CameraProbe).requests)).toBe(1);
    expect((await report(cameraWindow, "present", original.generation)).status).toBe("running");
  };
  await expectSameSession("#timer");
  await cameraWindow.getByRole("button", { name: "更多操作" }).click();
  await cameraWindow.getByRole("menuitem", { name: "打开设置" }).click();
  await expect(cameraWindow.getByRole("heading", { name: "设置" })).toBeVisible();
  await expectSameSession("#settings");
  await cameraWindow.getByRole("button", { name: "返回计时器" }).click();
  await expect(cameraWindow.getByRole("heading", { name: "专注" })).toBeVisible();
  await expectSameSession("#timer");
  await cameraWindow.getByRole("button", { name: "打开统计" }).click();
  await expect(cameraWindow.getByRole("heading", { name: "统计" })).toBeVisible();
  await expectSameSession("#stats");

  await cameraWindow.reload();
  await expect(cameraWindow.getByRole("heading", { name: "统计" })).toBeVisible();
  await expect.poll(async () => (await cameraState(cameraWindow)).enabled).toBe(true);
  const restored = await cameraState(cameraWindow);
  expect(restored.generation).toBeGreaterThan(original.generation);
  expect(await rejectedReport(cameraWindow, original.generation)).toContain("会话已失效");
  expect((await report(cameraWindow, "present", restored.generation)).status).toBe("running");
  await expect.poll(() => cameraWindow.evaluate(() => (Reflect.get(window, "cameraTestProbe") as CameraProbe).requests)).toBe(1);
});

test("starts camera focus and active rest automatically while desk rest keeps the input threshold", async ({ application, cameraWindow }) => {
  await probeCamera(cameraWindow, "pending");
  const switchMode = cameraWindow.getByRole("button", { name: "感知模式：触控，切换为监控" });
  const order = await cameraWindow.locator(".titleActions > button, .titleActions > .timerMenuContainer > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")));
  expect(order).toEqual(["感知模式：触控，切换为监控", "打开统计", "更多操作"]);
  await switchMode.click();
  const session = await cameraState(cameraWindow);
  expect((await report(cameraWindow, "present", session.generation)).status).toBe("running");
  await cameraWindow.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await cameraWindow.keyboard.press("Space");
  expect((await snapshot(cameraWindow)).status).toBe("manual-paused");
  expect((await report(cameraWindow, "present", session.generation)).status).toBe("manual-paused");
  await cameraWindow.keyboard.press("Space");
  expect((await snapshot(cameraWindow)).status).toBe("running");
  await cameraWindow.evaluate(() => window.pomodoro.command("next"));
  expect((await snapshot(cameraWindow)).automation.activePresenceSource).toBe("camera");
  expect((await report(cameraWindow, "present", session.generation)).status).toBe("auto-paused");
  expect((await report(cameraWindow, "away", session.generation)).status).toBe("running");
  const paused = await cameraWindow.evaluate(() => window.pomodoro.command("pause"));
  expect(paused.automation.manualPauseLocked).toBe(false);
  expect((await report(cameraWindow, "away", session.generation)).status).toBe("running");
  await cameraWindow.evaluate(() => window.pomodoro.command("next"));
  expect((await report(cameraWindow, "present", session.generation)).status).toBe("running");
  await cameraWindow.evaluate(() => window.pomodoro.updateSettings({ defaultBreakMode: "desk" }));
  await cameraWindow.evaluate(() => window.pomodoro.command("next"));
  expect((await snapshot(cameraWindow)).automation.activePresenceSource).toBe("input");
  expect((await report(cameraWindow, "away", session.generation)).status).toBe("auto-paused");
  await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 40; });
  await expect.poll(async () => (await snapshot(cameraWindow)).status).toBe("running");
});

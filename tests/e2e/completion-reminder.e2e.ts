import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ReminderApi } from "../../apps/desktop/src/shared/reminder";

const packagedExecutable = process.env.POMODORO_REMINDER_EXECUTABLE;
const applicationArguments = (userData: string) => [
  ...(packagedExecutable ? [] : [join(process.cwd(), "out/main/index.js")]),
  `--user-data-dir=${userData}`,
];

async function advance(application: ElectronApplication, milliseconds: number): Promise<void> {
  await application.evaluate((_electron, elapsed) => {
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, "now", { configurable: true, value: () => now() + elapsed });
  }, milliseconds);
}

async function readReminder(page: Page) {
  return page.evaluate(() => (window as unknown as { pomodoro: ReminderApi }).pomodoro.getReminder());
}

async function establishProbeFocus(application: ElectronApplication, id: number) {
  const before = await application.evaluate(({ app, BrowserWindow }, id) => {
    const other = BrowserWindow.fromId(id);
    if (!other) throw new Error("Typing probe window is missing");
    const state = { hidden: process.platform === "darwin" ? app.isHidden() : null,
      probeFocused: other.isFocused(), focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null };
    // Establish native application activation before testing that the later
    // reminder leaves the probe focused; showing the probe alone may not activate macOS.
    if (process.platform === "darwin") app.focus({ steal: true });
    other.focus();
    return state;
  }, id);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(id);
  const after = await application.evaluate(({ app, BrowserWindow }, id) => ({
    hidden: process.platform === "darwin" ? app.isHidden() : null,
    probeFocused: BrowserWindow.fromId(id)?.isFocused() ?? false,
    focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
  }), id);
  return { before, after };
}

test("saves a one-minute focus, completes it naturally and reloads the setting", async ({}, testInfo) => {
  const userData = testInfo.outputPath("user-data");
  mkdirSync(userData, { recursive: true });
  const launch = () => electron.launch({
    executablePath: packagedExecutable,
    args: applicationArguments(userData),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  let application = await launch();
  try {
    const timer = await application.firstWindow();
    await expect(timer.getByRole("button", { name: "开始计时" })).toBeVisible();
    await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    await timer.getByRole("button", { name: "更多操作" }).click();
    await timer.getByRole("menuitem", { name: "打开设置" }).click();
    await expect(timer.getByLabel("专注时长")).toHaveAttribute("min", "1");
    await timer.getByLabel("专注时长").fill("1");
    await timer.getByRole("button", { name: "保存设置" }).click();
    await expect(timer.getByText("已保存", { exact: true })).toBeVisible();
    expect((await timer.evaluate(() => window.pomodoro.getSettings())).focusDurationSeconds).toBe(60);
    expect((await timer.evaluate(() => window.pomodoro.getSnapshot())).round.totalDurationMs).toBe(1_800_000);
    await timer.getByRole("button", { name: "返回计时器" }).click();
    await timer.getByRole("button", { name: "跳到下一轮" }).click();
    await timer.getByRole("button", { name: "跳到下一轮" }).click();
    await expect(timer.locator("time")).toHaveText("01:00");
    await timer.getByRole("button", { name: "开始计时" }).click();
    await advance(application, 30_000);
    expect((await timer.evaluate(() => window.pomodoro.getSnapshot())).remainingMs).toBeGreaterThan(0);
    const reminderReady = application.waitForEvent("window");
    await advance(application, 30_001);
    const reminder = await reminderReady;
    await expect(reminder.getByRole("heading", { name: "专注完成" })).toBeVisible();
    expect((await timer.evaluate(() => window.pomodoro.getStatistics())).today.completedFocusMinutes).toBe(1);
    expect((await timer.evaluate(() => window.pomodoro.getStatistics())).today.completedFocusRounds).toBe(1);
    await reminder.getByRole("button", { name: "知道了", exact: true }).click();
    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await restored.waitForFunction(() => Boolean(window.pomodoro));
    expect((await restored.evaluate(() => window.pomodoro.getSettings())).focusDurationSeconds).toBe(60);
    expect((await restored.evaluate(() => window.pomodoro.getStatistics())).today.completedFocusMinutes).toBe(1);
  } finally {
    await application.close();
  }
});

test("shows a silent persistent completion card over another window without taking focus", async ({}, testInfo) => {
  const userData = testInfo.outputPath("user-data");
  mkdirSync(userData, { recursive: true });
  const application = await electron.launch({
    executablePath: packagedExecutable,
    args: applicationArguments(userData),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  try {
    const timer = await application.firstWindow();
    await expect(timer.getByRole("button", { name: "开始计时" })).toBeVisible();
    await application.evaluate(({ Notification, powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0;
      Reflect.set(globalThis, "testNativeNotifications", 0);
      Notification.prototype.show = function () {
        Reflect.set(globalThis, "testNativeNotifications", Number(Reflect.get(globalThis, "testNativeNotifications")) + 1);
      };
    });
    await timer.evaluate(() => window.pomodoro.command("start"));
    const otherWindowEvent = application.waitForEvent("window");
    const otherId = await application.evaluate(async ({ BrowserWindow }) => {
      const timer = BrowserWindow.getAllWindows()[0]!;
      timer.hide();
      const other = new BrowserWindow({ width: 500, height: 300, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      await other.loadURL("data:text/html,<title>Typing probe</title><input aria-label='Work input' autofocus>");
      other.show();
      other.focus();
      return other.id;
    });
    const other = await otherWindowEvent;
    await other.getByRole("textbox", { name: "Work input" }).fill("before");
    const focusPreparation = await establishProbeFocus(application, otherId);
    await testInfo.attach("native-focus-precondition", { body: JSON.stringify(focusPreparation), contentType: "application/json" });
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(otherId);

    const reminderEvent = application.waitForEvent("window", { timeout: 5_000 });
    await advance(application, 1_800_001);
    const reminder = await reminderEvent;
    await expect(reminder.getByRole("heading", { name: "专注完成" })).toBeVisible();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(otherId);
    await other.getByRole("textbox", { name: "Work input" }).press("End");
    await other.getByRole("textbox", { name: "Work input" }).pressSequentially(" after");
    await expect(other.getByRole("textbox", { name: "Work input" })).toHaveValue("before after");
    const completed = await readReminder(reminder);
    expect(completed).toMatchObject({ completedKind: "focus", nextKind: "short-break" });
    expect(await application.evaluate(() => Reflect.get(globalThis, "testNativeNotifications"))).toBe(0);
    expect(await reminder.evaluate(() => ({ keys: Object.keys(window.pomodoro).sort(), node: typeof process, require: typeof globalThis.require })))
      .toEqual({ keys: ["dismissReminder", "getReminder", "subscribeReminder"], node: "undefined", require: "undefined" });
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().endsWith("reminder.html")).length)).toBe(1);
    const snapshot = await timer.evaluate(() => window.pomodoro.getSnapshot());
    expect(snapshot.round.kind).toBe("short-break");
    expect(snapshot.status).toBe("auto-paused");

    // Another tick and a manual skip must neither duplicate nor acknowledge a completed round.
    await advance(application, 20_000);
    await timer.evaluate(() => window.pomodoro.command("next"));
    expect(await readReminder(reminder)).toEqual(completed);
    await expect(reminder.getByRole("button", { name: "知道了", exact: true })).toBeVisible();
    await reminder.getByRole("button", { name: "知道了", exact: true }).click();
    await expect.poll(() => readReminder(reminder)).toBeNull();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("reminder.html"))?.isVisible())).toBe(false);
    expect((await timer.evaluate(() => window.pomodoro.getSnapshot())).round.kind).toBe("focus");
    expect((await timer.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("idle");
  } finally {
    await application.close();
  }
});

test("replaces older reminders without gating automatic rest and honors lock, opt-out and restart", async ({}, testInfo) => {
  test.setTimeout(45_000);
  const userData = testInfo.outputPath("user-data");
  mkdirSync(userData, { recursive: true });
  const launch = () => electron.launch({
    executablePath: packagedExecutable,
    args: applicationArguments(userData),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  let application = await launch();
  try {
    const timer = await application.firstWindow();
    await expect(timer.getByRole("button", { name: "开始计时" })).toBeVisible();
    await application.evaluate(({ Notification, powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0;
      Notification.isSupported = () => false;
    });
    await timer.evaluate(() => window.pomodoro.updateSettings({ theme: "light" }));
    await timer.evaluate(() => window.pomodoro.command("start"));
    const reminderEvent = application.waitForEvent("window");
    await advance(application, 1_800_001);
    const reminder = await reminderEvent;
    await expect(reminder.getByRole("heading", { name: "专注完成" })).toBeVisible();
    const first = await readReminder(reminder);
    expect(first).not.toBeNull();
    await reminder.screenshot({ path: testInfo.outputPath("completion-focus-light.png") });
    await timer.evaluate(() => window.pomodoro.updateSettings({ theme: "dark" }));
    await expect(reminder.locator("html")).toHaveAttribute("data-theme", "dark");
    await reminder.screenshot({ path: testInfo.outputPath("completion-focus-dark.png") });
    const geometry = await reminder.getByRole("button", { name: "知道了", exact: true }).evaluate((button) => {
      const box = button.getBoundingClientRect();
      return { fits: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth, overflow: document.documentElement.scrollHeight > innerHeight };
    });
    expect(geometry).toEqual({ fits: true, overflow: false });

    await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 60; });
    await expect.poll(async () => (await timer.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("running");
    // No acknowledgment is needed for the break to count and naturally finish.
    await advance(application, 300_001);
    await expect(reminder.getByRole("heading", { name: "休息结束" })).toBeVisible();
    const latest = await readReminder(reminder);
    expect(latest).toMatchObject({ id: first!.id + 1, completedKind: "short-break", nextKind: "focus" });
    expect(await reminder.evaluate((id) => (window as unknown as { pomodoro: ReminderApi }).pomodoro.dismissReminder(id), first!.id)).toBe(false);
    expect(await readReminder(reminder)).toEqual(latest);
    expect((await timer.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("idle");

    const visible = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("reminder.html"))?.isVisible());
    await application.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect.poll(visible).toBe(false);
    expect(await readReminder(reminder)).toEqual(latest);
    await application.evaluate(({ powerMonitor }) => { powerMonitor.emit("unlock-screen"); });
    await expect.poll(visible).toBe(true);

    await timer.evaluate(() => window.pomodoro.updateSettings({ notificationsEnabled: false }));
    await expect.poll(() => readReminder(reminder)).toBeNull();
    await expect.poll(visible).toBe(false);
    await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    await timer.evaluate(() => window.pomodoro.command("start"));
    await advance(application, 1_800_001);
    await expect.poll(async () => (await timer.evaluate(() => window.pomodoro.getSnapshot())).round.kind).toBe("short-break");
    expect((await timer.evaluate(() => window.pomodoro.getStatistics())).today.completedFocusRounds).toBe(2);
    expect(await readReminder(reminder)).toBeNull();
    await timer.evaluate(() => window.pomodoro.updateSettings({ notificationsEnabled: true }));
    expect(await readReminder(reminder)).toBeNull();

    await application.close();
    application = await launch();
    const restored = await application.firstWindow();
    await restored.waitForFunction(() => Boolean(window.pomodoro));
    expect((await restored.evaluate(() => window.pomodoro.getStatistics())).today.completedFocusRounds).toBe(2);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await application.close();
  }
});

test("keeps a focus card through standing and replaces it on completion while renewing camera presence", async ({}, testInfo) => {
  const userData = testInfo.outputPath("standing-reminder-user-data");
  mkdirSync(userData, { recursive: true });
  const application = await electron.launch({
    executablePath: packagedExecutable,
    args: [...applicationArguments(userData), "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  try {
    const timer = await application.firstWindow();
    await expect(timer.getByRole("button", { name: "开始计时" })).toBeVisible();
    await timer.addInitScript(() => {
      Reflect.set(window, "standingCameraRequests", 0);
      navigator.mediaDevices.getUserMedia = () => {
        Reflect.set(window, "standingCameraRequests", Number(Reflect.get(window, "standingCameraRequests")) + 1);
        return new Promise<MediaStream>(() => {});
      };
    });
    await timer.reload();
    await expect(timer.getByRole("button", { name: "开始计时" })).toBeVisible();
    await application.evaluate(({ Notification, powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0;
      Reflect.set(globalThis, "standingNativeNotifications", 0);
      Notification.prototype.show = function () {
        Reflect.set(globalThis, "standingNativeNotifications", Number(Reflect.get(globalThis, "standingNativeNotifications")) + 1);
      };
    });
    await timer.evaluate(async () => {
      await window.pomodoro.updateSettings({ focusDurationSeconds: 60, shortBreakDurationSeconds: 60 });
      await window.pomodoro.command("next");
      await window.pomodoro.command("next");
    });
    await expect(timer.locator("time")).toHaveText("01:00");
    await timer.getByRole("button", { name: "开始计时" }).click();
    const otherWindowEvent = application.waitForEvent("window");
    const otherId = await application.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 500, height: 300, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      await other.loadURL("data:text/html,<title>Standing typing probe</title><input aria-label='Work input' autofocus>");
      other.show();
      other.focus();
      return other.id;
    });
    const other = await otherWindowEvent;
    await other.getByRole("textbox", { name: "Work input" }).fill("working");
    const focusPreparation = await establishProbeFocus(application, otherId);
    await testInfo.attach("native-focus-precondition", { body: JSON.stringify(focusPreparation), contentType: "application/json" });
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(otherId);

    const reminderReady = application.waitForEvent("window");
    await advance(application, 60_001);
    const reminder = await reminderReady;
    await expect(reminder.getByRole("heading", { name: "专注完成" })).toBeVisible();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(otherId);
    const focusCard = await readReminder(reminder);
    expect(focusCard).toMatchObject({ completedKind: "focus", nextKind: "short-break" });
    const completedFocus = (await timer.evaluate(() => window.pomodoro.getStatistics())).today;
    expect(completedFocus).toMatchObject({ completedFocusMinutes: 1, completedFocusRounds: 1 });
    expect(await timer.evaluate(() => window.pomodoro.getSnapshot())).toMatchObject({
      status: "auto-paused", round: { kind: "short-break", totalDurationMs: 60_000 },
    });

    await timer.getByRole("button", { name: "感知模式：触控，切换为监控" }).click();
    await expect.poll(() => timer.evaluate(() => Reflect.get(window, "standingCameraRequests"))).toBe(1);
    const originalCamera = await timer.evaluate(() => window.pomodoro.getCameraState());
    expect(originalCamera.enabled).toBe(true);
    // A controlled present sample keeps ordinary camera rest in preparation;
    // the pending detector cannot introduce an away sample before the choice.
    const waiting = await timer.evaluate((generation) => window.pomodoro.reportCameraPresence("present", generation), originalCamera.generation);
    expect(waiting).toMatchObject({ status: "auto-paused", automation: { activePresenceSource: "camera" } });
    await timer.getByRole("button", { name: "切换大站", exact: true }).click();
    await expect(timer.getByRole("heading", { name: "大站短休" })).toBeVisible();
    const standing = await timer.evaluate(() => window.pomodoro.getSnapshot());
    expect(standing).toMatchObject({
      status: "running", round: { breakMode: "standing", totalDurationMs: 120_000 },
      automation: { activePresenceSource: "none" },
    });
    expect((await timer.evaluate(() => window.pomodoro.getCameraState())).enabled).toBe(false);
    expect((await timer.evaluate(() => window.pomodoro.getSettings())).focusPresenceSource).toBe("camera");
    expect(await readReminder(reminder)).toEqual(focusCard);
    await timer.getByRole("button", { name: "切回普通休息" }).click();
    await expect.poll(() => timer.evaluate(() => Reflect.get(window, "standingCameraRequests"))).toBe(2);
    const ordinaryCamera = await timer.evaluate(() => window.pomodoro.getCameraState());
    expect(ordinaryCamera.enabled).toBe(true);
    expect(ordinaryCamera.generation).toBeGreaterThan(originalCamera.generation);
    await expect(timer.evaluate((generation) => window.pomodoro.reportCameraPresence("away", generation), originalCamera.generation)).rejects.toThrow("会话已失效");
    expect(await timer.evaluate(() => window.pomodoro.getSnapshot())).toMatchObject({
      status: "auto-paused", round: { breakMode: "active", totalDurationMs: 60_000 },
      automation: { activePresenceSource: "camera", cameraPresence: "unknown" },
    });
    expect(await readReminder(reminder)).toEqual(focusCard);
    const ordinary = await timer.evaluate((generation) => window.pomodoro.reportCameraPresence("away", generation), ordinaryCamera.generation);
    expect(ordinary.status).toBe("running");
    await timer.getByRole("button", { name: "切换大站", exact: true }).click();
    await expect(timer.getByRole("heading", { name: "大站短休" })).toBeVisible();
    const standingRemaining = (await timer.evaluate(() => window.pomodoro.getSnapshot())).remainingMs;
    await expect(reminder.getByRole("button", { name: "知道了", exact: true })).toBeVisible();
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.focus(), otherId);
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(otherId);

    await advance(application, standingRemaining + 1);
    await expect(reminder.getByRole("heading", { name: "休息结束" })).toBeVisible();
    const restCard = await readReminder(reminder);
    expect(restCard).toMatchObject({ id: focusCard!.id + 1, completedKind: "short-break", nextKind: "focus" });
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(otherId);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().endsWith("reminder.html")).length)).toBe(1);
    expect((await timer.evaluate(() => window.pomodoro.getStatistics())).today).toEqual(completedFocus);
    expect(await application.evaluate(() => Reflect.get(globalThis, "standingNativeNotifications"))).toBe(0);
    expect(await reminder.evaluate(() => ({ keys: Object.keys(window.pomodoro).sort(), node: typeof process, require: typeof globalThis.require })))
      .toEqual({ keys: ["dismissReminder", "getReminder", "subscribeReminder"], node: "undefined", require: "undefined" });
    await expect.poll(() => timer.evaluate(() => Reflect.get(window, "standingCameraRequests"))).toBe(3);
    const renewedCamera = await timer.evaluate(() => window.pomodoro.getCameraState());
    expect(renewedCamera.enabled).toBe(true);
    expect(renewedCamera.generation).toBeGreaterThan(originalCamera.generation);
    expect(await timer.evaluate(() => window.pomodoro.getSnapshot())).toMatchObject({
      status: "idle", round: { kind: "focus", breakMode: null }, automation: { activePresenceSource: "camera", cameraPresence: "unknown" },
    });
    const staleResult = await timer.evaluate(async (generation) => {
      try { await window.pomodoro.reportCameraPresence("present", generation); return "accepted"; }
      catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
    }, originalCamera.generation);
    expect(staleResult).toContain("会话已失效");
    const resumed = await timer.evaluate((generation) => window.pomodoro.reportCameraPresence("present", generation), renewedCamera.generation);
    expect(resumed).toMatchObject({ status: "running", round: { kind: "focus" } });
    expect(await reminder.evaluate((id) => (window as unknown as { pomodoro: ReminderApi }).pomodoro.dismissReminder(id), focusCard!.id)).toBe(false);
    expect(await readReminder(reminder)).toEqual(restCard);
    await reminder.getByRole("button", { name: "知道了", exact: true }).click();
    await expect.poll(() => readReminder(reminder)).toBeNull();
    expect((await timer.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("running");
  } finally {
    await application.close();
  }
});

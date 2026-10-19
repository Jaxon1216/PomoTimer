import { test as baseTest, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { PomodoroApi } from "../../apps/desktop/src/shared/contracts";

const workspaceRoot = process.cwd();
const desktopDirectory = existsSync(join(workspaceRoot, "apps/desktop/out/main/index.js"))
  ? join(workspaceRoot, "apps/desktop")
  : workspaceRoot;
const applicationEntry = join(desktopDirectory, "out", "main", "index.js");

type DesktopRuntime = ReturnType<typeof import("../../apps/desktop/src/main/index").inspectDesktopRuntime>;
type LaunchApplication = (userDataDirectory: string) => Promise<ElectronApplication>;

const test = baseTest.extend<{ launchApplication: LaunchApplication }>({
  launchApplication: async ({}, use, testInfo) => {
    const applications = new Set<ElectronApplication>();
    let launchCount = 0;
    try {
      await use(async (userDataDirectory) => {
        mkdirSync(userDataDirectory, { recursive: true });
        const application = await electron.launch({
          args: [applicationEntry, `--user-data-dir=${userDataDirectory}`],
          cwd: desktopDirectory,
          env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true", POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: userDataDirectory },
        });
        applications.add(application);
        application.on("close", () => applications.delete(application));
        await application.firstWindow();
        const identity = await inspectRuntime(application);
        expect(realpathSync(identity.userData)).toBe(realpathSync(userDataDirectory));
        expect(identity.pid).toBeGreaterThan(0);
        expect(identity.pid).not.toBe(process.pid);
        expect(identity.packaged).toBe(false);
        expect(identity.devServerUrl).toBeNull();
        await testInfo.attach(`electron-identity-${++launchCount}`, {
          body: JSON.stringify(identity, null, 2),
          contentType: "application/json",
        });
        return application;
      });
    } finally {
      await Promise.all([...applications].map((application) => application.close()));
    }
  },
});

async function inspectRuntime(application: ElectronApplication): Promise<DesktopRuntime> {
  return application.evaluate(() => {
    const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect")) as (() => DesktopRuntime) | undefined;
    if (!inspect) throw new Error("Main-process runtime diagnostics were not enabled");
    return inspect();
  });
}

async function settleVisuals(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    document.head.append(style);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function assertTimerGeometry(page: import("@playwright/test").Page): Promise<void> {
  const geometry = await page.locator(".timerDial").evaluate((dial) => {
    const time = dial.querySelector("time");
    const progress = dial.querySelector(".dialProgress");
    const svg = dial.querySelector("svg");
    if (!time || !progress || !svg) throw new Error("Timer geometry nodes are missing");
    const dialBox = dial.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const radius = Number(progress.getAttribute("r"));
    const strokeWidth = Number.parseFloat(getComputedStyle(progress).strokeWidth);
    const scale = dialBox.width / viewBox.width;
    const center = { x: dialBox.left + dialBox.width / 2, y: dialBox.top + dialBox.height / 2 };
    const innerRadius = (radius - strokeWidth / 2) * scale - 1;
    const corners = [
      { x: timeBox.left, y: timeBox.top },
      { x: timeBox.right, y: timeBox.top },
      { x: timeBox.left, y: timeBox.bottom },
      { x: timeBox.right, y: timeBox.bottom },
    ];
    return {
      text: time.textContent,
      dial: { width: dialBox.width, height: dialBox.height },
      time: { width: timeBox.width, height: timeBox.height },
      fitsInsideRing: corners.every((corner) => Math.hypot(corner.x - center.x, corner.y - center.y) <= innerRadius),
    };
  });
  expect(geometry.dial.width).toBeGreaterThanOrEqual(60);
  expect(geometry.dial.width).toBe(geometry.dial.height);
  expect(geometry.text).toMatch(/^\d{2,3}:\d{2}$/);
  expect(geometry.time.width).toBeGreaterThan(0);
  expect(geometry.fitsInsideRing).toBe(true);
}

async function assertControlsFit(page: import("@playwright/test").Page): Promise<void> {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const boxes = await page.locator(".timerControls button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  expect(boxes).toHaveLength(3);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(viewport.height);
  }
  expect(boxes[0]!.right).toBeLessThanOrEqual(boxes[1]!.left);
  expect(boxes[1]!.right).toBeLessThanOrEqual(boxes[2]!.left);
  const stack = await page.locator(".titlebar, .timerDial, .roundMeta, .statePill, .monitorStatus, .timerControls, .timerFooter").evaluateAll((elements) => elements
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { name: element.className, top: box.top, bottom: box.bottom };
    }));
  for (let index = 0; index < stack.length; index += 1) {
    const current = stack[index]!;
    expect(current.top, `${current.name} must stay inside the window`).toBeGreaterThanOrEqual(-0.5);
    expect(current.bottom, `${current.name} must stay inside the window`).toBeLessThanOrEqual(viewport.height + 0.5);
    const next = stack[index + 1];
    if (next) expect(current.bottom, `${current.name} must not overlap ${next.name}`).toBeLessThanOrEqual(next.top + 0.5);
  }
}

async function assertHeaderFit(page: import("@playwright/test").Page): Promise<void> {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const boxes = await page.locator(".titleActions button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
  expect(boxes).toHaveLength(2);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(viewport.height);
  }
  expect(boxes[0]!.right).toBeLessThanOrEqual(boxes[1]!.left);
  const nativeOverlap = await page.locator(".titleActions button, .brand").evaluateAll((elements) => {
    if (document.documentElement.dataset.platform !== "macos") return false;
    return elements.some((element) => {
      if (getComputedStyle(element).display === "none") return false;
      const box = element.getBoundingClientRect();
      return box.left < 80 && box.right > 14 && box.top < 30 && box.bottom > 14;
    });
  });
  expect(nativeOverlap, "Header content must leave room for native window buttons").toBe(false);
}

async function assertPageHeaderFit(page: import("@playwright/test").Page): Promise<void> {
  const geometry = await page.locator(".pageHeader").evaluate((header) => {
    const back = header.querySelector(".backButton")!.getBoundingClientRect();
    const heading = header.querySelector("h1")!.getBoundingClientRect();
    const overlaps = back.left < heading.right && back.right > heading.left && back.top < heading.bottom && back.bottom > heading.top;
    const nativeOverlap = document.documentElement.dataset.platform === "macos"
      && [back, heading].some((box) => box.left < 80 && box.right > 14 && box.top < 30 && box.bottom > 14);
    return { overlaps, nativeOverlap };
  });
  expect(geometry.overlaps, "Page heading and return button must not overlap").toBe(false);
  expect(geometry.nativeOverlap, "Page navigation must leave room for native window buttons").toBe(false);
}

test("starts through the restricted preload bridge, controls the Core, and supports a compact widget", async ({ launchApplication }, testInfo) => {
  const userDataDirectory = testInfo.outputPath("user-data");
  const app = await launchApplication(userDataDirectory);
  // Runner idle time is unrelated to synthetic Playwright input. Keep this
  // control/IPC test deterministic; hardware idle behavior is a separate gate.
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  const window = await app.firstWindow();

  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await expect(window.getByText("30:00")).toBeVisible();
  await settleVisuals(window);
  await assertTimerGeometry(window);
  await assertHeaderFit(window);
  expect(await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 360, height: 478 });
  const platformLayout = await window.evaluate(() => ({
    platform: document.documentElement.dataset.platform,
    titlebarPaddingLeft: getComputedStyle(document.querySelector(".titlebar")!).paddingLeft,
  }));
  if (platformLayout.platform === "macos") expect(Number.parseFloat(platformLayout.titlebarPaddingLeft)).toBeGreaterThanOrEqual(80);
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("timer-light.png") });
  await expect(
    window.getByRole("button", { name: "重新开始当前轮次" }),
  ).toBeEnabled();
  await expect(window.getByRole("button", { name: "跳到下一轮" })).toBeEnabled();
  await window.getByRole("button", { name: "开始计时" }).click();
  await expect(window.getByRole("button", { name: "暂停计时" })).toBeEnabled();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(160, 180);
  });
  await expect(window.locator(".timerSurface")).toHaveClass(/compact/);
  await expect(window.locator("time")).toHaveText(/^\d{2,3}:\d{2}$/);
  await settleVisuals(window);
  await assertTimerGeometry(window);
  await assertControlsFit(window);
  await window.screenshot({ path: testInfo.outputPath("timer-compact.png") });
  for (const label of ["重新开始当前轮次", "暂停计时", "跳到下一轮"]) {
    const box = await window.getByRole("button", { name: label }).boundingBox();
    const viewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(box, `${label} should have a layout box`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }
  await window.getByRole("button", { name: "暂停计时" }).click();
  await expect(window.getByRole("button", { name: "继续计时" })).toBeEnabled();
  await window.getByRole("button", { name: "继续计时" }).click();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(360, 478);
  });
  await window.getByRole("button", { name: "打开设置" }).click();
  await expect(window.getByRole("heading", { name: "设置" })).toBeVisible();
  await assertPageHeaderFit(window);
  await window.getByRole("button", { name: "深色" }).click();
  await window.getByRole("checkbox", { name: "常驻顶部" }).check();
  await window.getByRole("button", { name: "保存设置" }).click();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true);
  await window.screenshot({ path: testInfo.outputPath("settings-dark.png") });
  await window.getByRole("button", { name: /计时器/ }).click();
  await window.getByRole("button", { name: "打开统计" }).click();
  await expect(window.getByRole("heading", { name: "统计" })).toBeVisible();
  await assertPageHeaderFit(window);
  await window.screenshot({ path: testInfo.outputPath("stats-dark.png") });

  const bridgeShape = await window.evaluate(() => ({
    apiKeys: Object.keys(
      (globalThis as typeof globalThis & { pomodoro: PomodoroApi }).pomodoro,
    ).sort(),
    hasNodeProcess: typeof process !== "undefined",
    hasRequire: typeof globalThis.require !== "undefined",
    hasMainInspector: Reflect.has(globalThis, Symbol.for("pomodoro.desktop.inspect")),
  }));
  expect(bridgeShape.apiKeys).toEqual([
    "command",
    "getCapabilities",
    "getSettings",
    "getSnapshot",
    "getStatistics",
    "subscribe",
    "updateSettings",
  ]);
  expect(bridgeShape.hasNodeProcess).toBe(false);
  expect(bridgeShape.hasRequire).toBe(false);
  expect(bridgeShape.hasMainInspector).toBe(false);

  await app.close();

  const restarted = await launchApplication(userDataDirectory);
  await restarted.firstWindow();
  expect(await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true);
  await restarted.close();
});

test("keeps the dial readable through compact sizes and preserves timer state while resizing", async ({ launchApplication }, testInfo) => {
  const userDataDirectory = testInfo.outputPath("user-data");
  const app = await launchApplication(userDataDirectory);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.getByText("30:00")).toBeVisible();
  await settleVisuals(window);

  await window.getByRole("button", { name: "开始计时" }).click();
  const runningBeforeResize = await window.evaluate(() => window.pomodoro.getSnapshot());
  await window.waitForTimeout(650);
  const runningAfterResizeDelay = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(runningAfterResizeDelay.status).toBe("running");
  expect(runningAfterResizeDelay.remainingMs).toBeLessThan(runningBeforeResize.remainingMs);
  await window.getByRole("button", { name: "暂停计时" }).click();
  const pausedBeforeResize = await window.evaluate(() => window.pomodoro.getSnapshot());

  const sizes = [
    [160, 180],
    [200, 240],
    [240, 300],
    [360, 180],
    [160, 478],
    [360, 478],
    [300, 390],
    [301, 390],
    [301, 391],
  ] as const;
  for (const [width, height] of sizes) {
    await app.evaluate(({ BrowserWindow }, nextSize) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextSize.width, nextSize.height);
    }, { width, height });
    await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
    await settleVisuals(window);
    await assertTimerGeometry(window);
    await assertHeaderFit(window);
    await assertControlsFit(window);
    await window.screenshot({ path: testInfo.outputPath(`timer-${width}x${height}.png`) });
  }

  await window.waitForTimeout(650);
  const pausedAfterResize = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(pausedAfterResize.status).toBe("manual-paused");
  expect(pausedAfterResize.remainingMs).toBe(pausedBeforeResize.remainingMs);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(160, 180);
  });
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 160, height: 180 });
  await window.getByRole("button", { name: "打开设置" }).click();
  await expect(window.getByRole("heading", { name: "设置" })).toBeVisible();
  await settleVisuals(window);
  await assertPageHeaderFit(window);
  const settingsBack = await window.getByRole("button", { name: /计时器/ }).boundingBox();
  const saveButton = await window.getByRole("button", { name: "保存设置" }).boundingBox();
  expect(settingsBack).not.toBeNull();
  expect(saveButton).not.toBeNull();
  expect(settingsBack!.x).toBeGreaterThanOrEqual(0);
  expect(settingsBack!.x + settingsBack!.width).toBeLessThanOrEqual(160);
  expect(saveButton!.x).toBeGreaterThanOrEqual(0);
  expect(saveButton!.x + saveButton!.width).toBeLessThanOrEqual(160);
  await window.screenshot({ path: testInfo.outputPath("settings-160x180.png") });
  await window.getByRole("button", { name: /计时器/ }).click();
  await window.getByRole("button", { name: "打开统计" }).click();
  await expect(window.getByRole("heading", { name: "统计" })).toBeVisible();
  await settleVisuals(window);
  await assertPageHeaderFit(window);
  const statsBack = await window.getByRole("button", { name: /计时器/ }).boundingBox();
  expect(statsBack).not.toBeNull();
  expect(statsBack!.x).toBeGreaterThanOrEqual(0);
  expect(statsBack!.x + statsBack!.width).toBeLessThanOrEqual(160);
  await window.screenshot({ path: testInfo.outputPath("stats-160x180.png") });

  await window.getByRole("button", { name: /计时器/ }).click();
  await window.getByRole("button", { name: "打开设置" }).click();
  await window.getByRole("button", { name: "浅色" }).click();
  await window.getByRole("button", { name: "保存设置" }).click();
  await window.getByRole("button", { name: /计时器/ }).click();
  await window.getByRole("button", { name: "打开设置" }).click();
  await window.getByRole("button", { name: "深色" }).click();
  await window.getByRole("button", { name: "保存设置" }).click();

  await window.getByLabel("专注时长").fill("120");
  await window.getByRole("button", { name: "保存设置" }).click();
  await window.getByRole("button", { name: /计时器/ }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.locator("time")).toHaveText("120:00");
  for (const [width, height] of [[160, 180], [360, 180], [301, 391]] as const) {
    await app.evaluate(({ BrowserWindow }, nextSize) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(nextSize.width, nextSize.height);
    }, { width, height });
    await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
    await settleVisuals(window);
    await assertTimerGeometry(window);
    await assertControlsFit(window);
    await window.screenshot({ path: testInfo.outputPath(`timer-120min-${width}x${height}.png`) });
  }

  await app.close();
});

test("covers breaks, automatic pause states, themes, and compact settings interactions", async ({ launchApplication }, testInfo) => {
  const userDataDirectory = testInfo.outputPath("user-data");
  const app = await launchApplication(userDataDirectory);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();

  const assertStateLayout = async (name: string): Promise<void> => {
    await settleVisuals(window);
    await assertTimerGeometry(window);
    await assertHeaderFit(window);
    await assertControlsFit(window);
    await window.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  };

  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.getByRole("heading", { name: "短休" })).toBeVisible();
  await assertStateLayout("short-break");
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.getByRole("heading", { name: "长休" })).toBeVisible();
  await expect(window.getByText("等待离席后开始休息")).toBeVisible();
  await assertStateLayout("long-break-auto-paused");

  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 120; });
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "开始计时" }).click();
  await expect(window.getByText("离席，已自动暂停")).toBeVisible({ timeout: 4_000 });
  await assertStateLayout("focus-auto-paused");

  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => { throw new Error("input source unavailable in test"); };
  });
  await window.getByRole("button", { name: "继续计时" }).click();
  await expect(window.getByText("输入检测不可用 · 手动控制模式")).toBeVisible({ timeout: 4_000 });
  await expect(window.getByText("输入检测不可用，需手动控制")).toBeVisible({ timeout: 4_000 });
  await assertStateLayout("input-source-unavailable");

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(160, 180); });
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 160, height: 180 });
  await window.getByRole("button", { name: "打开设置" }).click();
  await expect(window.getByRole("heading", { name: "设置" })).toBeVisible();
  await settleVisuals(window);
  const settingsScroll = window.locator(".settingsScroll");
  const scrollMetrics = await settingsScroll.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.scrollWidth).toBeLessThanOrEqual(scrollMetrics.clientWidth);
  await settingsScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(window.getByRole("button", { name: "保存设置" })).toBeVisible();
  await window.getByLabel("专注时长").fill("25");
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.getByText("已保存")).toBeVisible();
  await window.getByRole("button", { name: /计时器/ }).click();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await window.getByRole("button", { name: "打开统计" }).click();
  await expect(window.getByRole("heading", { name: "统计" })).toBeVisible();
  await window.getByRole("button", { name: /计时器/ }).click();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();

  await window.getByRole("button", { name: "打开设置" }).click();
  await window.getByRole("button", { name: "浅色" }).click();
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
  await window.getByRole("button", { name: "跟随系统" }).click();
  await window.emulateMedia({ colorScheme: "dark" });
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(window.locator("html")).toHaveClass(/dark/);
  await window.emulateMedia({ colorScheme: "light" });
  await expect(window.locator("html")).not.toHaveClass(/dark/);
  await app.close();
});

test("creates an identifiable native tray from the template asset without changing the restricted bridge", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  const runtime = await inspectRuntime(app);
  expect(runtime.tray).not.toBeNull();
  expect(runtime.tray!.tooltip).toBe("Pomodoro Timer");
  expect(runtime.tray!.size.width).toBeGreaterThan(0);
  expect(runtime.tray!.size.height).toBeGreaterThan(0);
  if (process.platform === "darwin") {
    expect(runtime.tray!.template).toBe(true);
    expect(runtime.tray!.scales).toEqual(expect.arrayContaining([1, 2]));
    expect(runtime.tray!.bounds.width).toBeGreaterThan(0);
    expect(runtime.tray!.bounds.height).toBeGreaterThan(0);
  }
  await app.close();
});

test("rejects mismatched diagnostic data directories before opening either database", async ({}, testInfo) => {
  const requestedDirectory = testInfo.outputPath("requested-user-data");
  const expectedDirectory = testInfo.outputPath("expected-user-data");
  mkdirSync(requestedDirectory, { recursive: true });
  mkdirSync(expectedDirectory, { recursive: true });
  const executablePath = createRequire(join(desktopDirectory, "package.json"))("electron") as string;
  // The guard exits before Playwright can always attach. Observe the actual child
  // exit directly, with a bounded kill for this test-owned process only.
  const result = spawnSync(executablePath, [applicationEntry, `--user-data-dir=${requestedDirectory}`], {
    cwd: desktopDirectory,
    env: {
      ...process.env,
      POMODORO_DIAGNOSTICS: "1",
      POMODORO_EXPECTED_USER_DATA: expectedDirectory,
    },
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  await testInfo.attach("diagnostic-isolation-rejection", {
    body: JSON.stringify({
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      requestedDirectory,
      expectedDirectory,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2),
    contentType: "application/json",
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("诊断启动的数据目录与预期目录不匹配");
  expect(existsSync(join(requestedDirectory, "pomodoro.sqlite"))).toBe(false);
  expect(existsSync(join(expectedDirectory, "pomodoro.sqlite"))).toBe(false);
});

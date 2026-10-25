import { test as baseTest, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { PomodoroApi, TimerSnapshot } from "../../apps/desktop/src/shared/contracts";

const workspaceRoot = process.cwd();
const desktopDirectory = existsSync(join(workspaceRoot, "apps/desktop/out/main/index.js"))
  ? join(workspaceRoot, "apps/desktop")
  : workspaceRoot;
const applicationEntry = join(desktopDirectory, "out", "main", "index.js");

const representativeSizes = [
  [160, 180], [160, 478], [220, 240], [320, 300], [360, 478],
  [360, 180], [480, 240], [720, 480], [480, 300],
] as const;
const breakpointSizes = [
  [299, 478], [300, 478], [320, 279], [320, 280], [220, 219],
  [220, 220], [359, 180], [360, 180], [360, 240], [360, 241],
] as const;

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

async function waitForInputSamples(application: ElectronApplication, count: number): Promise<void> {
  await application.evaluate(({ powerMonitor }, target) => new Promise<void>((resolve) => {
    const sample = powerMonitor.getSystemIdleTime;
    let observed = 0;
    powerMonitor.getSystemIdleTime = () => {
      const idle = sample();
      if (++observed >= target) {
        powerMonitor.getSystemIdleTime = sample;
        resolve();
      }
      return idle;
    };
  }), count);
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
    const microProgress = dial.querySelector<HTMLElement>(".microProgress");
    if (!time || !progress || !svg || !microProgress) throw new Error("Timer geometry nodes are missing");
    const dialBox = dial.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const lineBox = microProgress.getBoundingClientRect();
    const micro = getComputedStyle(svg).display === "none";
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
      fontSize: Number.parseFloat(getComputedStyle(time).fontSize),
      micro,
      expectedMicro: innerWidth <= 359 && innerHeight <= 219,
      lineVisible: getComputedStyle(microProgress).display !== "none" && lineBox.width > 0 && lineBox.height > 0,
      line: { left: lineBox.left, right: lineBox.right, top: lineBox.top, bottom: lineBox.bottom, height: lineBox.height },
      viewport: { width: innerWidth, height: innerHeight },
      dial: { left: dialBox.left, right: dialBox.right, top: dialBox.top, bottom: dialBox.bottom, width: dialBox.width, height: dialBox.height },
      time: { left: timeBox.left, right: timeBox.right, top: timeBox.top, bottom: timeBox.bottom, width: timeBox.width, height: timeBox.height },
      innerRadius,
      fitsInsideRing: corners.every((corner) => Math.hypot(corner.x - center.x, corner.y - center.y) <= innerRadius),
    };
  });
  const diagnostic = `Timer geometry: ${JSON.stringify(geometry)}`;
  expect(geometry.dial.width, diagnostic).toBeGreaterThanOrEqual(60);
  expect(geometry.text, diagnostic).toMatch(/^\d{2,3}:\d{2}$/);
  expect(geometry.time.width, diagnostic).toBeGreaterThan(0);
  expect(geometry.micro, diagnostic).toBe(geometry.expectedMicro);
  expect(geometry.lineVisible, diagnostic).toBe(geometry.micro);
  for (const box of [geometry.dial, geometry.time]) {
    expect(box.left, diagnostic).toBeGreaterThanOrEqual(-0.5);
    expect(box.right, diagnostic).toBeLessThanOrEqual(geometry.viewport.width + 0.5);
    expect(box.top, diagnostic).toBeGreaterThanOrEqual(-0.5);
    expect(box.bottom, diagnostic).toBeLessThanOrEqual(geometry.viewport.height + 0.5);
  }
  if (geometry.micro) {
    expect(geometry.dial.width, diagnostic).toBeGreaterThan(geometry.dial.height);
    expect(geometry.fontSize, diagnostic).toBeGreaterThanOrEqual(geometry.text!.length > 5 ? 26 : 28);
    expect(geometry.time.left, diagnostic).toBeGreaterThanOrEqual(geometry.dial.left - 0.5);
    expect(geometry.time.right, diagnostic).toBeLessThanOrEqual(geometry.dial.right + 0.5);
    expect(geometry.line.height, diagnostic).toBeLessThanOrEqual(4);
    expect(geometry.line.left, diagnostic).toBeGreaterThanOrEqual(geometry.dial.left - 0.5);
    expect(geometry.line.right, diagnostic).toBeLessThanOrEqual(geometry.dial.right + 0.5);
    expect(geometry.line.top, diagnostic).toBeGreaterThanOrEqual(geometry.time.bottom - 0.5);
    expect(geometry.line.bottom, diagnostic).toBeLessThanOrEqual(geometry.dial.bottom + 0.5);
  } else {
    expect(geometry.dial.width, diagnostic).toBeCloseTo(geometry.dial.height, 1);
    expect(geometry.fitsInsideRing, diagnostic).toBe(true);
  }
}

async function assertControlsFit(page: Page): Promise<void> {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const boxes = await page.locator(".timerControls button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
  }));
  expect(boxes).toHaveLength(2);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(32);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(viewport.height);
  }
  expect(boxes[0]!.right).toBeLessThanOrEqual(boxes[1]!.left);
}

async function readTimerScale(page: Page): Promise<{ dial: number; time: number; title: number }> {
  return page.evaluate(() => {
    const dial = document.querySelector(".timerDial")!;
    const time = dial.querySelector("time")!;
    const title = document.querySelector(".roundMeta h1")!;
    return {
      dial: dial.getBoundingClientRect().width,
      time: Number.parseFloat(getComputedStyle(time).fontSize),
      title: Number.parseFloat(getComputedStyle(title).fontSize),
    };
  });
}

async function assertTimerLayout(page: Page, orientation?: "horizontal" | "vertical"): Promise<void> {
  await assertTimerGeometry(page);
  await assertControlsFit(page);
  await assertHeaderFit(page);
  await expect(page.locator(".roundMeta h1")).toBeVisible();
  await expect(page.locator(".statePill")).toBeVisible();
  await expect(page.locator(".monitorStatus")).toBeVisible();
  const layout = await page.evaluate(() => {
    const selectors = [".titlebar", ".timerDial", ".roundMeta", ".statePill", ".monitorStatus", ".timerControls", ".timerFooter"];
    const elements = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const items = elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { name: element.className, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    const overlaps = elements.flatMap((element, index) => elements.slice(index + 1).flatMap((other) => {
      if (element.contains(other) || other.contains(element)) return [];
      const a = element.getBoundingClientRect();
      const b = other.getBoundingClientRect();
      return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5
        ? [`${element.className} / ${other.className}`] : [];
    }));
    const textElements = [...document.querySelectorAll<HTMLElement>(".statePill, .statePill span, .monitorStatus, .roundMeta h1")];
    const textOverflow = textElements
      .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      .map((element) => element.className);
    const dial = document.querySelector(".timerDial")!.getBoundingClientRect();
    const meta = document.querySelector(".roundMeta")!.getBoundingClientRect();
    const status = document.querySelector(".timerStatus")!.getBoundingClientRect();
    const controls = document.querySelector(".timerControls")!.getBoundingClientRect();
    const visible = (selector: string) => document.querySelector(selector)!.getClientRects().length > 0;
    const state = document.querySelector(".statePill")!;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      items, overlaps, textOverflow,
      horizontal: dial.right <= meta.left + 0.5,
      vertical: meta.bottom <= dial.top + 0.5,
      compact: innerWidth <= 299 || innerHeight <= 279,
      landscape: innerWidth >= 360 && innerHeight <= 240,
      detailsVisible: [".brand", ".statisticsButton", ".dialTotal", ".timerFooter"].map(visible),
      fullStateText: state.textContent?.trim() === state.getAttribute("title"),
      landscapeInformation: [meta, status, controls].every((box) => dial.right <= box.left + 0.5),
      statusBesideControls: status.right <= controls.left + 0.5
        && status.top < controls.bottom && status.bottom > controls.top,
    };
  });
  expect(layout.document.width).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.document.height).toBeLessThanOrEqual(layout.viewport.height);
  for (const item of layout.items) {
    expect(item.left, `${item.name} left`).toBeGreaterThanOrEqual(-0.5);
    expect(item.right, `${item.name} right`).toBeLessThanOrEqual(layout.viewport.width + 0.5);
    expect(item.top, `${item.name} top`).toBeGreaterThanOrEqual(-0.5);
    expect(item.bottom, `${item.name} bottom`).toBeLessThanOrEqual(layout.viewport.height + 0.5);
  }
  expect(layout.overlaps, "Timer regions must not overlap").toEqual([]);
  expect(layout.textOverflow, "Timer status text must fit its allocated space").toEqual([]);
  expect(layout.fullStateText, "The complete timer status must remain visible").toBe(true);
  expect(layout.detailsVisible, "Secondary timer details must follow the available width and height").toEqual(Array<boolean>(4).fill(!layout.compact));
  if (!layout.compact) expect(layout.statusBesideControls, "Full status and controls must share a row").toBe(true);
  if (layout.landscape) expect(layout.landscapeInformation, "Landscape information and controls must stay to the right of the dial").toBe(true);
  const expectedOrientation = orientation ?? (layout.landscape ? "horizontal" : "vertical");
  expect(layout[expectedOrientation], `Expected ${expectedOrientation} timer composition`).toBe(true);
}

async function assertHeaderFit(page: Page): Promise<void> {
  const geometry = await page.locator(".titleActions button, .brand").evaluateAll((elements) => {
    const boxes = elements.filter((element) => element.getClientRects().length > 0).map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      boxes,
      actionsRightMargin: innerWidth - document.querySelector(".titleActions")!.getBoundingClientRect().right,
      nativeOverlap: document.documentElement.dataset.platform === "macos"
        && boxes.some((box) => box.left < 80 && box.right > 14 && box.top < 30 && box.bottom > 14),
    };
  });
  for (const box of geometry.boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  }
  expect(geometry.actionsRightMargin, "Header actions must stay anchored while the brand hides").toBeGreaterThanOrEqual(6);
  expect(geometry.actionsRightMargin).toBeLessThanOrEqual(12);
  expect(geometry.nativeOverlap, "Header content must leave room for native window buttons").toBe(false);
}

async function resizeContent(application: ElectronApplication, page: Page, width: number, height: number, expected = { width, height }): Promise<void> {
  await application.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(expected);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openMore(page: Page): Promise<void> {
  await page.getByRole("button", { name: "更多操作" }).click();
}

async function assertMoreMenuFit(page: Page): Promise<void> {
  await openMore(page);
  const menu = page.getByRole("menu", { name: "计时器操作" });
  await expect(menu).toBeVisible();
  const geometry = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  for (const item of await menu.getByRole("menuitem").all()) {
    await item.scrollIntoViewIfNeeded();
    await expect(item).toBeInViewport({ ratio: 1 });
    expect(await item.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "Menu text must fit without horizontal clipping").toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

async function assertPageHeaderFit(page: import("@playwright/test").Page): Promise<void> {
  const geometry = await page.locator(".pageHeader").evaluate((header) => {
    const back = header.querySelector(".backButton")!.getBoundingClientRect();
    const heading = header.querySelector("h1")!.getBoundingClientRect();
    const overlaps = back.left < heading.right && back.right > heading.left && back.top < heading.bottom && back.bottom > heading.top;
    const nativeOverlap = document.documentElement.dataset.platform === "macos"
      && [back, heading].some((box) => box.left < 80 && box.right > 14 && box.top < 30 && box.bottom > 14);
    return {
      overlaps, nativeOverlap,
      fitsViewport: [back, heading].every((box) => box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight),
    };
  });
  expect(geometry.overlaps, "Page heading and return button must not overlap").toBe(false);
  expect(geometry.nativeOverlap, "Page navigation must leave room for native window buttons").toBe(false);
  expect(geometry.fitsViewport, "Page navigation must remain inside the window").toBe(true);
}

test("starts through the restricted preload bridge and preserves native settings", async ({ launchApplication }, testInfo) => {
  const userDataDirectory = testInfo.outputPath("user-data");
  const app = await launchApplication(userDataDirectory);
  // Runner idle time is unrelated to synthetic Playwright input. Hardware idle
  // integration remains a real-platform verification gate.
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();

  // A cold Windows runner can still be loading the renderer after the default
  // interactive assertion timeout; startup has its own bounded budget.
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible({ timeout: 15_000 });
  await expect(window.locator("time")).toHaveText("30:00");
  await settleVisuals(window);
  await assertTimerLayout(window, "vertical");
  expect(await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 360, height: 478 });
  await window.screenshot({ path: testInfo.outputPath("timer-light.png") });
  await window.getByRole("button", { name: "开始计时" }).click();
  await expect(window.getByRole("button", { name: "暂停计时" })).toBeEnabled();
  await window.getByRole("button", { name: "暂停计时" }).click();
  await expect(window.getByRole("button", { name: "继续计时" })).toBeEnabled();
  await window.getByRole("button", { name: "继续计时" }).click();
  await openMore(window);
  await window.getByRole("menuitem", { name: "重新开始当前轮次" }).click();
  await expect(window.getByRole("button", { name: "开始计时" })).toBeEnabled();

  await openMore(window);
  await window.getByRole("menuitem", { name: "打开设置" }).click();
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
    apiKeys: Object.keys((globalThis as typeof globalThis & { pomodoro: PomodoroApi }).pomodoro).sort(),
    hasNodeProcess: typeof process !== "undefined",
    hasRequire: typeof globalThis.require !== "undefined",
    hasMainInspector: Reflect.has(globalThis, Symbol.for("pomodoro.desktop.inspect")),
  }));
  expect(bridgeShape.apiKeys).toEqual([
    "command", "getCapabilities", "getSettings", "getSnapshot", "getStatistics", "subscribe", "updateSettings",
  ]);
  expect(bridgeShape.hasNodeProcess).toBe(false);
  expect(bridgeShape.hasRequire).toBe(false);
  expect(bridgeShape.hasMainInspector).toBe(false);
  await app.close();

  const restarted = await launchApplication(userDataDirectory);
  expect(await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true);
  await restarted.close();
});

test("enforces the native 160×180 content minimum without changing the timer", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  // Let the real monitor publish its first controlled sample before comparing
  // snapshots; unknown -> present is independent of window layout changes.
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).automation.inputPresence).toBe("present");
  const before = await window.evaluate(() => window.pomodoro.getSnapshot());
  await resizeContent(app, window, 480, 420);
  await resizeContent(app, window, 100, 100, { width: 160, height: 180 });
  const native = await app.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]!;
    const bounds = mainWindow.getBounds();
    const content = mainWindow.getContentBounds();
    const minimum = mainWindow.getMinimumSize();
    if (minimum.length !== 2) throw new Error("Native minimum dimensions are missing");
    return {
      width: minimum[0]! - (bounds.width - content.width),
      height: minimum[1]! - (bounds.height - content.height),
    };
  });
  expect(native).toEqual({ width: 160, height: 180 });
  await assertTimerLayout(window);
  await assertMoreMenuFit(window);
  const minimumScale = await readTimerScale(window);
  expect(minimumScale.time, "The numeric countdown must remain prominent at the minimum").toBeGreaterThanOrEqual(28);
  const after = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(after).toEqual({ ...before, revision: after.revision, emittedAt: after.emittedAt });
  await window.screenshot({ path: testInfo.outputPath("timer-160x180.png") });
  await app.close();
});

test("reflows through size breakpoints while preserving running and manual-paused snapshots", async ({ launchApplication }, testInfo) => {
  test.setTimeout(60_000);
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await window.evaluate(() => document.fonts.ready);
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).automation.inputPresence).toBe("present");
  await window.getByRole("button", { name: "开始计时" }).click();
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("running");
  const runningBefore = await window.evaluate(() => window.pomodoro.getSnapshot());
  let remainingMs = runningBefore.remainingMs;

  for (const [width, height] of [...representativeSizes, ...breakpointSizes]) {
    await resizeContent(app, window, width, height);
    await assertTimerLayout(window);
    await assertMoreMenuFit(window);
    const layoutTransitions = await window.locator(".timerSurface, .timerStage, .dialSlot, .timerDial, .roundMeta, .timerControls").evaluateAll((elements) => elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const durations = style.transitionDuration.split(",").map((value) => Number.parseFloat(value));
      return properties.filter((property, index) => (durations[index % durations.length] ?? 0) > 0
        && /^(all|width|height|min-width|min-height|max-width|max-height|padding.*|margin.*|gap|font-size|grid-template.*|flex.*|transform)$/.test(property));
    }));
    expect(layoutTransitions, "Live resize must follow the native window without interpolating layout geometry").toEqual([]);
    const current = await window.evaluate(() => window.pomodoro.getSnapshot());
    expect(current).toEqual({ ...runningBefore, revision: current.revision, emittedAt: current.emittedAt, remainingMs: current.remainingMs });
    expect(current.remainingMs).toBeLessThanOrEqual(remainingMs);
    remainingMs = current.remainingMs;
  }
  await window.waitForTimeout(600);
  const runningAfter = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(runningAfter.status).toBe("running");
  expect(runningAfter.round).toEqual(runningBefore.round);
  expect(runningAfter.remainingMs).toBeLessThan(runningBefore.remainingMs);
  await window.getByRole("button", { name: "暂停计时" }).click();
  // A rendered button can update before the command reply settles. Establish
  // the actual locked state before taking the exact frozen-time baseline.
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("manual-paused");
  const pausedBefore = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(pausedBefore.automation.manualPauseLocked).toBe(true);
  for (const [width, height] of [...representativeSizes, ...breakpointSizes]) {
    await resizeContent(app, window, width, height);
    await assertTimerLayout(window);
    const current = await window.evaluate(() => window.pomodoro.getSnapshot());
    expect(current.remainingMs).toBe(pausedBefore.remainingMs);
    expect(current).toEqual({ ...pausedBefore, revision: current.revision, emittedAt: current.emittedAt });
    await window.screenshot({ path: testInfo.outputPath(`timer-paused-${width}x${height}.png`) });
  }
  let previousScale: Awaited<ReturnType<typeof readTimerScale>> | undefined;
  for (const height of [359, 360, 361]) {
    await resizeContent(app, window, 480, height);
    await assertTimerLayout(window, "vertical");
    const scale = await readTimerScale(window);
    if (previousScale) {
      expect(Math.abs(scale.dial - previousScale.dial), "A 1px resize must not jump the dial size").toBeLessThanOrEqual(2);
      expect(Math.abs(scale.time - previousScale.time), "A 1px resize must not jump the countdown size").toBeLessThanOrEqual(2);
    }
    previousScale = scale;
  }
  const pausedAfter = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(pausedAfter.remainingMs).toBe(pausedBefore.remainingMs);
  expect(pausedAfter).toEqual({ ...pausedBefore, revision: pausedAfter.revision, emittedAt: pausedAfter.emittedAt });
  await app.close();
});

test("keeps long durations, break states, and input failure readable in each supported layout", async ({ launchApplication }, testInfo) => {
  test.setTimeout(60_000);
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByLabel("专注时长").fill("120");
  await window.getByLabel("输入闲置阈值").fill("600");
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.getByText("已保存", { exact: true })).toBeVisible();
  await window.getByRole("button", { name: /计时器/ }).click();
  await expect(window.locator(".monitorStatus")).toHaveText("系统输入检测 · 600 秒阈值");
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.locator("time")).toHaveText("120:00");

  const checkLayouts = async (name: string): Promise<void> => {
    for (const [width, height] of representativeSizes) {
      await resizeContent(app, window, width, height);
      await assertTimerLayout(window);
      if (name !== "input-source-unavailable") {
        await expect(window.locator(".monitorStatus")).toHaveText("系统输入检测 · 600 秒阈值");
      }
      await window.screenshot({ path: testInfo.outputPath(`${name}-${width}x${height}.png`) });
    }
  };
  await checkLayouts("timer-120min");
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.getByRole("heading", { name: "长休" })).toBeVisible();
  await expect(window.getByText("等待离席 · 将自动开始", { exact: true })).toBeVisible();
  await expect(window.getByRole("button", { name: "手动开始休息" })).toBeEnabled();
  await checkLayouts("long-break-waiting");

  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "开始计时" }).click();
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => { throw new Error("input source unavailable in test"); };
  });
  await expect(window.getByText("输入检测不可用", { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(window.getByText("已暂停 · 可手动继续", { exact: true })).toBeVisible();
  await expect(window.getByRole("button", { name: "继续计时" })).toBeEnabled();
  await checkLayouts("input-source-unavailable");
  await app.close();
});

test("starts active and desk breaks automatically after the input threshold and keeps manual pause locked", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.getByText("等待离席 · 将自动开始", { exact: true })).toBeVisible();
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 120; });
  await expect(window.getByRole("button", { name: "暂停计时" })).toBeEnabled({ timeout: 4_000 });
  await expect(window.getByText("休息中", { exact: true })).toBeVisible();
  const activeBreak = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(activeBreak.round.breakMode).toBe("active");
  expect(activeBreak.status).toBe("running");
  expect(activeBreak.remainingMs, "A first sample already past the threshold must not backfill idle history").toBeGreaterThan(activeBreak.round.totalDurationMs - 2_000);

  await window.getByRole("button", { name: "暂停计时" }).click();
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("manual-paused");
  const manualPause = await window.evaluate(() => window.pomodoro.getSnapshot());
  await window.waitForTimeout(1200);
  const stillPaused = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(stillPaused.status).toBe("manual-paused");
  expect(stillPaused.remainingMs).toBe(manualPause.remainingMs);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  await window.evaluate(() => window.pomodoro.updateSettings({ defaultBreakMode: "desk" }));
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.getByText("等待无输入 · 将自动开始", { exact: true })).toBeVisible();
  await expect(window.getByRole("button", { name: "手动开始休息" })).toBeEnabled();
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 120; });
  await expect(window.getByRole("button", { name: "暂停计时" })).toBeEnabled({ timeout: 4_000 });
  const deskBreak = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(deskBreak.round.breakMode).toBe("desk");
  expect(deskBreak.status).toBe("running");
  expect(deskBreak.remainingMs).toBeGreaterThan(deskBreak.round.totalDurationMs - 2_000);
  await app.close();
});

test("confirms only the observed break countdown and discards it after renewed input", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  // A 10-second threshold starts the provisional window at zero, so the real
  // Main polling loop can observe a short countdown without a 40-second wait.
  await window.evaluate(() => window.pomodoro.updateSettings({ inputIdleThresholdSeconds: 10 }));
  await window.getByRole("button", { name: "跳到下一轮" }).click();
  await expect(window.locator("time")).toHaveText("05:00");
  await app.evaluate(({ powerMonitor }) => new Promise<void>((resolve) => {
    const startedAt = performance.now();
    let firstSample = true;
    powerMonitor.getSystemIdleTime = () => {
      if (firstSample) {
        firstSample = false;
        resolve();
      }
      return Math.floor((performance.now() - startedAt) / 1000);
    };
  }));
  const firstSample = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(firstSample.status).toBe("auto-paused");
  await waitForInputSamples(app, 3);
  const unconfirmed = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(unconfirmed.status).toBe("auto-paused");
  expect(unconfirmed.remainingMs).toBe(unconfirmed.round.totalDurationMs);
  await expect(window.locator("time")).toHaveText("05:00");

  const confirmedEvent = window.evaluate(() => new Promise<TimerSnapshot>((resolve) => {
    const unsubscribe = window.pomodoro.subscribe((event) => {
      if (event.type === "timer.snapshot" && event.snapshot.status === "running") {
        unsubscribe();
        resolve(event.snapshot);
      }
    });
  }));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 10; });
  const confirmed = await confirmedEvent;
  const observedCountdown = unconfirmed.remainingMs - confirmed.remainingMs;
  expect(observedCountdown).toBeGreaterThan(2_500);
  expect(observedCountdown, "Confirmation must not invent the unobserved 10-second idle history").toBeLessThan(5_000);
  await expect(window.locator("time")).toHaveText(/^04:5\d$/);
  await expect(window.getByText("休息中", { exact: true })).toBeVisible();

  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).status, {
    intervals: [50], timeout: 4_000,
  }).toBe("auto-paused");
  const paused = await window.evaluate(() => window.pomodoro.getSnapshot());
  await waitForInputSamples(app, 1);
  const stillPaused = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(stillPaused.status).toBe("auto-paused");
  expect(stillPaused.remainingMs).toBe(paused.remainingMs);

  const restartedEvent = window.evaluate(() => new Promise<TimerSnapshot>((resolve) => {
    const unsubscribe = window.pomodoro.subscribe((event) => {
      if (event.type === "timer.snapshot" && event.snapshot.status === "running") {
        unsubscribe();
        resolve(event.snapshot);
      }
    });
  }));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 10; });
  const restarted = await restartedEvent;
  const newCountdown = stillPaused.remainingMs - restarted.remainingMs;
  expect(newCountdown).toBeGreaterThanOrEqual(0);
  expect(newCountdown, "Renewed input must discard the old observed countdown").toBeLessThan(1_500);
  await expect(window.getByRole("button", { name: "暂停计时" })).toBeEnabled();
  await app.close();
});

test("opens settings and statistics at 160×180 with reachable save controls and scrollable pages", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await resizeContent(app, window, 160, 180);
  await assertMoreMenuFit(window);
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开设置" }).click();
  await expect(window.getByRole("heading", { name: "设置" })).toBeVisible();
  await assertPageHeaderFit(window);
  const settingsScroll = window.locator(".settingsScroll");
  const scrollMetrics = await settingsScroll.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(scrollMetrics.clientHeight).toBeGreaterThan(0);
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.scrollWidth).toBeLessThanOrEqual(scrollMetrics.clientWidth);
  const save = window.getByRole("button", { name: "保存设置" });
  await expect(save).toBeInViewport({ ratio: 1 });
  const footer = await window.locator(".settingsFooter").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const body = document.querySelector(".settingsScroll")!.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, bodyBottom: body.bottom };
  });
  expect(footer.left).toBeGreaterThanOrEqual(0);
  expect(footer.right).toBeLessThanOrEqual(footer.width);
  expect(footer.top).toBeGreaterThanOrEqual(footer.bodyBottom);
  expect(footer.bottom).toBeLessThanOrEqual(footer.height);
  await window.getByLabel("专注时长").fill("25");
  await window.getByRole("button", { name: "浅色" }).click();
  await expect(save).toBeInViewport({ ratio: 1 });
  expect(await settingsScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await save.click();
  await expect(window.getByText("已保存")).toBeVisible();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
  await window.getByRole("button", { name: "深色" }).click();
  await save.click();
  await expect(window.locator("html")).toHaveClass(/dark/);
  await window.getByRole("button", { name: "跟随系统" }).click();
  await window.emulateMedia({ colorScheme: "dark" });
  await save.click();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(window.locator("html")).toHaveClass(/dark/);
  await window.emulateMedia({ colorScheme: "light" });
  await expect(window.locator("html")).not.toHaveClass(/dark/);
  await window.getByRole("button", { name: /计时器/ }).click();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  expect(await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 160, height: 180 });
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开统计" }).click();
  await expect(window.getByRole("heading", { name: "统计" })).toBeVisible();
  await assertPageHeaderFit(window);
  const statsScroll = window.locator(".statsScroll");
  const statsMetrics = await statsScroll.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(statsMetrics.clientHeight).toBeGreaterThan(0);
  expect(statsMetrics.scrollHeight).toBeGreaterThan(statsMetrics.clientHeight);
  expect(statsMetrics.scrollWidth).toBeLessThanOrEqual(statsMetrics.clientWidth);
  await window.locator(".emptyState").scrollIntoViewIfNeeded();
  await expect(window.locator(".emptyState")).toBeInViewport();
  expect(await statsScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(window.getByRole("button", { name: /计时器/ })).toBeInViewport({ ratio: 1 });
  await window.getByRole("button", { name: /计时器/ }).click();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
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

test("a second launch wakes the existing instance without starting another timer", async ({ launchApplication }, testInfo) => {
  const userData = testInfo.outputPath("user-data");
  const app = await launchApplication(userData);
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await window.evaluate(() => window.pomodoro.command("next"));
  const before = await window.evaluate(() => window.pomodoro.getSnapshot());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  const executablePath = await app.evaluate(() => process.execPath);
  const result = spawnSync(executablePath, [applicationEntry, `--user-data-dir=${userData}`], {
    cwd: desktopDirectory,
    env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: userData },
    timeout: 10_000, encoding: "utf8", killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
  expect((await inspectRuntime(app)).pid).not.toBe(result.pid);
  expect((await window.evaluate(() => window.pomodoro.getSnapshot())).round).toEqual(before.round);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test("invalid settings remain editable without hiding the running timer", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "开始计时" }).click();
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开设置" }).click();
  await window.getByLabel("专注时长").fill("");
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.getByLabel("专注时长")).toHaveAttribute("aria-invalid", "true");
  await expect(window.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  expect((await window.evaluate(() => window.pomodoro.getSettings())).focusDurationSeconds).toBe(1800);
  await window.getByLabel("专注时长").fill("25");
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.getByText("已保存", { exact: true })).toBeVisible();
  await window.getByRole("button", { name: "返回计时器" }).click();
  expect((await window.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("running");
});

test("manual input fallback survives failed samples and lock-screen freezes until unlock", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "开始计时" }).click();
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => { throw new Error("test source failure"); }; });
  await expect(window.getByText("输入检测不可用", { exact: true })).toBeVisible();
  await window.getByRole("button", { name: "继续计时" }).click();
  const before = await window.evaluate(() => window.pomodoro.getSnapshot());
  await window.waitForTimeout(2200);
  const manual = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(manual.status).toBe("running");
  expect(manual.remainingMs).toBeLessThan(before.remainingMs - 1500);
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
    powerMonitor.emit("lock-screen");
  });
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).automation.pauseReason).toBe("system-lock");
  const locked = await window.evaluate(() => window.pomodoro.getSnapshot());
  await waitForInputSamples(app, 2);
  expect((await window.evaluate(() => window.pomodoro.getSnapshot())).remainingMs).toBe(locked.remainingMs);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("unlock-screen"); });
  await expect.poll(async () => (await window.evaluate(() => window.pomodoro.getSnapshot())).status).toBe("running");
});

test("publishes committed statistics while the statistics page stays open", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "开始计时" }).click();
  await resizeContent(app, window, 160, 180);
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开统计" }).click();
  await expect(window.locator(".statsHero strong")).toHaveText("0 分钟");
  // Advance the injected monotonic source in this test-owned Main only.
  await app.evaluate(() => {
    const original = performance.now.bind(performance);
    Object.defineProperty(performance, "now", { configurable: true, value: () => original() + 1_800_001 });
  });
  await expect(window.locator(".statsHero strong")).toHaveText("30 分钟");
  expect((await window.evaluate(() => window.pomodoro.getStatistics())).today.completedFocusRounds).toBe(1);
  await expect(window.locator(".heatmap")).toBeVisible();
  await expect.poll(() => window.locator(".heatmapFrame").evaluate((frame) => frame.scrollLeft)).toBeGreaterThan(0);
  await window.locator(".heatmap").scrollIntoViewIfNeeded();
  const statsBounds = await window.locator(".statsScroll").evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(statsBounds.scrollWidth).toBeLessThanOrEqual(statsBounds.width);
  await window.screenshot({ path: testInfo.outputPath("stats-records-160x180.png") });
});

test("a runtime SQLite failure freezes the core and remains visible after renderer reload", async ({ launchApplication }, testInfo) => {
  const userData = testInfo.outputPath("user-data");
  const app = await launchApplication(userData);
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await window.getByRole("button", { name: "开始计时" }).click();
  const executablePath = await app.evaluate(() => process.execPath);
  const result = spawnSync(executablePath, ["-e", `
    const Database = require("better-sqlite3");
    const db = new Database(process.env.POMODORO_TEST_DATABASE);
    try { db.exec("CREATE TRIGGER reject_checkpoints BEFORE UPDATE ON timer_snapshot BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END"); }
    finally { db.close(); }
  `], {
    cwd: desktopDirectory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", POMODORO_TEST_DATABASE: join(userData, "pomodoro.sqlite") },
    timeout: 10_000, encoding: "utf8", killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  await expect(window.getByRole("heading", { name: "本地存储不可用" })).toBeVisible();
  await expect(window.getByText("计时已安全暂停，请重新打开应用后重试。", { exact: true })).toBeVisible();
  await expect(window.getByRole("button", { name: "开始计时" })).toHaveCount(0);
  await expect(window.evaluate(() => window.pomodoro.command("resume"))).rejects.toThrow(/本地数据不可用/);
  await window.reload();
  await expect(window.getByRole("heading", { name: "计时核心不可用" })).toBeVisible();
  await expect(window.getByRole("button", { name: "开始计时" })).toHaveCount(0);
});

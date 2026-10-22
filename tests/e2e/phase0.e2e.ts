import { test as baseTest, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
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
      viewport: { width: innerWidth, height: innerHeight },
      dial: { left: dialBox.left, right: dialBox.right, top: dialBox.top, bottom: dialBox.bottom, width: dialBox.width, height: dialBox.height },
      time: { left: timeBox.left, right: timeBox.right, top: timeBox.top, bottom: timeBox.bottom, width: timeBox.width, height: timeBox.height },
      innerRadius,
      fitsInsideRing: corners.every((corner) => Math.hypot(corner.x - center.x, corner.y - center.y) <= innerRadius),
    };
  });
  const diagnostic = `Timer geometry: ${JSON.stringify(geometry)}`;
  expect(geometry.dial.width, diagnostic).toBeGreaterThanOrEqual(60);
  expect(geometry.dial.width, diagnostic).toBe(geometry.dial.height);
  expect(geometry.text, diagnostic).toMatch(/^\d{2,3}:\d{2}$/);
  expect(geometry.time.width, diagnostic).toBeGreaterThan(0);
  expect(geometry.fitsInsideRing, diagnostic).toBe(true);
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
    const textOverflow = elements.filter((element) => element.matches(".statePill, .monitorStatus, .roundMeta"))
      .filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      .map((element) => element.className);
    const dial = document.querySelector(".timerDial")!.getBoundingClientRect();
    const meta = document.querySelector(".roundMeta")!.getBoundingClientRect();
    const status = document.querySelector(".timerStatus")!.getBoundingClientRect();
    const controls = document.querySelector(".timerControls")!.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      items, overlaps, textOverflow,
      horizontal: dial.right <= meta.left + 0.5,
      vertical: meta.bottom <= dial.top + 0.5,
      regular: !document.querySelector(".timerSurface")!.classList.contains("mini"),
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
  if (layout.regular) expect(layout.statusBesideControls, "Regular status and controls must share a row").toBe(true);
  if (orientation) expect(layout[orientation], `Expected ${orientation} timer composition`).toBe(true);
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
      regular: !document.querySelector(".timerSurface")!.classList.contains("mini"),
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
  if (geometry.regular) expect(geometry.actionsRightMargin, "Header actions must stay anchored while the brand hides").toBeCloseTo(10, 1);
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

test("starts through the restricted preload bridge and preserves native settings", async ({ launchApplication }, testInfo) => {
  const userDataDirectory = testInfo.outputPath("user-data");
  const app = await launchApplication(userDataDirectory);
  // Runner idle time is unrelated to synthetic Playwright input. Hardware idle
  // integration remains a real-platform verification gate.
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();

  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await expect(window.locator("time")).toHaveText("30:00");
  await settleVisuals(window);
  await assertTimerLayout(window, "vertical");
  expect(await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 360, height: 478 });
  expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("regular");
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
    "command", "getCapabilities", "getSettings", "getSnapshot", "getStatistics", "getWindowMode", "setWindowMode", "subscribe", "updateSettings",
  ]);
  expect(bridgeShape.hasNodeProcess).toBe(false);
  expect(bridgeShape.hasRequire).toBe(false);
  expect(bridgeShape.hasMainInspector).toBe(false);
  await app.close();

  const restarted = await launchApplication(userDataDirectory);
  expect(await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true);
  await restarted.close();
});

test("switches mini mode explicitly, enforces content minima, and restores the regular window", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await resizeContent(app, window, 480, 420);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(100, 100); });
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 320, height: 300 });
  expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("regular");
  await expect(window.locator(".timerSurface")).not.toHaveClass(/mini|compact/);
  await assertTimerLayout(window, "vertical");
  const minimumScale = await readTimerScale(window);
  expect(minimumScale.time, "The countdown must remain prominent at the regular minimum").toBeGreaterThanOrEqual(36);
  expect(minimumScale.time / minimumScale.title).toBeGreaterThanOrEqual(2);

  await resizeContent(app, window, 480, 420);
  await window.getByRole("button", { name: "开始计时" }).click();
  await window.getByRole("button", { name: "暂停计时" }).click();
  const paused = await window.evaluate(() => window.pomodoro.getSnapshot());
  const eventMode = window.evaluate(() => new Promise<string>((resolve) => {
    const unsubscribe = window.pomodoro.subscribe((event) => {
      if (event.type === "window.modeChanged") {
        unsubscribe();
        resolve(event.mode);
      }
    });
  }));
  await window.getByRole("button", { name: "切换迷你模式" }).click();
  expect(await eventMode).toBe("mini");
  await expect(window.locator(".timerSurface")).toHaveClass(/mini/);
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 220, height: 240 });
  expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("mini");
  await assertTimerLayout(window, "vertical");
  const miniScale = await readTimerScale(window);
  expect(miniScale.time / miniScale.dial).toBeGreaterThanOrEqual(0.28);
  expect(miniScale.time / miniScale.dial).toBeLessThanOrEqual(0.32);
  await window.screenshot({ path: testInfo.outputPath("timer-mini.png") });
  await resizeContent(app, window, 300, 360);
  await assertTimerLayout(window, "vertical");
  const expandedMiniScale = await readTimerScale(window);
  expect(expandedMiniScale.dial).toBeGreaterThan(miniScale.dial + 20);
  expect(expandedMiniScale.time).toBeGreaterThan(miniScale.time + 4);
  expect(expandedMiniScale.time, "Mini countdown must scale beyond the previous 28px cap").toBeGreaterThan(28);
  expect(expandedMiniScale.time / expandedMiniScale.dial).toBeGreaterThanOrEqual(0.28);
  expect(expandedMiniScale.time / expandedMiniScale.dial).toBeLessThanOrEqual(0.32);
  expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("mini");
  const resizedMini = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(resizedMini).toEqual({ ...paused, revision: resizedMini.revision, emittedAt: resizedMini.emittedAt });
  await window.screenshot({ path: testInfo.outputPath("timer-mini-expanded.png") });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(100, 100); });
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 220, height: 240 });
  await openMore(window);
  await expect(window.getByRole("menuitem", { name: "打开设置" })).toBeVisible();
  await expect(window.getByRole("menuitem", { name: "打开统计" })).toBeVisible();
  await window.getByRole("menuitem", { name: "恢复常规窗口" }).click();
  await expect(window.locator(".timerSurface")).not.toHaveClass(/mini|compact/);
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 480, height: 420 });
  const restored = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(restored.status).toBe("manual-paused");
  expect(restored.remainingMs).toBe(paused.remainingMs);
  expect(restored.round).toEqual(paused.round);

  const invalid = await window.evaluate(async () => {
    try {
      await Reflect.apply(window.pomodoro.setWindowMode, window.pomodoro, ["compact"]);
      return { rejected: false, mode: await window.pomodoro.getWindowMode() };
    } catch {
      return { rejected: true, mode: await window.pomodoro.getWindowMode() };
    }
  });
  expect(invalid).toEqual({ rejected: true, mode: "regular" });
  await expect.poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 480, height: 420 });
  await app.close();
});

test("reflows regular layouts without resize transitions or resetting timer state", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await window.evaluate(() => document.fonts.ready);
  await window.getByRole("button", { name: "开始计时" }).click();
  const runningBefore = await window.evaluate(() => window.pomodoro.getSnapshot());

  const sizes = [
    [320, 300, "vertical"], [480, 300, "vertical"], [320, 420, "vertical"], [360, 478, "vertical"],
    [335, 420, "vertical"], [336, 420, "vertical"],
    [299, 389, undefined], [301, 391, undefined], [299, 390, undefined], [301, 389, undefined], [360, 478, "vertical"],
  ] as const;
  for (const [width, height, orientation] of sizes) {
    await resizeContent(app, window, width, height, { width: Math.max(320, width), height });
    await expect(window.locator(".timerSurface")).not.toHaveClass(/mini|compact/);
    expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("regular");
    await assertTimerLayout(window, orientation);
    const layoutTransitions = await window.locator(".timerSurface, .timerStage, .dialSlot, .timerDial, .roundMeta, .timerControls").evaluateAll((elements) => elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const durations = style.transitionDuration.split(",").map((value) => Number.parseFloat(value));
      return properties.filter((property, index) => (durations[index % durations.length] ?? 0) > 0
        && /^(all|width|height|min-width|min-height|max-width|max-height|padding.*|margin.*|gap|font-size|grid-template.*|flex.*|transform)$/.test(property));
    }));
    expect(layoutTransitions, "Live resize must follow the native window without interpolating layout geometry").toEqual([]);
  }
  await window.waitForTimeout(600);
  const runningAfter = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(runningAfter.status).toBe("running");
  expect(runningAfter.round).toEqual(runningBefore.round);
  expect(runningAfter.remainingMs).toBeLessThan(runningBefore.remainingMs);
  await window.getByRole("button", { name: "暂停计时" }).click();
  const pausedBefore = await window.evaluate(() => window.pomodoro.getSnapshot());
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
    expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("regular");
  }
  for (const [width, height] of [[320, 300], [320, 391], [480, 300], [360, 478]] as const) {
    await resizeContent(app, window, width, height);
    await assertTimerLayout(window, "vertical");
    expect(await window.evaluate(() => window.pomodoro.getWindowMode())).toBe("regular");
  }
  const pausedAfter = await window.evaluate(() => window.pomodoro.getSnapshot());
  expect(pausedAfter.status).toBe("manual-paused");
  expect(pausedAfter).toEqual({ ...pausedBefore, revision: pausedAfter.revision, emittedAt: pausedAfter.emittedAt });
  await app.close();
});

test("keeps long durations, break states, and input failure readable in each supported layout", async ({ launchApplication }, testInfo) => {
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
    for (const [width, height, orientation] of [[320, 300, "vertical"], [480, 300, "vertical"], [320, 420, "vertical"], [360, 478, "vertical"]] as const) {
      await resizeContent(app, window, width, height);
      await assertTimerLayout(window, orientation);
      if (name !== "input-source-unavailable") {
        await expect(window.locator(".monitorStatus")).toHaveText("系统输入检测 · 600 秒阈值");
      }
      await window.screenshot({ path: testInfo.outputPath(`${name}-${width}x${height}.png`) });
    }
    await window.evaluate(() => window.pomodoro.setWindowMode("mini"));
    await expect(window.locator(".timerSurface")).toHaveClass(/mini/);
    await assertTimerLayout(window, "vertical");
    if (name !== "input-source-unavailable") {
      await expect(window.locator(".monitorStatus")).toHaveText("系统输入检测 · 600 秒阈值");
    }
    await window.screenshot({ path: testInfo.outputPath(`${name}-mini.png`) });
    await window.evaluate(() => window.pomodoro.setWindowMode("regular"));
    await expect(window.locator(".timerSurface")).not.toHaveClass(/mini/);
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

  await window.getByRole("button", { name: "暂停计时" }).click();
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
  await app.close();
});

test("opens settings and statistics from mini mode and preserves scrollable settings and themes", async ({ launchApplication }, testInfo) => {
  const app = await launchApplication(testInfo.outputPath("user-data"));
  await app.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await app.firstWindow();
  await expect(window.locator("time")).toHaveText("30:00");
  await window.evaluate(() => window.pomodoro.setWindowMode("mini"));
  await expect(window.locator(".timerSurface")).toHaveClass(/mini/);
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开设置" }).click();
  await expect(window.getByRole("heading", { name: "设置" })).toBeVisible();
  await assertPageHeaderFit(window);
  const settingsScroll = window.locator(".settingsScroll");
  const scrollMetrics = await settingsScroll.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  expect(scrollMetrics.scrollWidth).toBeLessThanOrEqual(scrollMetrics.clientWidth);
  await window.getByLabel("专注时长").fill("25");
  await window.getByRole("button", { name: "浅色" }).click();
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.getByText("已保存")).toBeVisible();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
  await window.getByRole("button", { name: "深色" }).click();
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.locator("html")).toHaveClass(/dark/);
  await window.getByRole("button", { name: "跟随系统" }).click();
  await window.emulateMedia({ colorScheme: "dark" });
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "system");
  await expect(window.locator("html")).toHaveClass(/dark/);
  await window.emulateMedia({ colorScheme: "light" });
  await expect(window.locator("html")).not.toHaveClass(/dark/);
  await window.getByRole("button", { name: /计时器/ }).click();
  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  if (await window.evaluate(() => window.pomodoro.getWindowMode()) !== "mini") {
    await window.evaluate(() => window.pomodoro.setWindowMode("mini"));
  }
  await openMore(window);
  await window.getByRole("menuitem", { name: "打开统计" }).click();
  await expect(window.getByRole("heading", { name: "统计" })).toBeVisible();
  await assertPageHeaderFit(window);
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

import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const rendererRoot = join(root, "apps/desktop/out/renderer");
const output = join(root, "apps/desktop/test-results/layout-validation-after");
await mkdir(output, { recursive: true });

const server = createServer(async (request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\//, "");
  const filePath = join(rendererRoot, relativePath);
  try {
    const contents = await readFile(filePath);
    const contentType = filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "text/javascript" : "text/html";
    response.writeHead(200, { "content-type": contentType });
    response.end(contents);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const renderer = `http://127.0.0.1:${server.address().port}/index.html`;

const settings = {
  version: 1,
  focusDurationSeconds: 1800,
  shortBreakDurationSeconds: 300,
  longBreakDurationSeconds: 600,
  focusRoundsPerCycle: 3,
  inputIdleThresholdSeconds: 40,
  focusPresenceSource: "input",
  defaultBreakMode: "active",
  theme: "system",
  alwaysOnTop: false,
  followWorkspaces: true,
  autoFade: true,
  notificationsEnabled: true,
};

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    document.head.append(style);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function geometry(page) {
  return page.locator(".timerDial").evaluate((dial) => {
    const time = dial.querySelector("time");
    const progress = dial.querySelector(".dialProgress");
    const svg = dial.querySelector("svg");
    const dialBox = dial.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const radius = Number(progress.getAttribute("r"));
    const strokeWidth = Number.parseFloat(getComputedStyle(progress).strokeWidth);
    const scale = dialBox.width / svg.viewBox.baseVal.width;
    const center = { x: dialBox.left + dialBox.width / 2, y: dialBox.top + dialBox.height / 2 };
    const innerRadius = (radius - strokeWidth / 2) * scale - 1;
    const corners = [
      [timeBox.left, timeBox.top], [timeBox.right, timeBox.top],
      [timeBox.left, timeBox.bottom], [timeBox.right, timeBox.bottom],
    ];
    const primary = document.querySelector(".timerControls .primary");
    const primaryBox = primary.getBoundingClientRect();
    const stage = document.querySelector(".timerStage").getBoundingClientRect();
    const details = document.querySelector(".timerDetails").getBoundingClientRect();
    return {
      text: time.textContent,
      width: dialBox.width,
      height: dialBox.height,
      fits: corners.every(([x, y]) => Math.hypot(x - center.x, y - center.y) <= innerRadius),
      dialCenterX: center.x,
      primarySize: [primaryBox.width, primaryBox.height],
      primaryText: primary.textContent.trim(),
      primaryBorderRadius: getComputedStyle(primary).borderTopLeftRadius,
      gapBelowDial: primaryBox.top - dialBox.bottom,
      topInset: details.top - stage.top,
      bottomInset: stage.bottom - primaryBox.bottom,
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript((initialSettings) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    const makeSnapshot = (durationMs) => ({
      revision: 0,
      emittedAt: "2026-10-19T07:00:00.000Z",
      round: { kind: "focus", cycleNumber: 1, positionInCycle: 1, focusRoundNumber: 1, breakMode: null, totalDurationMs: durationMs },
      activeCycleRounds: initialSettings.focusRoundsPerCycle,
      status: "idle",
      remainingMs: durationMs,
      automation: {
        activePresenceSource: "input", inputPresence: "unknown", cameraPresence: "unknown",
        inputMonitoringAvailable: true, cameraMonitoringAvailable: false,
        manualPauseLocked: false, pauseReason: "none",
      },
    });
    const duration = () => Number(new URL(location.href).searchParams.get("duration") ?? initialSettings.focusDurationSeconds * 1000);
    const dayAt = (offset) => {
      const localDate = new Date(Date.UTC(2026, 9, 19 + offset)).toISOString().slice(0, 10);
      const rounds = offset === 0 ? 2 : 0;
      return { localDate, completedFocusRounds: rounds, completedFocusMinutes: rounds * 30 };
    };
    window.pomodoro = {
      getSnapshot: async () => makeSnapshot(duration()),
      getCameraState: async () => ({ enabled: false, generation: 0 }),
      reportCameraPresence: async () => makeSnapshot(duration()),
      command: async () => makeSnapshot(duration()),
      getSettings: async () => ({ ...initialSettings, focusDurationSeconds: duration() / 1000 }),
      updateSettings: async (patch) => ({ ...initialSettings, ...patch }),
      getCapabilities: async () => ({ inputMonitoring: true, cameraPresence: false, standingFocus: false }),
      getStatistics: async () => ({
        generatedAt: "2026-10-19T07:00:00.000Z",
        today: dayAt(0),
        week: Array.from({ length: 7 }, (_, index) => dayAt(index)),
        heatmap: Array.from({ length: 365 }, (_, index) => dayAt(index - 364)),
      }),
      subscribe: () => () => {},
    };
  }, settings);
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[renderer:error] ${error.message}`));
  for (const [width, height] of [[160, 180], [160, 240], [200, 300], [220, 240], [240, 300], [319, 478], [320, 480], [360, 262], [360, 263], [360, 299], [360, 300], [360, 478], [360, 180], [720, 180]]) {
    await page.setViewportSize({ width, height });
    await page.goto(renderer);
    await page.getByText("30:00", { exact: true }).waitFor();
    await settle(page);
    const result = await geometry(page);
    assert.equal(result.width, result.height, `${width}x${height}: dial should remain round`);
    assert.equal(result.fits, true, `${width}x${height}: timer must stay inside ring`);
    assert.ok(Math.abs(result.dialCenterX - width / 2) <= 1, `${width}x${height}: dial must be centered`);
    assert.deepEqual(result.primarySize, [32, 32], `${width}x${height}: primary button hit area`);
    const radius = Number.parseFloat(result.primaryBorderRadius);
    assert.ok(radius >= (result.primaryBorderRadius.endsWith("%") ? 50 : 16), `${width}x${height}: primary button must be round`);
    assert.equal(result.primaryText, "", `${width}x${height}: primary button must display just its icon`);
    if (width < 320 || height < 300) {
      assert.ok(result.gapBelowDial >= 0 && result.gapBelowDial <= 12, `${width}x${height}: controls must sit just below the dial`);
      assert.ok(Math.abs(result.topInset - result.bottomInset) <= 2, `${width}x${height}: compact group must be vertically centered`);
    }
    assert.match(result.text, /^\d{2,3}:\d{2}$/);
    const header = await page.locator(".titleActions .iconButton").evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label"), left: rect.left, right: rect.right };
    }));
    assert.equal(header.length, 3, `${width}x${height}: all header actions remain visible`);
    assert.ok(header[0].left >= 86 && header[0].right <= header[1].left && header[1].right <= header[2].left,
      `${width}x${height}: sensing mode precedes statistics without overlapping native controls`);
    if (width >= 320 && height >= 300) {
      const segmentWidths = await page.locator(".roundSequence span").evaluateAll((segments) => segments.map((segment) => segment.getBoundingClientRect().width));
      assert.ok(Math.abs(segmentWidths[0] / segmentWidths[1] - 6) < 0.1, "focus width reflects thirty versus five minutes");
      assert.ok(Math.abs(segmentWidths[5] / segmentWidths[1] - 2) < 0.1, "long rest width reflects ten versus five minutes");
    }
    for (const name of ["感知模式：触控，切换为监控", "打开统计", "更多操作", "开始计时", "跳到下一轮"]) {
      await page.getByRole("button", { name, exact: true }).click({ trial: true });
    }
    await page.screenshot({ path: join(output, `timer-${width}x${height}.png`) });
  }

  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 160, height: 180 });
    await page.goto(renderer);
    await page.getByText("30:00", { exact: true }).waitFor();
    await settle(page);
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.mouse.move(100, 80);
    await page.mouse.move(-5, -5);
    await page.locator('.timerSurface[data-faded="true"]').waitFor();
    const appearance = await page.locator(".timerSurface").evaluate((surface) => {
      const opacity = (selector) => getComputedStyle(surface.querySelector(selector)).opacity;
      return {
        surfaceOpacity: getComputedStyle(surface).opacity,
        background: getComputedStyle(surface).backgroundColor,
        time: opacity("time"),
        state: opacity(".statePill"),
        primary: opacity(".timerControls .primary"),
        total: opacity(".dialTotal"),
      };
    });
    assert.equal(appearance.surfaceOpacity, "1", `${theme}: the window's contents must not fade as a group`);
    assert.match(appearance.background, /(?:,\s*0\.78|\/\s*0\.78)\)$/, `${theme}: only the timer background becomes translucent`);
    for (const key of ["time", "state", "primary"]) assert.equal(appearance[key], "1", `${theme}: ${key} remains clear`);
    assert.equal(appearance.total, "0.4", `${theme}: auxiliary information is subdued`);
    assert.equal((await geometry(page)).fits, true, `${theme}: faded minimum timer still fits the dial`);
    await page.screenshot({ path: join(output, `timer-faded-${theme}-160x180.png`) });
    await page.mouse.move(100, 80);
    await page.locator('.timerSurface[data-faded="false"]').waitFor();
  }

  await page.goto(`${renderer}?duration=7200000`);
  await page.getByText("120:00", { exact: true }).waitFor();
  await settle(page);
  for (const [width, height] of [[360, 262], [360, 263], [160, 180]]) {
    await page.setViewportSize({ width, height });
    const longDuration = await geometry(page);
    assert.equal(longDuration.fits, true, `${width}x${height}: 120:00 must stay inside the ring`);
  }
  await page.screenshot({ path: join(output, "timer-120-minutes.png") });

  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "打开设置" }).click();
  await page.getByRole("heading", { name: "设置" }).waitFor();
  await page.screenshot({ path: join(output, "settings-160x180.png") });
  await page.getByRole("button", { name: "返回计时器" }).click();
  await page.getByRole("button", { name: "打开统计", exact: true }).click();
  await page.getByRole("heading", { name: "统计" }).waitFor();
  await page.getByText("今日专注", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "stats-160x180.png") });
  assert.equal(await page.locator(".weekDay").count(), 7);
  const statsScroll = page.locator(".statsScroll");
  assert.ok(await statsScroll.evaluate((el) => el.clientHeight > 0 && el.scrollHeight > el.clientHeight));
  const latestDay = page.getByRole("button", { name: "2026-10-19，专注 60 分钟" });
  await latestDay.scrollIntoViewIfNeeded();
  await latestDay.click();
  await page.getByRole("button", { name: "返回计时器" }).click();
  await page.getByText("120:00", { exact: true }).waitFor();
  console.log(`Chromium layout validation passed; screenshots: ${output}`);
  await context.close();
} finally {
  await browser.close();
  server.close();
}

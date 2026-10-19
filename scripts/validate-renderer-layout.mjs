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
  notificationsEnabled: true,
};

function snapshot(durationMs) {
  return {
    revision: 0,
    emittedAt: "2026-10-19T07:00:00.000Z",
    round: { kind: "focus", cycleNumber: 1, positionInCycle: 1, focusRoundNumber: 1, breakMode: null, totalDurationMs: durationMs },
    status: "idle",
    remainingMs: durationMs,
    automation: {
      activePresenceSource: "input",
      inputPresence: "unknown",
      cameraPresence: "unknown",
      inputMonitoringAvailable: true,
      cameraMonitoringAvailable: false,
      manualPauseLocked: false,
      pauseReason: "none",
    },
  };
}

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
    return {
      text: time.textContent,
      width: dialBox.width,
      height: dialBox.height,
      fits: corners.every(([x, y]) => Math.hypot(x - center.x, y - center.y) <= innerRadius),
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
      status: "idle",
      remainingMs: durationMs,
      automation: {
        activePresenceSource: "input", inputPresence: "unknown", cameraPresence: "unknown",
        inputMonitoringAvailable: true, cameraMonitoringAvailable: false,
        manualPauseLocked: false, pauseReason: "none",
      },
    });
    const duration = () => Number(new URL(location.href).searchParams.get("duration") ?? initialSettings.focusDurationSeconds * 1000);
    window.pomodoro = {
      getSnapshot: async () => makeSnapshot(duration()),
      command: async () => makeSnapshot(duration()),
      getSettings: async () => ({ ...initialSettings, focusDurationSeconds: duration() / 1000 }),
      updateSettings: async (patch) => ({ ...initialSettings, ...patch }),
      getCapabilities: async () => ({ inputMonitoring: true, cameraPresence: false, standingFocus: false }),
      getStatistics: async () => ({ generatedAt: "2026-10-19T07:00:00.000Z", today: { localDate: "2026-10-19", completedFocusMinutes: 0, completedFocusRounds: 0 }, week: [], heatmap: [] }),
      subscribe: () => () => undefined,
    };
  }, settings);
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[renderer:error] ${error.message}`));
  for (const [width, height] of [[160, 180], [200, 240], [240, 300], [360, 180], [160, 478], [360, 478], [300, 390], [301, 390], [301, 391], [360, 391]]) {
    await page.setViewportSize({ width, height });
    await page.goto(renderer);
    if (!(await page.getByText("30:00").count())) console.log(await page.locator("body").innerHTML());
    await page.getByText("30:00").waitFor();
    await settle(page);
    const result = await geometry(page);
    assert.equal(result.width, result.height, `${width}x${height}: dial should remain round`);
    assert.equal(result.fits, true, `${width}x${height}: timer must stay inside ring`);
    assert.match(result.text, /^\d{2,3}:\d{2}$/);
    await page.screenshot({ path: join(output, `timer-${width}x${height}.png`) });
  }

  await page.setViewportSize({ width: 160, height: 180 });
  await page.goto(`${renderer}?duration=7200000`);
  await page.getByText("120:00").waitFor();
  await settle(page);
  const longDuration = await geometry(page);
  assert.equal(longDuration.fits, true, "120:00 must stay inside the ring");
  await page.screenshot({ path: join(output, "timer-120-minutes.png") });

  await page.getByRole("button", { name: "打开设置" }).click();
  await page.getByRole("heading", { name: "设置" }).waitFor();
  await page.screenshot({ path: join(output, "settings-160x180.png") });
  await page.getByRole("button", { name: /计时器/ }).click();
  await page.getByRole("button", { name: "打开统计" }).click();
  await page.getByRole("heading", { name: "统计" }).waitFor();
  await page.screenshot({ path: join(output, "stats-160x180.png") });
  console.log(`Chromium layout validation passed; screenshots: ${output}`);
  await context.close();
} finally {
  await browser.close();
  server.close();
}

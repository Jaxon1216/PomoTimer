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

const scenarios = {
  focus: snapshot(1_800_000),
  long: snapshot(7_200_000),
  waiting: {
    ...snapshot(300_000),
    round: { kind: "short-break", cycleNumber: 1, positionInCycle: 2, focusRoundNumber: null, breakMode: "active", totalDurationMs: 300_000 },
    status: "auto-paused",
    automation: { ...snapshot(300_000).automation, inputPresence: "present", pauseReason: "break-condition" },
  },
  unavailable: {
    ...snapshot(1_800_000),
    status: "auto-paused",
    automation: { ...snapshot(1_800_000).automation, inputMonitoringAvailable: false, pauseReason: "source-unavailable" },
  },
};

const viewports = [
  [160, 180], [160, 478], [220, 240], [320, 300],
  [360, 478], [360, 180], [480, 240], [720, 480],
  [299, 478], [300, 478], [320, 279], [320, 280],
  [359, 219], [360, 219], [220, 219], [220, 220],
  [480, 241],
];

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
    const micro = dial.querySelector(".microProgress");
    const dialBox = dial.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const svgBox = svg.getBoundingClientRect();
    const ringVisible = getComputedStyle(svg).display !== "none";
    const microVisible = getComputedStyle(micro).display !== "none";
    if (!ringVisible) {
      return {
        text: time.textContent,
        width: dialBox.width,
        height: dialBox.height,
        ringVisible,
        microVisible,
        fits: timeBox.left >= dialBox.left - 1 && timeBox.right <= dialBox.right + 1
          && timeBox.top >= dialBox.top - 1 && timeBox.bottom <= dialBox.bottom + 1,
      };
    }
    const radius = Number(progress.getAttribute("r"));
    const strokeWidth = Number.parseFloat(getComputedStyle(progress).strokeWidth);
    const scale = svgBox.width / svg.viewBox.baseVal.width;
    const center = { x: svgBox.left + svgBox.width / 2, y: svgBox.top + svgBox.height / 2 };
    const innerRadius = (radius - strokeWidth / 2) * scale - 1;
    const corners = [
      [timeBox.left, timeBox.top], [timeBox.right, timeBox.top],
      [timeBox.left, timeBox.bottom], [timeBox.right, timeBox.bottom],
    ];
    return {
      text: time.textContent,
      width: dialBox.width,
      height: dialBox.height,
      ringVisible,
      microVisible,
      fits: corners.every(([x, y]) => Math.hypot(x - center.x, y - center.y) <= innerRadius),
    };
  });
}

async function assertBounds(page, selectors, label) {
  const result = await page.evaluate((requiredSelectors) => {
    const elements = requiredSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector), (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        text: element.textContent,
        visible: style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0,
        inside: box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
        width: box.width,
        height: box.height,
        clipped: (element.scrollWidth > element.clientWidth + 1 && !["auto", "scroll"].includes(style.overflowX))
          || (element.scrollHeight > element.clientHeight + 1 && !["auto", "scroll"].includes(style.overflowY)),
      };
    }));
    return { elements, pageFits: document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1 };
  }, selectors);
  assert.equal(result.pageFits, true, `${label}: page must stay inside the viewport`);
  for (const selector of selectors) {
    const matches = result.elements.filter((element) => element.selector === selector);
    assert.ok(matches.length > 0, `${label}: missing ${selector}`);
    for (const element of matches) {
      assert.equal(element.visible, true, `${label}: ${selector} must be visible`);
      assert.equal(element.inside, true, `${label}: ${selector} must stay in the viewport`);
      assert.equal(element.clipped, false, `${label}: ${selector} must show its full contents (${element.text})`);
    }
  }
  return result.elements;
}

async function assertTimerLayout(page, width, height, label) {
  const result = await geometry(page);
  const micro = width <= 359 && height <= 219;
  assert.equal(result.ringVisible, !micro, `${label}: ring visibility must follow the micro breakpoint`);
  assert.equal(result.microVisible, micro, `${label}: thin progress visibility must follow the micro breakpoint`);
  if (result.ringVisible) assert.ok(Math.abs(result.width - result.height) <= 1, `${label}: dial should remain round`);
  assert.equal(result.fits, true, `${label}: timer must fit its ${micro ? "numeric display" : "ring"}`);
  assert.match(result.text, /^\d{2,3}:\d{2}$/);
  const controls = await assertBounds(page, [".roundMeta", ".roundMeta h1", ".breakMode", ".timerDial time", ".statePill", ".monitorStatus", ".timerControls button", ".timerMenuContainer > button"], label);
  for (const button of controls.filter((element) => element.selector === ".timerControls button")) {
    assert.ok(button.width >= 32 && button.height >= 32, `${label}: timer controls must remain at least 32px`);
  }
  if (width <= 299 || height <= 279) {
    for (const selector of [".brand", ".statisticsButton", ".dialTotal", ".timerFooter"]) {
      assert.equal(await page.locator(selector).isVisible(), false, `${label}: compact layout must hide ${selector}`);
    }
  }
  if (width >= 360 && height <= 240) {
    const dial = await page.locator(".timerDial").boundingBox();
    const meta = await page.locator(".roundMeta").boundingBox();
    assert.ok(dial.x + dial.width <= meta.x + 1, `${label}: landscape dial must sit left of metadata`);
  }
  assert.equal(await page.evaluate(() => window.__layoutCommandCount), 0, `${label}: layout must not issue timer commands`);
}

async function openMore(page, label) {
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menu", { name: "计时器操作" }).waitFor();
  await assertBounds(page, [".timerMenu", ".timerMenu [role=menuitem]"], `${label} menu`);
  assert.equal(await page.getByRole("menuitem").count(), 3, `${label}: menu should contain statistics, settings and reset`);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(({ initialSettings, initialScenarios }) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    const currentSnapshot = () => initialScenarios[new URL(location.href).searchParams.get("scenario") ?? "focus"];
    window.__layoutCommandCount = 0;
    window.pomodoro = {
      getSnapshot: async () => currentSnapshot(),
      command: async () => { window.__layoutCommandCount += 1; return currentSnapshot(); },
      getSettings: async () => ({ ...initialSettings, focusDurationSeconds: currentSnapshot().round.kind === "focus" ? currentSnapshot().round.totalDurationMs / 1000 : initialSettings.focusDurationSeconds }),
      updateSettings: async (patch) => ({ ...initialSettings, ...patch }),
      getCapabilities: async () => ({ inputMonitoring: true, cameraPresence: false, standingFocus: false }),
      getStatistics: async () => ({ generatedAt: "2026-10-19T07:00:00.000Z", today: { localDate: "2026-10-19", completedFocusMinutes: 0, completedFocusRounds: 0 }, week: [], heatmap: [] }),
      subscribe: () => () => undefined,
    };
  }, { initialSettings: settings, initialScenarios: scenarios });
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[renderer:error] ${error.message}`));
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    await page.goto(renderer);
    await page.locator(".timerDial time").filter({ hasText: "30:00" }).waitFor();
    await settle(page);
    await assertTimerLayout(page, width, height, `${width}x${height}`);
    await page.screenshot({ path: join(output, `timer-${width}x${height}.png`) });
    await openMore(page, `${width}x${height}`);
    await page.getByRole("menu").press("Escape");
  }

  for (const scenario of ["long", "waiting", "unavailable"]) {
    await page.goto(`${renderer}?scenario=${scenario}`);
    await page.locator(".timerDial time").waitFor();
    for (const [width, height] of [[160, 180], [160, 478], [220, 240], [360, 180], [480, 240]]) {
      await page.setViewportSize({ width, height });
      await settle(page);
      await assertTimerLayout(page, width, height, `${scenario} ${width}x${height}`);
      await page.screenshot({ path: join(output, `timer-${scenario}-${width}x${height}.png`) });
    }
  }

  await page.setViewportSize({ width: 160, height: 180 });
  await page.goto(renderer);
  await page.locator(".timerDial time").waitFor();
  await openMore(page, "160x180 settings navigation");
  await page.getByRole("menuitem", { name: "打开设置" }).click();
  await page.getByRole("heading", { name: "设置" }).waitFor();
  await settle(page);
  await assertBounds(page, [".pageHeader", ".backButton", ".settingsScroll", ".settingsFooter", ".saveButton"], "160x180 settings");
  assert.equal(await page.locator(".settingsScroll").evaluate((element) => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === "auto"), true, "small settings content must scroll");
  await page.locator(".settingsScroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByText("已保存", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "settings-160x180.png") });
  await page.getByRole("button", { name: "返回计时器" }).click();
  await openMore(page, "160x180 statistics navigation");
  await page.getByRole("menuitem", { name: "打开统计" }).click();
  await page.getByRole("heading", { name: "统计" }).waitFor();
  await settle(page);
  await assertBounds(page, [".pageHeader", ".backButton", ".statsScroll"], "160x180 statistics");
  assert.equal(await page.locator(".statsScroll").evaluate((element) => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === "auto"), true, "small statistics content must scroll");
  await page.screenshot({ path: join(output, "stats-160x180.png") });
  console.log(`Chromium layout validation passed; screenshots: ${output}`);
  await context.close();
} finally {
  await browser.close();
  server.close();
}

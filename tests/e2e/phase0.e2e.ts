import { test, expect, _electron as electron } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PomodoroApi } from "../../apps/desktop/src/shared/contracts";

const workspaceRoot = process.cwd();
const desktopDirectory = existsSync(join(workspaceRoot, "apps/desktop/out/main/index.js"))
  ? join(workspaceRoot, "apps/desktop")
  : workspaceRoot;
const applicationEntry = join(desktopDirectory, "out", "main", "index.js");

test("starts through the restricted preload bridge, controls the Core, and supports a compact widget", async ({
}, testInfo) => {
  const userDataDirectory = testInfo.outputPath("user-data");
  const app = await electron.launch({
    args: [applicationEntry, `--user-data-dir=${userDataDirectory}`],
    cwd: desktopDirectory,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  // Runner idle time is unrelated to synthetic Playwright input. Keep this
  // control/IPC test deterministic; hardware idle behavior is a separate gate.
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  const window = await app.firstWindow();

  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await expect(window.getByText("30:00")).toBeVisible();
  await window.waitForTimeout(300);
  await window.screenshot({ path: testInfo.outputPath("timer-light.png") });
  await expect(
    window.getByRole("button", { name: "重新开始当前轮次" }),
  ).toBeEnabled();
  await expect(window.getByRole("button", { name: "跳到下一轮" })).toBeEnabled();
  await window.getByRole("button", { name: "开始计时" }).click();
  await expect(window.getByRole("button", { name: "暂停计时" })).toBeEnabled();

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({
      width: 160,
      height: 180,
    });
  });
  await expect(window.locator(".timerSurface")).toHaveClass(/compact/);
  await expect(window.locator("time")).toHaveText(/^\d{2}:\d{2}$/);
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
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 360, height: 478 });
  });
  await window.getByRole("button", { name: "打开设置" }).click();
  await expect(window.getByRole("heading", { name: "设置" })).toBeVisible();
  await window.getByRole("button", { name: "深色" }).click();
  await window.getByRole("checkbox", { name: "常驻顶部" }).check();
  await window.getByRole("button", { name: "保存设置" }).click();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true);
  await window.screenshot({ path: testInfo.outputPath("settings-dark.png") });
  await window.getByRole("button", { name: /计时器/ }).click();
  await window.getByRole("button", { name: "打开统计" }).click();
  await expect(window.getByRole("heading", { name: "统计" })).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath("stats-dark.png") });

  const bridgeShape = await window.evaluate(() => ({
    apiKeys: Object.keys(
      (globalThis as typeof globalThis & { pomodoro: PomodoroApi }).pomodoro,
    ).sort(),
    hasNodeProcess: typeof process !== "undefined",
    hasRequire: typeof globalThis.require !== "undefined",
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

  await app.close();

  const restarted = await electron.launch({
    args: [applicationEntry, `--user-data-dir=${userDataDirectory}`],
    cwd: desktopDirectory,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  await restarted.firstWindow();
  expect(await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true);
  await restarted.close();
});

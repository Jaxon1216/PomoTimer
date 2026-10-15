import { test, expect, _electron as electron } from "@playwright/test";
import { join } from "node:path";
import type { PomodoroApi } from "../../apps/desktop/src/shared/contracts";

const desktopDirectory = process.cwd();
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
  const window = await app.firstWindow();

  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await expect(window.getByText("30:00")).toBeVisible();
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
  await expect(window.getByText("30:00")).toBeVisible();

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
});

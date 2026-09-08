import { test, expect, _electron as electron } from "@playwright/test";
import { join } from "node:path";

const desktopDirectory = process.cwd();
const applicationEntry = join(desktopDirectory, "out", "main", "index.js");

test("starts through the restricted preload bridge and shows Core snapshot", async () => {
  const app = await electron.launch({
    args: [applicationEntry],
    cwd: desktopDirectory,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const window = await app.firstWindow();

  await expect(window.getByRole("heading", { name: "专注" })).toBeVisible();
  await expect(window.getByText("30:00")).toBeVisible();
  await expect(window.getByText("输入检测 · 40 秒")).toBeVisible();

  const bridgeShape = await window.evaluate(() => ({
    apiKeys: Object.keys(window.pomodoro).sort(),
    hasNodeProcess: typeof process !== "undefined",
    hasRequire: typeof globalThis.require !== "undefined",
  }));
  expect(bridgeShape.apiKeys).toEqual([
    "command",
    "getCapabilities",
    "getSettings",
    "getSnapshot",
    "subscribe",
    "updateSettings",
  ]);
  expect(bridgeShape.hasNodeProcess).toBe(false);
  expect(bridgeShape.hasRequire).toBe(false);

  await app.close();
});

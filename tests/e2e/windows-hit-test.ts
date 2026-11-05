import type { ElectronApplication, Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const hitTestScript = join(__dirname, "windows-hit-test.ps1");

export async function assertWindowsTimerHitTests(application: ElectronApplication, page: Page): Promise<void> {
  const points = await page.evaluate(() => {
    const ring = document.querySelector(".dialTrack")!.getBoundingClientRect();
    const button = document.querySelector(".timerControls .primary")!.getBoundingClientRect();
    return {
      ring: { x: ring.left + ring.width / 2, y: ring.top },
      button: { x: button.left + button.width / 2, y: button.top + button.height / 2 },
    };
  });
  const native = await application.evaluate(({ BrowserWindow, screen }, local) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) throw new Error("Missing timer window for native hit test");
    const bounds = window.getContentBounds();
    const screenPoint = (point: { x: number; y: number }) => screen.dipToScreenPoint({
      x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y),
    });
    return {
      handleHex: window.getNativeWindowHandle().reverse().toString("hex"),
      ring: screenPoint(local.ring), button: screenPoint(local.button),
    };
  }, points);
  await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hitTestScript,
    native.handleHex, String(native.ring.x), String(native.ring.y), String(native.button.x), String(native.button.y),
  ], { windowsHide: true, timeout: 10_000 });
}

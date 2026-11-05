import type { ElectronApplication, Page } from "@playwright/test";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function buildWindowsHitTest(outputDir: string): Promise<string> {
  const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
  await mkdir(outputDir, { recursive: true });
  const executable = join(outputDir, `windows-hit-test-${process.pid}.exe`);
  try {
    await run(compiler, [
      "/nologo", "/platform:anycpu", `/out:${executable}`, join(__dirname, "windows-hit-test.cs"),
    ], { windowsHide: true, timeout: 60_000 });
  } catch (cause) {
    // csc 编译失败时仍把源码诊断写到标准输出。
    const error = cause as ExecFileException;
    throw new Error(`Windows hit-test compilation failed: ${error.message}\n${error.stdout ?? ""}`, { cause });
  }
  return executable;
}

export async function assertWindowsTimerHitTests(executable: string, application: ElectronApplication, page: Page): Promise<void> {
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
  await run(executable, [
    native.handleHex, String(native.ring.x), String(native.ring.y), String(native.button.x), String(native.button.y),
  ], { windowsHide: true, timeout: 10_000 });
}

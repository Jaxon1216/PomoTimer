import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "apps/desktop");
const executablePath = process.platform === "darwin"
  ? join(desktop, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Pomodoro Timer.app/Contents/MacOS/Pomodoro Timer")
  : process.platform === "win32"
    ? join(desktop, "dist/win-unpacked/Pomodoro Timer.exe")
    : undefined;
if (!executablePath) throw new Error("Packaged smoke tests support macOS and Windows only.");

const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-package-smoke-"));
let application;
try {
  application = await electron.launch({ executablePath, args: [`--user-data-dir=${dataDirectory}`], timeout: 30_000 });
  // Exercise packaged controls independently of the hosted runner's idle age.
  await application.evaluate(({ powerMonitor }) => {
    powerMonitor.getSystemIdleTime = () => 0;
  });
  const window = await application.firstWindow();
  await window.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 30_000 });
  const environment = await application.evaluate(({ app, nativeImage }) => {
    const name = process.platform === "win32" ? "pomodoro-timer.ico" : "pomodoro-timer.png";
    return { packaged: app.isPackaged, trayImageEmpty: nativeImage.createFromPath(`${process.resourcesPath}/icons/${name}`).isEmpty() };
  });
  assert.equal(environment.packaged, true);
  assert.equal(environment.trayImageEmpty, false);
  const snapshot = await window.evaluate(() => window.pomodoro.getSnapshot());
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.round.kind, "focus");
  await window.getByRole("button", { name: "开始计时" }).click();
  await window.getByRole("button", { name: "暂停计时" }).waitFor();
  await window.getByRole("button", { name: "暂停计时" }).click();
  assert.equal((await window.evaluate(() => window.pomodoro.getSnapshot())).status, "manual-paused");
  await window.getByRole("button", { name: "打开统计" }).click();
  await window.getByRole("heading", { name: "统计", exact: true }).waitFor();
  console.log(`Packaged ${process.platform}/${process.arch}: startup, SQLite, tray resources, IPC, controls and statistics passed.`);
} finally {
  if (application) await application.close();
  await rm(dataDirectory, { recursive: true, force: true });
}

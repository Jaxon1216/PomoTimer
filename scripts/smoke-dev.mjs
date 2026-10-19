import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") throw new Error("The dev-launch wrapper is currently verified on macOS only.");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-dev-smoke-"));
let application;
try {
  application = await electron.launch({
    executablePath: join(root, "scripts/launch-development.mjs"),
    args: [`--user-data-dir=${dataDirectory}`],
    cwd: root,
    env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: dataDirectory },
    timeout: 60_000,
  });
  await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
  const window = await application.firstWindow();
  await window.getByRole("heading", { name: "专注", exact: true }).waitFor();
  const identity = await application.evaluate(() => {
    const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect"));
    if (typeof inspect !== "function") throw new Error("Main-process runtime diagnostics were not enabled");
    return inspect();
  });
  assert.equal(await realpath(identity.userData), await realpath(dataDirectory));
  assert.equal(identity.packaged, false);
  assert.equal(new URL(identity.devServerUrl).origin, "http://localhost:5174");
  assert.equal(new URL(window.url()).origin, new URL(identity.devServerUrl).origin);
  assert.ok(identity.pid > 0 && identity.pid !== process.pid);
  assert.ok(identity.tray && identity.tray.template && identity.tray.bounds.width > 0);
  assert.equal((await window.evaluate(() => window.pomodoro.getSnapshot())).status, "idle");
  await window.getByRole("button", { name: "开始计时" }).click();
  await window.getByRole("button", { name: "暂停计时" }).click();
  assert.equal((await window.evaluate(() => window.pomodoro.getSnapshot())).status, "manual-paused");
  console.log(JSON.stringify({ kind: "development-smoke", command: "npm run dev", identity, rendererUrl: window.url() }, null, 2));
  console.log("Development: real npm run dev, isolated userData, main/renderer identity, actual tray and IPC controls passed.");
} finally {
  try {
    if (application) await application.close();
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

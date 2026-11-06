import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "apps/desktop");
const defaultExecutablePath = process.platform === "darwin"
  ? join(desktop, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Pomodoro Timer.app/Contents/MacOS/Pomodoro Timer")
  : process.platform === "win32"
    ? join(desktop, "dist/win-unpacked/Pomodoro Timer.exe")
    : undefined;
if (!defaultExecutablePath) throw new Error("Packaged smoke tests support macOS and Windows only.");
export async function smokePackaged({ executablePath = process.env.POMODORO_SMOKE_EXECUTABLE ?? defaultExecutablePath, signal, timeoutMs = 120_000 } = {}) {
  if (!isAbsolute(executablePath)) throw new Error("The packaged smoke executable path must be absolute.");
  const deadline = AbortSignal.timeout(timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  cancellation.throwIfAborted();

  const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-package-smoke-"));
  let application;
  let closing;
  function closeApplication() {
    if (!application) return Promise.resolve();
    if (closing) return closing;
    const child = application.process();
    closing = new Promise((resolveExit, rejectExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit();
        return;
      }
      const cleanup = () => {
        clearTimeout(forceTimer);
        clearTimeout(deadlineTimer);
        child.removeListener("exit", exited);
      };
      const exited = () => {
        cleanup();
        resolveExit();
      };
      // 先正常关闭；超时才终止本次测试拥有的 Electron，并等待真实退出事件。
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const deadlineTimer = setTimeout(() => {
        cleanup();
        rejectExit(new Error(`Packaged Electron process ${child.pid} did not exit during cleanup.`));
      }, 10_000);
      child.once("exit", exited);
      void application.close().catch(() => {});
    });
    return closing;
  }
  const abort = () => { void closeApplication().catch(() => {}); };
  cancellation.addEventListener("abort", abort, { once: true });
  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${dataDirectory}`],
      env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: dataDirectory },
      timeout: 30_000,
    });
    cancellation.throwIfAborted();
    // Exercise packaged controls independently of the hosted runner's idle age.
    await application.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0;
    });
    const window = await application.firstWindow();
    await window.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 30_000 });
    const identity = await application.evaluate(() => {
      const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect"));
      if (typeof inspect !== "function") throw new Error("Main-process runtime diagnostics were not enabled");
      return inspect();
    });
    assert.equal(await realpath(identity.userData), await realpath(dataDirectory));
    assert.equal(identity.packaged, true);
    assert.equal(identity.devServerUrl, null);
    assert.ok(identity.pid > 0 && identity.pid !== process.pid);
    assert.ok(identity.tray && identity.tray.size.width > 0);
    assert.equal(identity.tray.tooltip, "Pomodoro Timer");
    const environment = await application.evaluate(({ nativeImage }) => {
      const names = process.platform === "darwin"
        ? ["trayTemplate.png", "trayTemplate@2x.png"]
        : process.platform === "win32"
          ? ["pomodoro-timer.ico"]
          : ["pomodoro-timer.png"];
      const resources = names.map((name) => ({ name, empty: nativeImage.createFromPath(`${process.resourcesPath}/icons/${name}`).isEmpty() }));
      return { resources };
    });
    assert.equal(environment.resources.every((resource) => !resource.empty), true);
    if (process.platform === "darwin") {
      assert.equal(identity.tray.template, true);
      assert.ok(identity.tray.scales.includes(1) && identity.tray.scales.includes(2));
      assert.ok(identity.tray.bounds.width > 0 && identity.tray.bounds.height > 0);
    }
    const snapshot = await window.evaluate(() => window.pomodoro.getSnapshot());
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.round.kind, "focus");
    await window.getByRole("button", { name: "开始计时" }).click();
    await window.getByRole("button", { name: "暂停计时" }).waitFor();
    await window.getByRole("button", { name: "暂停计时" }).click();
    assert.equal((await window.evaluate(() => window.pomodoro.getSnapshot())).status, "manual-paused");
    await window.getByRole("button", { name: "打开统计" }).click();
    await window.getByRole("heading", { name: "统计", exact: true }).waitFor();
    cancellation.throwIfAborted();
    console.log(JSON.stringify({ kind: "packaged-smoke", executablePath, identity, resources: environment.resources }, null, 2));
    console.log(`Packaged ${process.platform}/${process.arch}: isolated startup, SQLite, actual tray, IPC, controls and statistics passed.`);
  } finally {
    cancellation.removeEventListener("abort", abort);
    try {
      await closeApplication();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Packaged smoke test interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await smokePackaged({ signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

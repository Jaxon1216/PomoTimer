import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { release, tmpdir, version } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

if (process.platform !== "darwin") throw new Error("Native window layering validation requires macOS.");
const negativeControl = process.argv.includes("--negative-control");
const followsWorkspaces = !process.argv.includes("--no-follow");
const withReminder = process.argv.includes("--with-reminder");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, "apps/desktop");
const packagedExecutable = process.env.POMODORO_LAYERING_EXECUTABLE;
if (packagedExecutable && !isAbsolute(packagedExecutable)) throw new Error("The packaged layering executable path must be absolute.");
const outputDirectory = join(root, "test-results", "macos-layering");
await mkdir(outputDirectory, { recursive: true });
const probeSource = join(root, "tests/e2e/macos-layering-probe.swift");
const probeExecutable = join(outputDirectory, "layering-probe");
const executableModified = await stat(probeExecutable).then((value) => value.mtimeMs).catch(() => 0);
if (executableModified < (await stat(probeSource)).mtimeMs) {
  const compilation = spawn("swiftc", [probeSource, "-o", probeExecutable], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  compilation.stderr.setEncoding("utf8").on("data", (data) => { errors += data; });
  const timeout = setTimeout(() => compilation.kill("SIGTERM"), 45_000);
  try {
    const code = await new Promise((resolve, reject) => { compilation.once("error", reject); compilation.once("close", resolve); });
    assert.equal(code, 0, `Native probe compilation failed: ${errors}`);
  } finally { clearTimeout(timeout); }
}

const dataDirectory = await mkdtemp(join(tmpdir(), "pomodot-layering-"));
let application;
let probe;
let lines;
let stderr = "";
const samples = [];
let runtime;
try {
  application = await electron.launch({
    executablePath: packagedExecutable,
    args: [...(packagedExecutable ? [] : [join(desktop, "out/main/index.js")]), `--user-data-dir=${dataDirectory}`],
    cwd: desktop,
    env: { ...process.env, POMODORO_DIAGNOSTICS: "1", POMODORO_EXPECTED_USER_DATA: dataDirectory },
    timeout: 30_000,
  });
  let page = await application.firstWindow();
  // 原生层级探针只验证应用窗口，避免系统通知横幅或声音影响测试桌面。
  await application.evaluate(({ Notification }) => { Notification.prototype.show = () => {}; });
  await page.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 15_000 });
  if (!followsWorkspaces) {
    const replacement = application.waitForEvent("window");
    await page.evaluate(() => window.pomodoro.updateSettings({ followWorkspaces: false }));
    page = await replacement;
    await page.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 15_000 });
  }
  const identity = await application.evaluate(({ BrowserWindow }) => {
    const inspect = Reflect.get(globalThis, Symbol.for("pomodoro.desktop.inspect"));
    if (typeof inspect !== "function") throw new Error("Runtime diagnostics are missing");
    return { ...inspect(), mediaSourceId: BrowserWindow.getAllWindows()[0].getMediaSourceId(), electronVersion: process.versions.electron };
  });
  runtime = { electronVersion: identity.electronVersion, packaged: identity.packaged, configuredType: identity.window?.configuredType };
  assert.equal(await realpath(identity.userData), await realpath(dataDirectory));
  const windowID = /^window:(\d+):/.exec(identity.mediaSourceId)?.[1];
  assert.ok(windowID, "Electron must identify its native window");
  probe = spawn(probeExecutable, [String(identity.pid), windowID], { stdio: ["pipe", "pipe", "pipe"] });
  probe.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  lines = createInterface({ input: probe.stdout });
  const responses = lines[Symbol.asyncIterator]();
  const response = async () => {
    let timeout;
    try {
      const line = await Promise.race([
        responses.next(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Native layering probe timed out: ${stderr}`)), 5_000); }),
      ]);
      assert.equal(line.done, false, `Native layering probe closed early: ${stderr}`);
      const result = JSON.parse(line.value);
      assert.equal(result.error, undefined);
      return result;
    } finally { clearTimeout(timeout); }
  };
  assert.equal((await response()).ready, true);
  const sample = async (label, command = "sample", { requireFocus = true, windowID: targetWindowID } = {}) => {
    probe.stdin.write(`${JSON.stringify({ command, label, ...(targetWindowID ? { windowID: targetWindowID } : {}) })}\n`);
    const result = await response();
    result.focusPreservationRequired = requireFocus;
    samples.push(result);
    console.log(JSON.stringify(result));
    assert.equal(result.label, label);
    assert.equal(result.probeOnScreen, true, `${label}: the synthetic ordinary window must be visible`);
    assert.equal(result.timerOnScreen, true, `${label}: the timer must remain on screen`);
    assert.equal(result.overlap, true, `${label}: the ordinary app must overlap the timer to test covering`);
    if (requireFocus) {
      assert.equal(result.probeActive, true, `${label}: the timer must leave the ordinary application active`);
      assert.equal(result.probeKeyWindow, true, `${label}: the ordinary application must retain its keyboard window`);
    }
    assert.equal(result.timerAboveProbe, true, `${label}: the ordinary app covered the timer`);
    assert.equal(result.timerLayer, 3, `${label}: the timer must use the ordinary floating layer`);
    assert.equal(result.probeLayer, 0, `${label}: the probe must remain an ordinary window`);
    return result;
  };

  if (negativeControl) {
    // 使用真实原生置顶状态制造遮挡，证明同一可见性断言可以变红。
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false));
    await sample("negative-control-topmost-disabled", "activate");
    throw new Error("The negative control must fail the ordinary-window covering assertion.");
  }
  await sample("cold-start", "activate");
  if (!withReminder) {
    await page.evaluate(() => window.pomodoro.updateSettings({ theme: "dark" }));
    await sample("unrelated-settings-save");
    await page.evaluate(async () => {
      await window.pomodoro.updateSettings({ alwaysOnTop: false });
      await window.pomodoro.updateSettings({ alwaysOnTop: true });
    });
    await sample("topmost-reenabled");
    for (let cycle = 1; cycle <= 12; cycle += 1) await sample(`ordinary-app-activation-${cycle}`, "activate");
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.hide();
      window.showInactive();
    });
    await sample("hide-show-inactive");
    await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const minimized = new Promise((resolve) => window.once("minimize", resolve));
      window.minimize();
      await minimized;
      const restored = new Promise((resolve) => window.once("restore", resolve));
      window.restore();
      await restored;
    });
    // 恢复最小化属于显式窗口操作；先记录其焦点，再让自建普通应用重新激活。
    await sample("minimize-restore-before-reactivation", "sample", { requireFocus: false });
    await sample("minimize-restore", "activate");
    await application.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("suspend");
      powerMonitor.emit("resume");
    });
    await sample("simulated-suspend-resume");
  }
  if (withReminder) {
    const completeRound = async () => {
      const snapshot = await page.evaluate(async () => {
        const current = await window.pomodoro.getSnapshot();
        if (current.status !== "running") await window.pomodoro.command(current.status === "idle" ? "start" : "resume");
        return window.pomodoro.getSnapshot();
      });
      await application.evaluate((_, elapsed) => {
        const previousNow = performance.now.bind(performance);
        performance.now = () => previousNow() + elapsed;
      }, snapshot.remainingMs + 100);
    };
    await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    const reminderReady = application.waitForEvent("window");
    await completeRound();
    const reminder = await reminderReady;
    await reminder.getByRole("heading", { name: "专注完成", exact: true }).waitFor({ timeout: 5_000 });
    await reminder.getByRole("button", { name: "知道了", exact: true }).waitFor({ timeout: 5_000 });
    const firstReminder = await reminder.evaluate(() => window.pomodoro.getReminder());
    assert.ok(firstReminder, "The rendered focus reminder must have a current identity");
    const reminderID = async (reminderPage) => {
      await reminderPage.waitForLoadState("domcontentloaded");
      const native = await application.browserWindow(reminderPage);
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const id = await native.evaluate((window) => window.isVisible()
            ? /^window:(\d+):/.exec(window.getMediaSourceId())?.[1] ?? null : null);
          if (id) return id;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("A natural round completion must show the exact native reminder window");
      } finally { await native.dispose(); }
    };
    const id = await reminderID(reminder);
    await sample("natural-completion-reminder", "target", { windowID: id });
    const dismissReminder = async () => {
      assert.equal(await reminder.evaluate(async () => {
        const current = await window.pomodoro.getReminder();
        return current ? window.pomodoro.dismissReminder(current.id) : false;
      }), true);
      const native = await application.browserWindow(reminder);
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (!await native.evaluate((window) => window.isVisible())) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Dismissing the reminder must hide its native window");
      } finally { await native.dispose(); }
    };
    await dismissReminder();
    await sample("before-fullscreen", "target", { windowID });
    if (followsWorkspaces) {
      const fullscreen = await sample("native-fullscreen", "fullscreen");
      assert.equal(fullscreen.probeFullscreen, true);
      await completeRound();
      await reminder.getByRole("heading", { name: "休息结束", exact: true }).waitFor({ timeout: 5_000 });
      await reminder.getByRole("button", { name: "知道了", exact: true }).waitFor({ timeout: 5_000 });
      const nextReminder = await reminder.evaluate(() => window.pomodoro.getReminder());
      assert.ok(nextReminder && nextReminder.id > firstReminder.id, "The reused reminder must show the newer completed round");
      const reusedID = await reminderID(reminder);
      assert.equal(reusedID, id, "UI dismissal must keep the exact native reminder window for reuse");
      const reminderSample = await sample("native-fullscreen-completion-reminder", "target", { windowID: reusedID });
      assert.equal(reminderSample.probeFullscreen, true);
      await dismissReminder();
    }
  }
  if (!withReminder) {
    const closed = page.waitForEvent("close");
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await closed;
    const reopened = application.waitForEvent("window");
    await application.evaluate(({ app }) => { app.emit("activate"); });
    page = await reopened;
    await page.getByRole("heading", { name: "专注", exact: true }).waitFor({ timeout: 15_000 });
    const reopenedID = await application.evaluate(({ BrowserWindow }) => {
      const id = /^window:(\d+):/.exec(BrowserWindow.getAllWindows()[0].getMediaSourceId())?.[1];
      if (!id) throw new Error("The reopened isolated native target has no window ID");
      return id;
    });
    // 用户主动重新打开主窗可以取得键盘焦点；仅自动显示路径承诺保持其他应用的 key window。
    await sample("close-reopen-user-summon", "target", { requireFocus: false, windowID: reopenedID });
    if (!followsWorkspaces) await sample("normal-window-switch-back", "activate");
  }
  console.log(`Native window layering passed (${samples.length} checks; passive display preserved the synthetic app's keyboard focus).`);
} finally {
  const reportName = negativeControl ? "negative-control.json" : withReminder ? "reminder.json"
    : followsWorkspaces ? "result.json" : "normal-window.json";
  await writeFile(join(outputDirectory, reportName), `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    os: { platform: process.platform, release: release(), version: version(), architecture: process.arch },
    runtime, negativeControl, followsWorkspaces, withReminder, samples,
  }, null, 2)}\n`);
  lines?.close();
  if (probe && probe.exitCode === null && probe.signalCode === null) {
    const closed = new Promise((resolve) => { probe.once("close", resolve); });
    probe.stdin.end(`${JSON.stringify({ command: "quit" })}\n`);
    const timeout = setTimeout(() => probe.kill("SIGTERM"), 2_000);
    await closed;
    clearTimeout(timeout);
  }
  try { if (application) await application.close(); }
  finally { await rm(dataDirectory, { recursive: true, force: true }); }
}

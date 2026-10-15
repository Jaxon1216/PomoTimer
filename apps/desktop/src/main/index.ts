import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, Notification, nativeImage, powerMonitor, Tray, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { capabilitiesSchema, coreEventSchema, settingsPatchSchema, settingsSchema, statisticsSnapshotSchema, timerCommandSchema, timerSnapshotSchema, type CoreEvent } from "../shared/contracts.js";
import { SqliteStore } from "./store.js";
import { TimerEngine } from "./timer.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: SqliteStore | undefined;
let engine: TimerEngine | undefined;
let monitorTimer: NodeJS.Timeout | undefined;
let tickTimer: NodeJS.Timeout | undefined;
let quitting = false;
let lastRoundKey = "";

const capabilities = capabilitiesSchema.parse({ inputMonitoring: process.platform === "darwin" || process.platform === "win32", cameraPresence: false, standingFocus: false });

function assertSender(event: IpcMainInvokeEvent): void { if (event.sender.id !== mainWindow?.webContents.id) throw new Error("不支持的 IPC 调用来源"); }
function currentEngine(): TimerEngine { if (!engine) throw new Error("计时核心尚未初始化"); return engine; }
function formatRemaining(ms: number): string { const seconds = Math.ceil(ms / 1000); return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`; }
function broadcast(event: CoreEvent): void { const safe = coreEventSchema.parse(event); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pomodoro:event", safe); updateTray(); }
function currentDate(): string { return new Date().toLocaleDateString("sv-SE"); }
function dateAtOffset(days: number): string { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + days); return date.toLocaleDateString("sv-SE"); }
function statistics() {
  if (!store) throw new Error("数据库尚未初始化");
  const today = currentDate(); const now = new Date(); const mondayOffset = (now.getDay() + 6) % 7; const start = dateAtOffset(-mondayOffset); const weekRows = store.dailyTotals(start, dateAtOffset(6 - mondayOffset));
  const week = Array.from({ length: 7 }, (_, index) => { const date = dateAtOffset(index - mondayOffset); return weekRows.find((row) => row.localDate === date) ?? { localDate: date, completedFocusMinutes: 0, completedFocusRounds: 0 }; });
  const heatmapRows = store.dailyTotals(dateAtOffset(-364), today); const heatmap = Array.from({ length: 365 }, (_, index) => { const localDate = dateAtOffset(index - 364); return heatmapRows.find((row) => row.localDate === localDate) ?? { localDate, completedFocusMinutes: 0, completedFocusRounds: 0 }; });
  return statisticsSnapshotSchema.parse({ generatedAt: new Date().toISOString(), today: store.dailyTotals(today, today)[0] ?? { localDate: today, completedFocusMinutes: 0, completedFocusRounds: 0 }, week, heatmap });
}
function publishSnapshot(): void { const snapshot = currentEngine().snapshot; broadcast({ type: "timer.snapshot", snapshot }); }
function notify(title: string, body: string): void { if (currentEngine().settings.notificationsEnabled && Notification.isSupported()) new Notification({ title, body }).show(); }
function updateTray(): void {
  if (!tray || !engine) return;
  const snapshot = engine.snapshot; const action = snapshot.status === "running" ? "暂停" : snapshot.status === "idle" ? "开始" : "继续";
  tray.setContextMenu(Menu.buildFromTemplate([{ label: `${snapshot.round.kind === "focus" ? "专注" : snapshot.round.kind === "short-break" ? "短休" : "长休"} · ${formatRemaining(snapshot.remainingMs)}`, enabled: false }, { type: "separator" }, { label: action, click: () => { void runCommand(snapshot.status === "running" ? "pause" : snapshot.status === "idle" ? "start" : "resume"); } }, { label: "下一轮", click: () => { void runCommand("next"); } }, { label: "显示窗口", click: () => showWindow() }, { type: "separator" }, { label: "退出", click: () => { quitting = true; app.quit(); } }]));
}
async function runCommand(command: Parameters<TimerEngine["command"]>[0]): Promise<void> {
  const before = currentEngine().snapshot; const snapshot = currentEngine().command(command); broadcast({ type: "timer.snapshot", snapshot });
  if (before.round.kind !== snapshot.round.kind || before.round.cycleNumber !== snapshot.round.cycleNumber || before.round.positionInCycle !== snapshot.round.positionInCycle) notify("轮次完成", `已进入${snapshot.round.kind === "focus" ? "专注" : snapshot.round.kind === "short-break" ? "短休" : "长休"}`);
}
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 360, height: 478, minWidth: 160, minHeight: 180, show: false, titleBarStyle: "hiddenInset", backgroundColor: "#f6f3ee", webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.setAlwaysOnTop(engine?.settings.alwaysOnTop ?? false);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => { if (!quitting && process.platform !== "darwin") { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith("https:")) void shell.openExternal(url); return { action: "deny" }; });
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"] ?? pathToFileURL(join(__dirname, "../renderer/index.html")).toString();
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  void window.loadURL(rendererUrl);
  return window;
}
function showWindow(): void { if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(); else { mainWindow.show(); mainWindow.focus(); } }
function installIpc(): void {
  ipcMain.handle("pomodoro:get-snapshot", (event) => { assertSender(event); return timerSnapshotSchema.parse(currentEngine().snapshot); });
  ipcMain.handle("pomodoro:get-settings", (event) => { assertSender(event); return settingsSchema.parse(currentEngine().settings); });
  ipcMain.handle("pomodoro:get-capabilities", (event) => { assertSender(event); return capabilities; });
  ipcMain.handle("pomodoro:get-statistics", (event) => { assertSender(event); return statistics(); });
  ipcMain.handle("pomodoro:command", async (event, raw: unknown) => { assertSender(event); const command = timerCommandSchema.parse(raw); await runCommand(command); return currentEngine().snapshot; });
  ipcMain.handle("pomodoro:update-settings", (event, raw: unknown) => { assertSender(event); const patch = settingsPatchSchema.parse(raw); const settings = currentEngine().applySettings(patch); mainWindow?.setAlwaysOnTop(settings.alwaysOnTop); publishSnapshot(); return settings; });
}
function startMonitoring(): void {
  monitorTimer = setInterval(() => {
    let idle: number | undefined;
    let available = capabilities.inputMonitoring;
    if (available) {
      try {
        idle = powerMonitor.getSystemIdleTime();
      } catch {
        available = false;
      }
    }
    const snapshot = currentEngine().inputSample(idle, available);
    broadcast({ type: "timer.snapshot", snapshot });
  }, 1000);
  tickTimer = setInterval(() => { const before = lastRoundKey; const snapshot = currentEngine().snapshot; const key = `${snapshot.round.cycleNumber}:${snapshot.round.positionInCycle}`; if (before && before !== key) notify("轮次完成", `已进入${snapshot.round.kind === "focus" ? "专注" : snapshot.round.kind === "short-break" ? "短休" : "长休"}`); lastRoundKey = key; broadcast({ type: "timer.snapshot", snapshot }); }, 500);
  powerMonitor.on("suspend", () => { const snapshot = currentEngine().systemSuspend(); broadcast({ type: "timer.snapshot", snapshot }); notify("计时已暂停", "系统进入睡眠，恢复后需要继续计时"); });
  powerMonitor.on("resume", () => { const snapshot = currentEngine().snapshot; broadcast({ type: "timer.snapshot", snapshot }); });
}
app.whenReady().then(() => {
  try {
    store = new SqliteStore(app.getPath("userData")); engine = new TimerEngine(store, { now: () => performance.now(), wallDate: () => new Date() }); lastRoundKey = `${engine.snapshot.round.cycleNumber}:${engine.snapshot.round.positionInCycle}`;
    installIpc();
    mainWindow = createWindow();
    const trayIcon = process.platform === "win32" ? "pomodoro-timer.ico" : "pomodoro-timer.png";
    const trayIconDirectory = app.isPackaged
      ? join(process.resourcesPath, "icons")
      : join(__dirname, "../../resources/icons");
    const trayPath = join(trayIconDirectory, trayIcon);
    let trayImage = nativeImage.createFromPath(trayPath);
    // Keep a format fallback for platform-specific nativeImage decoders.
    if (trayImage.isEmpty() && trayIcon !== "pomodoro-timer.ico") {
      trayImage = nativeImage.createFromPath(join(trayIconDirectory, "pomodoro-timer.ico"));
    }
    if (trayImage.isEmpty()) throw new Error("托盘图标资源不可用");
    tray = new Tray(trayImage);
    updateTray();
    startMonitoring();
    app.on("activate", () => showWindow()); app.on("window-all-closed", () => { if (process.platform !== "darwin") { /* close-to-tray keeps the process alive */ } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法打开本地数据";
    dialog.showErrorBox("本地计时器无法启动", `${message}\n\n请备份 pomodoro.sqlite 后重试。`);
    app.quit();
  }
});
app.on("before-quit", () => {
  quitting = true;
  if (monitorTimer) clearInterval(monitorTimer);
  if (tickTimer) clearInterval(tickTimer);
  engine?.systemSuspend();
  store?.close();
});
export { TimerEngine };

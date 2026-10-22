import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, Notification, nativeImage, powerMonitor, screen, Tray, ipcMain, shell, type IpcMainInvokeEvent, type NativeImage } from "electron";
import { capabilitiesSchema, coreEventSchema, settingsPatchSchema, settingsSchema, statisticsSnapshotSchema, timerCommandSchema, timerSnapshotSchema, windowModeSchema, type CoreEvent } from "../shared/contracts.js";
import { SqliteStore } from "./store.js";
import { TimerEngine } from "./timer.js";
import { WindowModeController, windowModeLayouts } from "./window-mode.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayIconImage: NativeImage | undefined;
let store: SqliteStore | undefined;
let engine: TimerEngine | undefined;
let monitorTimer: NodeJS.Timeout | undefined;
let tickTimer: NodeJS.Timeout | undefined;
let quitting = false;
let lastRoundKey = "";
const trayToolTip = "Pomodoro Timer";
const windowModes = new WindowModeController((bounds) => screen.getDisplayMatching(bounds).workArea);

// 领域：Electron / 主进程诊断
// 顺序：验证脚本 -> Node inspector -> 当前 Main 持有的窗口与 Tray。
// 作用：按实际 PID、数据目录和原生边界确认测试实例的归属。
// 原因：系统可能同时运行多个实例，不能仅凭截图猜测图标或窗口来源。
// 边界：仅显式诊断环境启用，不增加 preload、IPC 或 Renderer 能力。
export function inspectDesktopRuntime() {
  return {
    pid: process.pid,
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
    devServerUrl: process.env["ELECTRON_RENDERER_URL"] ?? null,
    window: mainWindow && !mainWindow.isDestroyed() ? {
      bounds: mainWindow.getBounds(),
      contentBounds: mainWindow.getContentBounds(),
      webContentsId: mainWindow.webContents.id,
    } : null,
    tray: tray && !tray.isDestroyed() && trayIconImage ? {
      bounds: tray.getBounds(),
      tooltip: trayToolTip,
      template: trayIconImage.isTemplateImage(),
      size: trayIconImage.getSize(),
      scales: trayIconImage.getScaleFactors(),
    } : null,
  };
}

if (process.env["POMODORO_DIAGNOSTICS"] === "1") {
  Object.defineProperty(globalThis, Symbol.for("pomodoro.desktop.inspect"), { value: inspectDesktopRuntime });
}

const capabilities = capabilitiesSchema.parse({ inputMonitoring: process.platform === "darwin" || process.platform === "win32", cameraPresence: false, standingFocus: false });

function assertSender(event: IpcMainInvokeEvent): void { if (event.sender.id !== mainWindow?.webContents.id) throw new Error("不支持的 IPC 调用来源"); }
function currentEngine(): TimerEngine { if (!engine) throw new Error("计时核心尚未初始化"); return engine; }
function formatRemaining(ms: number): string { const seconds = Math.ceil(ms / 1000); return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`; }
function broadcast(event: CoreEvent): void { const safe = coreEventSchema.parse(event); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pomodoro:event", safe); if (safe.type === "timer.snapshot") updateTray(); }
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
  // 领域：Electron / 主进程
  // 顺序：应用启动链第 3 站，Main -> BrowserWindow -> Renderer 标题栏布局。
  // 作用：只在 macOS 启用 hiddenInset 和原生 traffic-light 位置。
  // 原因：macOS 原生按钮属于窗口外观；Windows 必须保留默认标题栏和内容尺寸换算。
  // 边界：不向 Renderer 暴露 Node、路径或通用 IPC，只由浏览器平台标记控制受控 CSS。
  const macOS = process.platform === "darwin";
  const initialSize = windowModeLayouts[windowModes.mode].defaultSize;
  const window = new BrowserWindow({
    ...initialSize,
    useContentSize: true,
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: macOS ? "hiddenInset" : "default",
    ...(macOS ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: "#f6f3ee",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  // 领域：Electron / 窗口布局
  // 顺序：应用启动链第 3 站，createWindow -> WindowModeController -> Renderer 布局。
  // 作用：恢复当前形态的会话布局，并按原生边框换算最小尺寸。
  // 原因：Windows 标题栏不能占用内容预算，恢复窗口也不能落到屏幕外。
  // 边界：只约束窗口外观，不修改计时状态、业务设置或持久化数据。
  windowModes.initialize(window);
  window.setAlwaysOnTop(engine?.settings.alwaysOnTop ?? false);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => { windowModes.remember(window); if (!quitting && process.platform !== "darwin") { event.preventDefault(); window.hide(); } });
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
  // 领域：Electron / IPC
  // 顺序：窗口模式链第 3 站，Preload -> Main IPC -> WindowModeController。
  // 作用：验证模式请求并将已确认的原生窗口形态返回和广播给 Renderer。
  // 原因：窗口模式由 Main 统一管理，不能随 resize 事件自行切换。
  // 边界：只接受主窗口 sender 和枚举值，不触碰计时核心或 SQLite。
  ipcMain.handle("pomodoro:get-window-mode", (event) => { assertSender(event); return windowModeSchema.parse(windowModes.mode); });
  ipcMain.handle("pomodoro:set-window-mode", (event, raw: unknown) => {
    assertSender(event);
    const requested = windowModeSchema.parse(raw);
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("窗口尚未初始化");
    const previous = windowModes.mode;
    const mode = windowModeSchema.parse(windowModes.setMode(mainWindow, requested));
    if (mode !== previous) broadcast({ type: "window.modeChanged", mode });
    return mode;
  });
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
  // 领域：Electron / 验收隔离
  // 顺序：测试启动参数 -> Main 就绪 -> 隔离校验 -> SqliteStore。
  // 作用：拒绝参数未透传或数据目录不匹配的诊断启动。
  // 原因：开发工具可能吞掉 CLI 参数，必须在打开数据库之前失败。
  // 边界：只约束显式诊断实例，正常用户启动不受影响。
  if (process.env["POMODORO_DIAGNOSTICS"] === "1") {
    try {
      const requestedDirectory = app.commandLine.getSwitchValue("user-data-dir");
      if (!isAbsolute(requestedDirectory) || realpathSync(requestedDirectory) !== realpathSync(app.getPath("userData"))) {
        throw new Error("诊断启动必须传入独立、有效的 --user-data-dir 绝对路径");
      }
      const expectedDirectory = process.env["POMODORO_EXPECTED_USER_DATA"];
      if (expectedDirectory && realpathSync(expectedDirectory) !== realpathSync(requestedDirectory)) {
        throw new Error("诊断启动的数据目录与预期目录不匹配");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "诊断数据隔离校验失败");
      app.exit(1);
      return;
    }
  }
  try {
    store = new SqliteStore(app.getPath("userData")); engine = new TimerEngine(store, { now: () => performance.now(), wallDate: () => new Date() }); lastRoundKey = `${engine.snapshot.round.cycleNumber}:${engine.snapshot.round.positionInCycle}`;
    installIpc();
    mainWindow = createWindow();
    const trayIcon = process.platform === "win32" ? "pomodoro-timer.ico" : process.platform === "darwin" ? "trayTemplate.png" : "pomodoro-timer.png";
    const trayIconDirectory = app.isPackaged
      ? join(process.resourcesPath, "icons")
      : join(__dirname, "../../resources/icons");
    const trayPath = join(trayIconDirectory, trayIcon);
    let trayImage: NativeImage = nativeImage.createFromPath(trayPath);
    if (process.platform === "darwin" && !trayImage.isEmpty()) {
      const retinaImage = nativeImage.createFromPath(join(trayIconDirectory, "trayTemplate@2x.png"));
      if (!retinaImage.isEmpty()) trayImage.addRepresentation({ scaleFactor: 2, buffer: retinaImage.toPNG() });
      trayImage.setTemplateImage(true);
    }
    // Keep a format fallback for platform-specific nativeImage decoders.
    if (trayImage.isEmpty() && process.platform !== "darwin" && trayIcon !== "pomodoro-timer.ico") trayImage = nativeImage.createFromPath(join(trayIconDirectory, "pomodoro-timer.ico"));
    if (trayImage.isEmpty()) throw new Error("托盘图标资源不可用");
    trayIconImage = trayImage;
    tray = new Tray(trayImage);
    tray.setToolTip(trayToolTip);
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

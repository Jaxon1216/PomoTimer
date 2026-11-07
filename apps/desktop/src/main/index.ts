import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, Menu, Notification, nativeImage, nativeTheme, powerMonitor, screen, Tray, ipcMain, type IpcMainInvokeEvent, type NativeImage } from "electron";
import { cameraPresenceReportSchema, cameraStateSchema, capabilitiesSchema, coreEventSchema, settingsPatchSchema, settingsSchema, timerCommandSchema, timerSnapshotSchema, type CoreEvent, type TimerSnapshot } from "../shared/contracts.js";
import { CameraMonitor } from "./camera-monitor.js";
import { allowsCameraPermission } from "./camera-permission.js";
import { SqliteStore, StoreRecoveryError, rebuildSqliteStore } from "./store.js";
import { TimerEngine } from "./timer.js";
import { WindowLayout, initialContentSize, windowsCaptionHeight } from "./window-layout.js";
import { collectStatistics, localDateKey } from "./statistics.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayIconImage: NativeImage | undefined;
let store: SqliteStore | undefined;
let engine: TimerEngine | undefined;
let monitorTimer: NodeJS.Timeout | undefined;
let tickTimer: NodeJS.Timeout | undefined;
let quitting = false;
const camera = new CameraMonitor();
let suspended = false;
let screenLocked = false;
let rendererReady = false;
let runtimeFailure: Error | undefined;
let lastCompletedRoundRevision = 0;
let lastStatisticsRevision = 0;
let lastStatisticsDate = "";
let lastTrayState = "";
const trayToolTip = "Pomodoro Timer";
const windowLayout = new WindowLayout(process.platform, (bounds) => screen.getDisplayMatching(bounds).workArea,
  process.platform === "win32" ? windowsCaptionHeight : 0);

// 领域：Electron / 生命周期
// 顺序：应用启动链第 1 站，OS 启动 -> 单实例锁 -> Main 初始化。
// 作用：相同 userData 只允许一个进程持有计时核心和数据库。
// 原因：SQLite 写锁不能协调两个独立计时器对单行快照的业务覆盖。
// 边界：二次启动只唤起已有窗口，不打开数据库；隔离 userData 的测试独立运行。
const ownsInstanceLock = app.requestSingleInstanceLock();
if (!ownsInstanceLock) app.quit();
else app.on("second-instance", () => { if (app.isReady() && engine) showWindow(); });

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

const capabilities = capabilitiesSchema.parse({ inputMonitoring: process.platform === "darwin" || process.platform === "win32", cameraPresence: process.platform === "darwin" || process.platform === "win32", standingFocus: false });

function assertSender(event: IpcMainInvokeEvent): void { if (event.sender.id !== mainWindow?.webContents.id || event.senderFrame !== event.sender.mainFrame) throw new Error("不支持的 IPC 调用来源"); }
function currentEngine(): TimerEngine { if (!engine) throw new Error("计时核心尚未初始化"); return engine; }
function rendererUrl(): string { return new URL(process.env["ELECTRON_RENDERER_URL"] ?? pathToFileURL(join(__dirname, "../renderer/index.html")).toString()).href; }
function syncCamera(): void {
  const enabled = capabilities.cameraPresence && currentEngine().settings.focusPresenceSource === "camera"
    && rendererReady && !suspended && !screenLocked && !runtimeFailure && !quitting;
  if (camera.setEnabled(enabled, performance.now())) {
    publishSnapshot(currentEngine().cameraSample("unknown"));
    broadcast({ type: "camera.state", state: camera.state });
  }
}
function sampleInput(): void {
  let idle: number | undefined;
  let available = capabilities.inputMonitoring;
  if (available) { try { idle = powerMonitor.getSystemIdleTime(); } catch { available = false; } }
  publishSnapshot(currentEngine().inputSample(idle, available));
}
function fallbackCamera(message: string): void {
  if (currentEngine().settings.focusPresenceSource !== "camera") return;
  publishSnapshot(currentEngine().cameraSample("unknown"));
  const settings = currentEngine().applySettings({ focusPresenceSource: "input" });
  syncCamera();
  broadcast({ type: "settings.changed", settings });
  sampleInput();
  broadcast({ type: "core.error", code: "CAMERA_UNAVAILABLE", message: `${message}，已切回触控感知。可检查系统摄像头权限后重新选择监控。`, recoverable: true });
}
function formatRemaining(ms: number): string { const seconds = Math.ceil(ms / 1000); return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`; }
function broadcast(event: CoreEvent): void { const safe = coreEventSchema.parse(event); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pomodoro:event", safe); if (safe.type === "timer.snapshot") updateTray(safe.snapshot); }
function statistics() {
  if (!store) throw new Error("数据库尚未初始化");
  if (runtimeFailure) throw runtimeFailure;
  return collectStatistics(store);
}
function publishSnapshot(snapshot = currentEngine().snapshot): void {
  broadcast({ type: "timer.snapshot", snapshot });
  if (!store || runtimeFailure) return;
  const currentDate = localDateKey(new Date());
  if (lastStatisticsRevision !== store.completedSessionsRevision || lastStatisticsDate !== currentDate) {
    broadcast({ type: "stats.changed", statistics: statistics() });
    lastStatisticsRevision = store.completedSessionsRevision;
    lastStatisticsDate = currentDate;
  }
  if (lastCompletedRoundRevision !== currentEngine().completedRoundsRevision) {
    lastCompletedRoundRevision = currentEngine().completedRoundsRevision;
    notify("轮次完成", `已进入${snapshot.round.kind === "focus" ? "专注" : snapshot.round.kind === "short-break" ? "短休" : "长休"}`);
  }
}
function notify(title: string, body: string): void {
  if (!currentEngine().settings.notificationsEnabled || !Notification.isSupported()) return;
  try { new Notification({ title, body }).show(); } catch { console.warn("系统通知不可用"); }
}
function updateTray(snapshot: TimerSnapshot): void {
  if (!tray) return;
  const locked = runtimeFailure !== undefined || snapshot.automation.pauseReason === "system-lock";
  const action = snapshot.status === "running" ? "暂停" : snapshot.status === "idle" ? "开始" : "继续";
  const title = `${snapshot.round.kind === "focus" ? "专注" : snapshot.round.kind === "short-break" ? "短休" : "长休"} · ${formatRemaining(snapshot.remainingMs)}`;
  const state = `${title}:${action}:${locked}`;
  if (state === lastTrayState) return;
  const command = snapshot.status === "running" ? "pause" : snapshot.status === "idle" ? "start" : "resume";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: title, enabled: false }, { type: "separator" },
    { label: action, enabled: !locked, click: () => runTrayCommand(command) },
    { label: "下一轮", enabled: !locked, click: () => runTrayCommand("next") },
    { label: "显示窗口", click: () => showWindow() }, { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  lastTrayState = state;
}

// 领域：Electron / 持久化故障
// 顺序：采样、IPC 或退出写入失败 -> 内存安全暂停 -> Renderer 错误事件。
// 作用：停止后台写入，并向仍存活的窗口发布冻结快照和明确故障。
// 原因：磁盘或 SQLite 故障不能让后台继续计时，也不能成为未处理异常。
// 边界：此路径不再次写 Store；恢复原有数据需要重新打开应用。
function failRuntime(reason: unknown): void {
  if (runtimeFailure) return;
  runtimeFailure = new Error(`本地数据不可用，计时已安全暂停。请重新打开应用重试。${reason instanceof Error ? ` ${reason.message}` : ""}`);
  if (camera.setEnabled(false, performance.now())) broadcast({ type: "camera.state", state: camera.state });
  if (monitorTimer) clearInterval(monitorTimer);
  if (tickTimer) clearInterval(tickTimer);
  if (engine) broadcast({ type: "timer.snapshot", snapshot: engine.storageFailure() });
  broadcast({ type: "core.error", code: "STORAGE_UNAVAILABLE", message: runtimeFailure.message, recoverable: false });
}
function backgroundOperation(operation: () => void): void {
  if (runtimeFailure) return;
  try { operation(); } catch (reason) { failRuntime(reason); }
}
function coreOperation<T>(operation: () => T): T {
  try { return operation(); } catch (reason) { failRuntime(reason); throw runtimeFailure; }
}
function runCommand(command: Parameters<TimerEngine["command"]>[0]): TimerSnapshot {
  if (runtimeFailure) throw runtimeFailure;
  try {
    const snapshot = currentEngine().command(command);
    coreOperation(() => publishSnapshot(snapshot));
    return snapshot;
  } catch (reason) {
    const code: unknown = reason instanceof Error ? Reflect.get(reason, "code") : undefined;
    if (typeof code === "string" && code.startsWith("SQLITE_")) failRuntime(reason);
    throw reason;
  }
}
function runTrayCommand(command: Parameters<TimerEngine["command"]>[0]): void {
  try { runCommand(command); } catch (reason) {
    if (!runtimeFailure) broadcast({ type: "core.error", code: "COMMAND_REJECTED", message: reason instanceof Error ? reason.message : "计时操作未完成", recoverable: true });
  }
}
function windowsCaption() {
  const theme = engine?.settings.theme ?? "system";
  const dark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return { height: windowsCaptionHeight, color: dark ? "#252b39" : "#f4f1eb", symbolColor: dark ? "#f6f2eb" : "#242321" };
}

function createWindow(): BrowserWindow {
  // 领域：Electron / 主进程
  // 顺序：应用启动链第 3 站，Main -> BrowserWindow -> Renderer 标题栏布局。
  // 作用：macOS 使用内嵌交通灯，Windows 在独立标题栏区域保留系统窗口按钮。
  // 原因：Electron 在 Windows 默认边框下忽略网页拖动区；标题栏覆盖层允许原生拖动。
  // 边界：不向 Renderer 暴露 Node、路径或通用 IPC，只由浏览器平台标记控制受控 CSS。
  const macOS = process.platform === "darwin";
  const windows = process.platform === "win32";
  const window = new BrowserWindow({
    ...initialContentSize,
    useContentSize: true,
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: macOS ? "hiddenInset" : windows ? "hidden" : "default",
    ...(windows ? { titleBarOverlay: windowsCaption() } : {}),
    ...(macOS ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: "#f6f3ee",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false },
  });
  if (windows) {
    window.removeMenu();
    const refreshCaption = () => window.setTitleBarOverlay(windowsCaption());
    nativeTheme.on("updated", refreshCaption);
    window.once("closed", () => nativeTheme.off("updated", refreshCaption));
  }
  windowLayout.initialize(window);
  window.on("will-resize", (event, bounds, details) => windowLayout.willResize(window, bounds, details.edge, event));
  window.on("resize", () => windowLayout.didResize(window));
  window.setAlwaysOnTop(engine?.settings.alwaysOnTop ?? false);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => { windowLayout.remember(window); if (!quitting && process.platform !== "darwin") { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // 领域：Electron / 媒体权限
  // 顺序：Renderer getUserMedia -> Session 权限校验 -> OS 摄像头授权。
  // 作用：仅允许主窗口主 frame 在用户启用监控时请求视频。
  // 原因：默认 Electron 授权策略不能代替应用的模式和来源校验。
  // 边界：拒绝音频、外部 frame 和其他权限，不扩大 preload 能力。
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowsCameraPermission({ enabled: camera.state.enabled, permission, expectedContentsId: window.webContents.id,
      contentsId: contents?.id, isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl,
      rendererUrl: rendererUrl(), mediaTypes: details.mediaType ? [details.mediaType] : undefined }));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowsCameraPermission({ enabled: camera.state.enabled, permission, expectedContentsId: window.webContents.id,
      contentsId: contents.id, isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl,
      rendererUrl: rendererUrl(), mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined }));
  });
  window.webContents.on("did-start-loading", () => backgroundOperation(() => { rendererReady = false; syncCamera(); }));
  window.webContents.on("did-finish-load", () => backgroundOperation(() => { rendererReady = true; syncCamera(); }));
  window.webContents.on("render-process-gone", () => { if (!quitting) backgroundOperation(() => { rendererReady = false; fallbackCamera("摄像头检测窗口已中断"); }); });
  window.once("closed", () => { if (!quitting) backgroundOperation(() => { rendererReady = false; fallbackCamera("摄像头检测窗口已关闭"); }); });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl()) event.preventDefault();
  });
  void window.loadURL(rendererUrl());
  return window;
}
function showWindow(): void { if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(); else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
function installIpc(): void {
  ipcMain.handle("pomodoro:get-snapshot", (event) => { assertSender(event); if (runtimeFailure) throw runtimeFailure; return coreOperation(() => { const snapshot = currentEngine().snapshot; publishSnapshot(snapshot); return timerSnapshotSchema.parse(snapshot); }); });
  ipcMain.handle("pomodoro:get-settings", (event) => { assertSender(event); return settingsSchema.parse(currentEngine().settings); });
  ipcMain.handle("pomodoro:get-capabilities", (event) => { assertSender(event); return capabilities; });
  ipcMain.handle("pomodoro:get-camera-state", (event) => { assertSender(event); return cameraStateSchema.parse(camera.state); });
  ipcMain.handle("pomodoro:report-camera-presence", (event, raw: unknown) => {
    assertSender(event);
    const report = cameraPresenceReportSchema.parse(raw);
    if (runtimeFailure) throw runtimeFailure;
    if (camera.expired(performance.now())) {
      coreOperation(() => fallbackCamera("摄像头检测响应超时"));
      throw new Error("摄像头检测响应超时");
    }
    camera.report(report.generation, performance.now());
    return coreOperation(() => {
      if (report.presence === "unknown") fallbackCamera("摄像头不可用或检测中断");
      else publishSnapshot(currentEngine().cameraSample(report.presence));
      return timerSnapshotSchema.parse(currentEngine().snapshot);
    });
  });
  ipcMain.handle("pomodoro:get-statistics", (event) => { assertSender(event); return coreOperation(() => statistics()); });
  ipcMain.handle("pomodoro:command", (event, raw: unknown) => { assertSender(event); return runCommand(timerCommandSchema.parse(raw)); });
  ipcMain.handle("pomodoro:update-settings", (event, raw: unknown) => {
    assertSender(event);
    const patch = settingsPatchSchema.parse(raw);
    if (patch.focusPresenceSource === "camera" && !capabilities.cameraPresence) throw new Error("当前平台不支持摄像头感知");
    return coreOperation(() => {
      const settings = currentEngine().applySettings(patch);
      syncCamera();
      broadcast({ type: "settings.changed", settings });
      mainWindow?.setAlwaysOnTop(settings.alwaysOnTop);
      if (process.platform === "win32" && patch.theme) mainWindow?.setTitleBarOverlay(windowsCaption());
      publishSnapshot();
      return settings;
    });
  });
}
function startMonitoring(): void {
  monitorTimer = setInterval(() => {
    backgroundOperation(() => { if (camera.expired(performance.now())) fallbackCamera("摄像头检测响应超时"); sampleInput(); });
  }, 1000);
  tickTimer = setInterval(() => backgroundOperation(() => { if (camera.expired(performance.now())) fallbackCamera("摄像头检测响应超时"); publishSnapshot(); }), 500);
  powerMonitor.on("suspend", () => backgroundOperation(() => { suspended = true; publishSnapshot(currentEngine().systemSuspend()); syncCamera(); notify("计时已暂停", "系统进入睡眠，恢复后等待安全条件继续计时"); }));
  powerMonitor.on("resume", () => backgroundOperation(() => { suspended = false; syncCamera(); publishSnapshot(); }));
  powerMonitor.on("lock-screen", () => backgroundOperation(() => { screenLocked = true; publishSnapshot(currentEngine().systemLock()); syncCamera(); }));
  powerMonitor.on("unlock-screen", () => backgroundOperation(() => { screenLocked = false; publishSnapshot(currentEngine().systemUnlock()); syncCamera(); }));
}
app.whenReady().then(() => {
  if (!ownsInstanceLock) return;
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
    try {
      store = new SqliteStore(app.getPath("userData"));
      engine = new TimerEngine(store, { now: () => performance.now(), wallDate: () => new Date() });
    } catch (failure) {
      const reason = failure instanceof StoreRecoveryError ? failure : store?.prepareRecovery(failure);
      if (!reason) throw failure;
      const canRebuild = reason.backupDirectory !== undefined;
      const choice = dialog.showMessageBoxSync({
        type: "error", title: "本地数据无法读取", message: "本地数据无法读取，原始数据不会被覆盖。",
        detail: `${reason.message}\n\n${canRebuild ? `备份已保存到：${reason.backupDirectory}\n重建后从新计时器开始，历史数据保留在备份中。` : "自动备份失败。请保留原始数据并退出，暂时无法安全重建。"}`,
        buttons: canRebuild ? ["退出并保留数据", "从备份重建新数据库"] : ["退出并保留数据"],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (!canRebuild || choice !== 1) { app.quit(); return; }
      store = rebuildSqliteStore(reason);
      engine = new TimerEngine(store, { now: () => performance.now(), wallDate: () => new Date() });
    }
    lastCompletedRoundRevision = engine.completedRoundsRevision;
    lastStatisticsRevision = store.completedSessionsRevision;
    lastStatisticsDate = localDateKey(new Date());
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
    updateTray(engine.snapshot);
    startMonitoring();
    app.on("activate", () => showWindow()); app.on("window-all-closed", () => { if (process.platform !== "darwin") { /* close-to-tray keeps the process alive */ } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法打开本地数据";
    dialog.showErrorBox("本地计时器无法启动", `${message}\n\n原始本地数据已保留，请重新打开应用重试。`);
    app.quit();
  }
});
app.on("before-quit", () => {
  quitting = true;
  if (monitorTimer) clearInterval(monitorTimer);
  if (tickTimer) clearInterval(tickTimer);
  try { if (!runtimeFailure) engine?.systemSuspend(); } catch (reason) { console.error("退出时无法保存计时快照", reason instanceof Error ? reason.message : "本地存储错误"); }
  try { store?.close(); } catch (reason) { console.error("本地数据库关闭失败", reason instanceof Error ? reason.message : "本地存储错误"); }
});
export { TimerEngine };

import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import {
  capabilitiesSchema,
  settingsPatchSchema,
  timerCommandSchema,
} from "../shared/contracts.js";
import { CoreSupervisor } from "./sidecar.js";

const core = new CoreSupervisor();
let mainWindow: BrowserWindow | undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 360,
    height: 478,
    minWidth: 160,
    minHeight: 180,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#2f384b",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  return window;
}

function isMainWindow(event: IpcMainInvokeEvent): boolean {
  return event.sender.id === mainWindow?.webContents.id;
}

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!isMainWindow(event)) {
    throw new Error("Unsupported IPC sender.");
  }
}

function installIpcHandlers(): void {
  ipcMain.handle("pomodoro:get-snapshot", async (event) => {
    assertMainWindow(event);
    return core.getSnapshot();
  });
  ipcMain.handle("pomodoro:get-settings", async (event) => {
    assertMainWindow(event);
    return core.getInitializeResult().settings;
  });
  ipcMain.handle("pomodoro:get-capabilities", async (event) => {
    assertMainWindow(event);
    return capabilitiesSchema.parse(core.getInitializeResult().capabilities);
  });
  ipcMain.handle("pomodoro:command", async (event, command: unknown) => {
    assertMainWindow(event);
    return core.command(timerCommandSchema.parse(command));
  });
  ipcMain.handle("pomodoro:update-settings", async (event, patch: unknown) => {
    assertMainWindow(event);
    settingsPatchSchema.parse(patch);
    throw new Error("Settings updates are introduced with the Phase 1 state machine.");
  });
}

app.whenReady().then(async () => {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) {
      mainWindow = createWindow();
    }
  });

  installIpcHandlers();
  try {
    await core.start();
  } catch (error) {
    console.error(
      "Timer core initialization failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
  mainWindow = createWindow();
});

app.on("before-quit", () => {
  core.stop();
});

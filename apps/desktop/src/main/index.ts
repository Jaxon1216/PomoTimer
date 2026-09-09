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

// 领域：Electron / 主进程
// 顺序：启动链中由 Main 创建；命令链第 3 站由 IPC 处理器调用 CoreSupervisor。
// 作用：保存 Go Core 的唯一监督器和当前主窗口引用。
// 原因：主进程拥有原生资源，不能由多个 Renderer 分别创建或管理。
// 边界：Renderer 不直接访问 Core，也不持有 BrowserWindow。
const core = new CoreSupervisor();
let mainWindow: BrowserWindow | undefined;

// 领域：Electron / 主进程
// 顺序：启动链末尾：Core 初始化完成 -> createWindow -> Renderer App。
// 作用：创建加载 React Renderer 的原生应用窗口。
// 原因：窗口安全选项需要在创建时一次性确定，避免页面获得 Node 或 Electron 特权。
// 边界：此函数只配置窗口和导航规则，不处理计时业务。
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

// 领域：Electron / IPC
// 顺序：命令和读快照链第 3 站：Preload invoke -> Main IPC -> 调用方验证。
// 作用：确认一次 IPC 调用来自当前主窗口的 Renderer。
// 原因：preload 的类型不是安全边界，任意 WebContents 都不应能调用计时命令。
// 边界：通过验证后仍需对每个载荷做运行时 schema 校验。
function isMainWindow(event: IpcMainInvokeEvent): boolean {
  return event.sender.id === mainWindow?.webContents.id;
}

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!isMainWindow(event)) {
    throw new Error("Unsupported IPC sender.");
  }
}

// 领域：Electron / IPC
// 顺序：命令链第 3 站：Preload -> ipcMain handler -> CoreSupervisor -> Go Core。
// 作用：注册 Renderer 可调用的固定 IPC 白名单，并转发给 Go Core。
// 原因：显式逐个注册可避免把 ipcRenderer 或任意 channel 暴露给页面代码。
// 边界：Main 验证调用方和输入；Core 才是计时状态和设置的最终所有者。
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

// 领域：Electron / 生命周期
// 顺序：启动链第 1 站：Electron ready -> 注册 IPC -> 启动 Core -> 创建 Renderer 窗口。
// 作用：Electron 就绪后安装全局安全限制、启动 Core，再创建窗口。
// 原因：Core 初始化失败时 UI 仍可显示故障状态，而不是让应用在启动阶段直接退出。
// 边界：此处不缓存或伪造计时快照；Core 不可用时命令会失败。
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

// 领域：Electron / 生命周期
// 顺序：退出链第 1 站：Electron before-quit -> CoreSupervisor.stop -> Go stdin/stdout 关闭。
// 作用：应用退出前停止 Go 子进程并拒绝尚未完成的请求。
// 原因：避免 Core 成为孤儿进程，或让 Renderer 永远等待一个不会返回的请求。
// 边界：停止只清理本次运行资源，不删除用户目录中的 SQLite 数据。
app.on("before-quit", () => {
  core.stop();
});

import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { join } from "node:path";
import { completionReminderSchema, dismissReminderSchema, nullableCompletionReminderSchema, type CompletionReminder } from "../shared/reminder.js";

const cardSize = { width: 340, height: 240 };

// CompletionReminders 持有当前进程内唯一的完成提醒，不持有计时状态。
//
// 领域：Electron / 完成提醒
// 顺序：完成链第 2 站，Main 已提交的轮次结果 -> 提醒窗口 -> 独立 Preload。
// 作用：无声展示最新完成结果，确认时仅关闭该条提醒。
// 原因：系统通知可能不显示，主窗口的唤起又会切走当前输入焦点。
// 边界：提醒窗口只可读取和确认自身提醒；计时、设置与摄像头权限仍属于主窗口。
export class CompletionReminders {
  private window: BrowserWindow | undefined;
  private current: CompletionReminder | null = null;
  private blocked = false;
  private ready = false;
  private disposed = false;

  constructor(
    private readonly rendererUrl: () => string,
    private readonly anchorBounds: () => Rectangle | undefined,
    private readonly reportFailure: (reason: unknown) => void,
  ) {}

  installIpc(): void {
    ipcMain.handle("pomodoro:get-reminder", (event) => {
      this.assertSender(event);
      return nullableCompletionReminderSchema.parse(this.current);
    });
    ipcMain.handle("pomodoro:dismiss-reminder", (event, raw: unknown) => {
      this.assertSender(event);
      const { id } = dismissReminderSchema.parse(raw);
      if (id !== this.current?.id) return false;
      this.clear();
      return true;
    });
  }

  present(reminder: CompletionReminder): void {
    if (this.disposed) return;
    this.current = completionReminderSchema.parse(reminder);
    this.updateView(() => {
      this.ensureWindow();
      this.publish();
      this.show();
    });
  }

  setTheme(theme: CompletionReminder["theme"]): void {
    if (!this.current || this.current.theme === theme) return;
    this.current = completionReminderSchema.parse({ ...this.current, theme });
    this.updateView(() => this.publish());
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    this.updateView(() => {
      if (blocked) this.window?.hide();
      else if (this.current) {
        this.ensureWindow();
        this.show();
      }
    });
  }

  clear(): void {
    this.current = null;
    // 隐藏保留窗口，让确认 IPC 能完成回复；下次完成复用同一个隔离界面。
    this.updateView(() => {
      this.window?.hide();
      this.publish();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.current = null;
    this.dropView();
  }

  private assertSender(event: IpcMainInvokeEvent): void {
    if (!this.window || event.sender.id !== this.window.webContents.id || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("不支持的提醒 IPC 调用来源");
    }
  }

  private publish(): void {
    if (this.ready && this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("pomodoro:reminder", nullableCompletionReminderSchema.parse(this.current));
    }
  }

  private show(): void {
    if (!this.current || this.blocked || !this.ready || !this.window || this.window.isDestroyed()) return;
    const anchor = this.anchorBounds();
    const area = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea;
    const width = Math.min(cardSize.width, area.width);
    const height = Math.min(cardSize.height, area.height);
    this.window.setBounds({ x: area.x + Math.max(0, area.width - width - 20), y: area.y + Math.max(0, area.height - height - 20), width, height });
    this.window.showInactive();
  }

  private ensureWindow(): void {
    if (this.window && !this.window.isDestroyed()) return;
    this.createWindow();
  }

  // 领域：Electron / 提醒故障隔离
  // 顺序：提醒生命周期 -> updateView -> dropView -> 主窗口错误提示。
  // 作用：隔离原生窗口操作，销毁失败时尝试隐藏，并保留尚未确认的完成结果。
  // 原因：提醒故障不能进入存储故障路径；旧窗口回调不能影响之后创建的窗口。
  // 边界：先解除窗口归属再清理；错误提示本身失败也不抛出或递归重试。
  private updateView(operation: () => void): void {
    try {
      operation();
    } catch (reason) {
      this.dropView({ reason });
    }
  }

  private dropView(failure?: { reason: unknown }): void {
    const window = this.window;
    this.window = undefined;
    this.ready = false;
    try {
      window?.destroy();
    } catch (reason) {
      try { window?.hide(); } catch { /* 原生窗口已不可用，不能再次触发故障处理。 */ }
      failure ??= { reason };
    }
    if (failure) {
      try { this.reportFailure(failure.reason); } catch { /* 主窗口也可能已经退出。 */ }
    }
  }

  private createWindow(): void {
    this.ready = false;
    const window = new BrowserWindow({
      ...cardSize,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      backgroundColor: this.current?.theme === "dark" ? "#252b39" : "#f4f1eb",
      title: "轮次完成",
      webPreferences: {
        preload: join(__dirname, "../preload/reminder.js"),
        partition: "completion-reminder",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.window = window;
    window.setAlwaysOnTop(true, "floating");
    window.removeMenu();
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("close", (event) => {
      if (this.disposed) return;
      event.preventDefault();
      this.clear();
    });
    window.once("closed", () => { if (this.window === window) { this.window = undefined; this.ready = false; } });
    const fail = (reason: unknown) => {
      if (this.disposed || this.window !== window) return;
      this.dropView({ reason });
    };
    window.webContents.on("render-process-gone", () => fail(new Error("完成提醒界面已中断")));
    const url = new URL("reminder.html", this.rendererUrl());
    void window.loadURL(url.href).then(() => {
      if (this.disposed || this.window !== window) return;
      this.updateView(() => {
        this.ready = true;
        this.publish();
        this.show();
      });
    }).catch(fail);
  }
}

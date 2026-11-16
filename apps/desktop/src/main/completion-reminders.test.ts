import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionReminder } from "../shared/reminder.js";
import { CompletionReminders } from "./completion-reminders.js";

type InvokeEvent = { sender: { id: number; mainFrame: object }; senderFrame: object | null };

const electron = vi.hoisted(() => {
  type Listener = (...arguments_: unknown[]) => void;
  const handlers = new Map<string, (event: InvokeEvent, raw?: unknown) => unknown>();
  const control = { constructorFailure: undefined as Error | undefined };

  class Events {
    private readonly listeners = new Map<string, Set<Listener>>();

    on(name: string, listener: Listener): this {
      const listeners = this.listeners.get(name) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return this;
    }

    once(name: string, listener: Listener): this {
      const once: Listener = (...arguments_) => {
        this.listeners.get(name)?.delete(once);
        listener(...arguments_);
      };
      return this.on(name, once);
    }

    emit(name: string, ...arguments_: unknown[]): void {
      for (const listener of [...this.listeners.get(name) ?? []]) listener(...arguments_);
    }
  }

  class Contents extends Events {
    readonly id = windows.length + 1;
    readonly mainFrame = {};
    readonly send = vi.fn();
    readonly setWindowOpenHandler = vi.fn();
    readonly session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
  }

  class Window extends Events {
    readonly webContents = new Contents();
    readonly setAlwaysOnTop = vi.fn();
    readonly removeMenu = vi.fn();
    readonly hide = vi.fn();
    readonly showInactive = vi.fn();
    readonly setBounds = vi.fn<(bounds: Rectangle) => void>();
    readonly loaded: { resolve: () => void; reject: (reason: unknown) => void };
    readonly loadURL;
    private destroyed = false;

    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      if (control.constructorFailure) throw control.constructorFailure;
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      this.loaded = { resolve, reject };
      this.loadURL = vi.fn(() => promise);
      windows.push(this);
    }

    isDestroyed(): boolean { return this.destroyed; }

    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
  }

  const windows: Window[] = [];
  return {
    BrowserWindow: Window,
    windows,
    control,
    handlers,
    ipcMain: { handle: vi.fn((name: string, handler: (event: InvokeEvent, raw?: unknown) => unknown) => handlers.set(name, handler)) },
    screen: {
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 1920, y: 0, width: 2560, height: 1440 } })),
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
  };
});

vi.mock("electron", () => electron);

const reminder: CompletionReminder = {
  id: 1,
  completedKind: "focus",
  nextKind: "short-break",
  completedAt: "2026-11-10T09:00:00.000Z",
  theme: "light",
};

function lastWindow() {
  const window = electron.windows.at(-1);
  if (!window) throw new Error("No reminder window was created");
  return window;
}

function sender(window = lastWindow()) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame };
}

function invoke(channel: string, raw?: unknown, event: InvokeEvent = sender()) {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler(event, raw);
}

async function loaded(window = lastWindow()): Promise<void> {
  window.loaded.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function create(anchor: Rectangle | null = { x: 2000, y: 100, width: 500, height: 700 }) {
  const reportFailure = vi.fn();
  const anchorBounds = vi.fn(() => anchor ?? undefined);
  const reminders = new CompletionReminders(() => "file:///app/out/renderer/index.html", anchorBounds, reportFailure);
  reminders.installIpc();
  return { reminders, reportFailure, anchorBounds };
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.windows.length = 0;
  electron.handlers.clear();
  electron.control.constructorFailure = undefined;
  electron.screen.getDisplayMatching.mockReturnValue({ workArea: { x: 1920, y: 0, width: 2560, height: 1440 } });
  electron.screen.getPrimaryDisplay.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
});

describe("CompletionReminders", () => {
  it("accepts IPC only from the current reminder window's main frame", async () => {
    const { reminders } = create();
    reminders.present(reminder);
    await loaded();
    const window = lastWindow();
    const anotherContents = { id: window.webContents.id + 1, mainFrame: {} };
    const untrusted = [
      { sender: anotherContents, senderFrame: anotherContents.mainFrame },
      { sender: window.webContents, senderFrame: {} },
      { sender: window.webContents, senderFrame: null },
    ];

    for (const event of untrusted) {
      expect(() => invoke("pomodoro:get-reminder", undefined, event)).toThrow("调用来源");
      expect(() => invoke("pomodoro:dismiss-reminder", { id: reminder.id }, event)).toThrow("调用来源");
    }
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
    expect(window.hide).not.toHaveBeenCalled();

    reminders.dispose();
    expect(() => invoke("pomodoro:get-reminder", undefined, sender(window))).toThrow("调用来源");
  });

  it.each([
    { id: 1, command: "start" },
    { id: 1, extra: true },
    { id: "1" },
    { id: 0 },
    { id: 1.5 },
    {},
    null,
  ])("rejects an invalid dismissal without clearing current state: %j", async (raw) => {
    const { reminders } = create();
    reminders.present(reminder);
    await loaded();

    expect(() => invoke("pomodoro:dismiss-reminder", raw)).toThrow();
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
    expect(lastWindow().hide).not.toHaveBeenCalled();
  });

  it("requires the latest reminder id so a delayed acknowledgement cannot dismiss its replacement", async () => {
    const { reminders } = create();
    reminders.present(reminder);
    await loaded();
    const replacement = { ...reminder, id: 2, completedKind: "short-break", nextKind: "focus" } as const;
    reminders.present(replacement);

    expect(invoke("pomodoro:dismiss-reminder", { id: 1 })).toBe(false);
    expect(invoke("pomodoro:get-reminder")).toEqual(replacement);
    expect(lastWindow().hide).not.toHaveBeenCalled();
    expect(invoke("pomodoro:dismiss-reminder", { id: 2 })).toBe(true);
    expect(invoke("pomodoro:get-reminder")).toBeNull();
    expect(lastWindow().hide).toHaveBeenCalledOnce();
    expect(lastWindow().webContents.send).toHaveBeenLastCalledWith("pomodoro:reminder", null);
  });

  it("retains the newest reminder while blocked, including when loading finishes during a lock", async () => {
    const { reminders } = create();
    reminders.setBlocked(true);
    reminders.present(reminder);
    const window = lastWindow();
    await loaded();
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);

    reminders.present({ ...reminder, id: 2 });
    expect(window.showInactive).not.toHaveBeenCalled();
    reminders.setBlocked(false);
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(invoke("pomodoro:get-reminder")).toMatchObject({ id: 2 });

    reminders.setBlocked(true);
    expect(window.hide).toHaveBeenCalledOnce();
    reminders.clear();
    reminders.setBlocked(false);
    expect(window.showInactive).toHaveBeenCalledOnce();
  });

  it("clears only reminder state and reuses the isolated window for a future completion", async () => {
    const { reminders } = create();
    reminders.present(reminder);
    await loaded();
    const window = lastWindow();
    expect([...electron.handlers.keys()]).toEqual(["pomodoro:get-reminder", "pomodoro:dismiss-reminder"]);

    reminders.clear();
    expect(invoke("pomodoro:get-reminder")).toBeNull();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenLastCalledWith("pomodoro:reminder", null);

    reminders.present({ ...reminder, id: 2 });
    expect(electron.windows).toHaveLength(1);
    expect(invoke("pomodoro:get-reminder")).toMatchObject({ id: 2 });
    expect(window.showInactive).toHaveBeenCalledTimes(2);
  });

  it("does not show a cleared reminder when its pending load completes", async () => {
    const { reminders } = create();
    reminders.present(reminder);
    reminders.clear();
    await loaded();

    expect(lastWindow().showInactive).not.toHaveBeenCalled();
    expect(lastWindow().webContents.send).toHaveBeenLastCalledWith("pomodoro:reminder", null);
  });

  it("reports a load failure while retaining the reminder for a later unblock retry", async () => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    const failedWindow = lastWindow();
    const reason = new Error("load failed");
    failedWindow.loaded.reject(reason);
    await Promise.resolve();
    await Promise.resolve();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(reason);
    expect(failedWindow.destroy).toHaveBeenCalledOnce();

    reminders.setBlocked(false);
    expect(lastWindow()).not.toBe(failedWindow);
    await loaded();
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
    expect(lastWindow().showInactive).toHaveBeenCalledOnce();
    expect(() => invoke("pomodoro:get-reminder", undefined, sender(failedWindow))).toThrow("调用来源");
  });

  it("recovers on the next completion after renderer loss and ignores the old window's late load", async () => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    const failedWindow = lastWindow();
    failedWindow.webContents.emit("render-process-gone");
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(failedWindow.destroy).toHaveBeenCalledOnce();

    reminders.present({ ...reminder, id: 2 });
    const replacementWindow = lastWindow();
    await loaded(failedWindow);
    expect(replacementWindow.showInactive).not.toHaveBeenCalled();
    await loaded(replacementWindow);
    expect(replacementWindow.showInactive).toHaveBeenCalledOnce();
    expect(invoke("pomodoro:get-reminder")).toMatchObject({ id: 2 });
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("reports synchronous window creation failure and can retry without losing the completion", async () => {
    const { reminders, reportFailure } = create();
    const reason = new Error("window unavailable");
    electron.control.constructorFailure = reason;

    expect(() => reminders.present(reminder)).not.toThrow();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(reason);
    electron.control.constructorFailure = undefined;
    reminders.setBlocked(false);
    await loaded();
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
    expect(lastWindow().showInactive).toHaveBeenCalledOnce();
  });

  it.each([
    { x: 1920, y: 0, width: 2560, height: 1440 },
    { x: -1800, y: -300, width: 300, height: 180 },
  ])("keeps the complete card within the matching display work area: %j", async (area) => {
    const { reminders, anchorBounds } = create();
    electron.screen.getDisplayMatching.mockReturnValue({ workArea: area });
    reminders.present(reminder);
    await loaded();
    const bounds = lastWindow().setBounds.mock.calls.at(-1)?.[0];
    expect(electron.screen.getDisplayMatching).toHaveBeenCalledWith(anchorBounds());
    expect(electron.screen.getPrimaryDisplay).not.toHaveBeenCalled();
    expect(bounds).toEqual({
      x: area.x + Math.max(0, area.width - Math.min(340, area.width) - 20),
      y: area.y + Math.max(0, area.height - Math.min(240, area.height) - 20),
      width: Math.min(340, area.width),
      height: Math.min(240, area.height),
    });
    expect(bounds?.x).toBeGreaterThanOrEqual(area.x);
    expect(bounds?.y).toBeGreaterThanOrEqual(area.y);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(area.x + area.width);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(area.y + area.height);
  });

  it("uses the primary display when the main window has no anchor", async () => {
    const { reminders } = create(null);
    reminders.present(reminder);
    await loaded();
    expect(electron.screen.getPrimaryDisplay).toHaveBeenCalledOnce();
    expect(electron.screen.getDisplayMatching).not.toHaveBeenCalled();
    expect(lastWindow().setBounds).toHaveBeenLastCalledWith({ x: 1560, y: 820, width: 340, height: 240 });
  });

  it("does not let a pending load resurrect a disposed reminder window", async () => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    const window = lastWindow();
    reminders.dispose();
    await loaded(window);
    reminders.present({ ...reminder, id: 2 });

    expect(window.destroy).toHaveBeenCalledOnce();
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(electron.windows).toHaveLength(1);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "block", nativeMethod: "hide", retained: true },
    { operation: "unblock", nativeMethod: "showInactive", retained: true },
    { operation: "unblock", nativeMethod: "setBounds", retained: true },
    { operation: "clear", nativeMethod: "hide", retained: false },
    { operation: "clear", nativeMethod: "send", retained: false },
    { operation: "theme", nativeMethod: "send", retained: true },
  ] as const)("contains $nativeMethod failure during $operation without losing the intended reminder state", async ({ operation, nativeMethod, retained }) => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    await loaded();
    const window = lastWindow();
    if (operation === "unblock") reminders.setBlocked(true);
    const reason = new Error(`${nativeMethod} unavailable`);
    const nativeOperation = nativeMethod === "send" ? window.webContents.send : window[nativeMethod];
    nativeOperation.mockImplementationOnce(() => { throw reason; });

    const update = () => {
      if (operation === "block") reminders.setBlocked(true);
      else if (operation === "unblock") reminders.setBlocked(false);
      else if (operation === "clear") reminders.clear();
      else reminders.setTheme("dark");
    };
    expect(update).not.toThrow();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(reason);
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(() => invoke("pomodoro:get-reminder", undefined, sender(window))).toThrow("调用来源");

    reminders.setBlocked(false);
    if (retained) {
      expect(lastWindow()).not.toBe(window);
      await loaded();
      expect(invoke("pomodoro:get-reminder")).toEqual({ ...reminder, theme: operation === "theme" ? "dark" : "light" });
    } else {
      expect(electron.windows).toHaveLength(1);
      reminders.present({ ...reminder, id: 2 });
      await loaded();
      expect(invoke("pomodoro:get-reminder")).toMatchObject({ id: 2 });
    }
  });

  it("keeps failures contained when both teardown and the owner's error callback fail", async () => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    await loaded();
    const failedWindow = lastWindow();
    const reason = new Error("hide failed");
    failedWindow.hide.mockImplementationOnce(() => { throw reason; });
    failedWindow.destroy.mockImplementationOnce(() => { throw new Error("destroy failed"); });
    reportFailure.mockImplementationOnce(() => { throw new Error("owner gone"); });

    expect(() => reminders.setBlocked(true)).not.toThrow();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(reason);
    expect(failedWindow.hide).toHaveBeenCalledTimes(2);
    reminders.setBlocked(false);
    const replacement = lastWindow();
    await loaded();
    failedWindow.emit("closed");
    failedWindow.webContents.emit("render-process-gone");

    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it.each(["send", "setBounds", "showInactive"] as const)("contains asynchronous %s failure even when teardown and reporting fail", async (nativeMethod) => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    const failedWindow = lastWindow();
    const reason = new Error(`${nativeMethod} failed`);
    const nativeOperation = nativeMethod === "send" ? failedWindow.webContents.send : failedWindow[nativeMethod];
    nativeOperation.mockImplementationOnce(() => { throw reason; });
    failedWindow.destroy.mockImplementationOnce(() => { throw new Error("destroy failed"); });
    reportFailure.mockImplementationOnce(() => { throw new Error("owner gone"); });

    await loaded(failedWindow);
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(reason);
    expect(failedWindow.destroy).toHaveBeenCalledOnce();
    expect(failedWindow.hide).toHaveBeenCalledOnce();
    reminders.setBlocked(false);
    await loaded();
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
  });

  it("contains renderer failure and ignores its late load rejection after replacing a broken view", async () => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    const failedWindow = lastWindow();
    failedWindow.destroy.mockImplementationOnce(() => { throw new Error("destroy failed"); });
    reportFailure.mockImplementationOnce(() => { throw new Error("owner gone"); });

    expect(() => failedWindow.webContents.emit("render-process-gone")).not.toThrow();
    expect(reportFailure).toHaveBeenCalledOnce();
    reminders.setBlocked(false);
    const replacement = lastWindow();
    await loaded(replacement);
    failedWindow.loaded.reject(new Error("old load rejected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(invoke("pomodoro:get-reminder")).toEqual(reminder);
  });

  it("finishes disposal even if native cleanup and failure reporting all throw", async () => {
    const { reminders, reportFailure } = create();
    reminders.present(reminder);
    await loaded();
    const window = lastWindow();
    const reason = new Error("destroy failed");
    window.destroy.mockImplementationOnce(() => { throw reason; });
    window.hide.mockImplementationOnce(() => { throw new Error("hide failed"); });
    reportFailure.mockImplementationOnce(() => { throw new Error("owner gone"); });

    expect(() => reminders.dispose()).not.toThrow();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(reason);
    expect(() => invoke("pomodoro:get-reminder", undefined, sender(window))).toThrow("调用来源");
    reminders.present({ ...reminder, id: 2 });
    reminders.setBlocked(false);
    expect(electron.windows).toHaveLength(1);
  });
});

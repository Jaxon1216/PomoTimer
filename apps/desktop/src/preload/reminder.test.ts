import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionReminder, ReminderApi } from "../shared/reminder.js";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

const reminder: CompletionReminder = {
  id: 1, completedKind: "focus", nextKind: "short-break", completedAt: "2026-11-10T09:00:00.000Z", theme: "light",
};

async function loadApi(): Promise<ReminderApi> {
  await import("./reminder.js");
  return electron.exposeInMainWorld.mock.calls[0]?.[1] as ReminderApi;
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe("reminder preload", () => {
  it("exposes only the reminder allowlist and validates responses", async () => {
    const api = await loadApi();
    expect(electron.exposeInMainWorld.mock.calls[0]?.[0]).toBe("pomodoro");
    expect(Object.keys(api).sort()).toEqual(["dismissReminder", "getReminder", "subscribeReminder"]);
    electron.invoke.mockResolvedValueOnce(reminder).mockResolvedValueOnce({ ...reminder, command: "next" });
    await expect(api.getReminder()).resolves.toEqual(reminder);
    await expect(api.getReminder()).rejects.toThrow();
    expect(electron.invoke).toHaveBeenCalledWith("pomodoro:get-reminder");
  });

  it("validates the dismissal before IPC and its boolean response", async () => {
    const api = await loadApi();
    await expect(api.dismissReminder(0)).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
    electron.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce("true");
    await expect(api.dismissReminder(1)).resolves.toBe(true);
    expect(electron.invoke).toHaveBeenCalledWith("pomodoro:dismiss-reminder", { id: 1 });
    await expect(api.dismissReminder(1)).rejects.toThrow();
  });

  it("drops invalid events, accepts clear events and removes its own listener", async () => {
    const api = await loadApi();
    const listener = vi.fn();
    const unsubscribe = api.subscribeReminder(listener);
    const handler = electron.on.mock.calls[0]?.[1] as (_event: unknown, payload: unknown) => void;
    handler({}, { ...reminder, theme: "system" });
    expect(listener).not.toHaveBeenCalled();
    handler({}, reminder);
    handler({}, null);
    expect(listener.mock.calls).toEqual([[reminder], [null]]);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith("pomodoro:reminder", handler);
  });
});

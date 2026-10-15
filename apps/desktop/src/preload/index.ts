import { contextBridge, ipcRenderer } from "electron";
import { capabilitiesSchema, coreEventSchema, settingsPatchSchema, settingsSchema, statisticsSnapshotSchema, timerCommandSchema, timerSnapshotSchema, type CoreEvent, type PomodoroApi } from "../shared/contracts.js";

const api: PomodoroApi = {
  getSnapshot: async () => timerSnapshotSchema.parse(await ipcRenderer.invoke("pomodoro:get-snapshot")),
  command: async (command) => timerSnapshotSchema.parse(await ipcRenderer.invoke("pomodoro:command", timerCommandSchema.parse(command))),
  getSettings: async () => settingsSchema.parse(await ipcRenderer.invoke("pomodoro:get-settings")),
  updateSettings: async (patch) => settingsSchema.parse(await ipcRenderer.invoke("pomodoro:update-settings", settingsPatchSchema.parse(patch))),
  getCapabilities: async () => capabilitiesSchema.parse(await ipcRenderer.invoke("pomodoro:get-capabilities")),
  getStatistics: async () => statisticsSnapshotSchema.parse(await ipcRenderer.invoke("pomodoro:get-statistics")),
  subscribe: (listener) => { const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => { const event = coreEventSchema.safeParse(raw); if (event.success) listener(event.data as CoreEvent); }; ipcRenderer.on("pomodoro:event", handler); return () => ipcRenderer.removeListener("pomodoro:event", handler); },
};
contextBridge.exposeInMainWorld("pomodoro", api);

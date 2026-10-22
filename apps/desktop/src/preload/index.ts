import { contextBridge, ipcRenderer } from "electron";
import { capabilitiesSchema, coreEventSchema, settingsPatchSchema, settingsSchema, statisticsSnapshotSchema, timerCommandSchema, timerSnapshotSchema, windowModeSchema, type CoreEvent, type PomodoroApi } from "../shared/contracts.js";

const api: PomodoroApi = {
  getSnapshot: async () => timerSnapshotSchema.parse(await ipcRenderer.invoke("pomodoro:get-snapshot")),
  command: async (command) => timerSnapshotSchema.parse(await ipcRenderer.invoke("pomodoro:command", timerCommandSchema.parse(command))),
  getSettings: async () => settingsSchema.parse(await ipcRenderer.invoke("pomodoro:get-settings")),
  updateSettings: async (patch) => settingsSchema.parse(await ipcRenderer.invoke("pomodoro:update-settings", settingsPatchSchema.parse(patch))),
  getCapabilities: async () => capabilitiesSchema.parse(await ipcRenderer.invoke("pomodoro:get-capabilities")),
  getStatistics: async () => statisticsSnapshotSchema.parse(await ipcRenderer.invoke("pomodoro:get-statistics")),
  // 领域：Electron / Preload
  // 顺序：窗口模式链第 2 站，Renderer -> 受控桥接 -> Main IPC。
  // 作用：仅暴露已校验的窗口模式读写，不允许传入尺寸或任意通道。
  // 原因：原生窗口由 Main 管理，跨进程参数和返回值都需要验证。
  // 边界：不暴露 Electron、系统路径或计时核心实现。
  getWindowMode: async () => windowModeSchema.parse(await ipcRenderer.invoke("pomodoro:get-window-mode")),
  setWindowMode: async (mode) => windowModeSchema.parse(await ipcRenderer.invoke("pomodoro:set-window-mode", windowModeSchema.parse(mode))),
  subscribe: (listener) => { const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => { const event = coreEventSchema.safeParse(raw); if (event.success) listener(event.data as CoreEvent); }; ipcRenderer.on("pomodoro:event", handler); return () => ipcRenderer.removeListener("pomodoro:event", handler); },
};
contextBridge.exposeInMainWorld("pomodoro", api);

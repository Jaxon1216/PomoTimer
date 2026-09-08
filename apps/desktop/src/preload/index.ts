import { contextBridge, ipcRenderer } from "electron";
import {
  capabilitiesSchema,
  settingsPatchSchema,
  settingsSchema,
  timerCommandSchema,
  timerSnapshotSchema,
  type PomodoroApi,
} from "../shared/contracts.js";

const api: PomodoroApi = {
  async getSnapshot() {
    return timerSnapshotSchema.parse(
      await ipcRenderer.invoke("pomodoro:get-snapshot"),
    );
  },
  async command(command) {
    return timerSnapshotSchema.parse(
      await ipcRenderer.invoke("pomodoro:command", timerCommandSchema.parse(command)),
    );
  },
  async getSettings() {
    return settingsSchema.parse(await ipcRenderer.invoke("pomodoro:get-settings"));
  },
  async updateSettings(patch) {
    return settingsSchema.parse(
      await ipcRenderer.invoke(
        "pomodoro:update-settings",
        settingsPatchSchema.parse(patch),
      ),
    );
  },
  async getCapabilities() {
    return capabilitiesSchema.parse(
      await ipcRenderer.invoke("pomodoro:get-capabilities"),
    );
  },
  subscribe() {
    return () => undefined;
  },
};

contextBridge.exposeInMainWorld("pomodoro", api);

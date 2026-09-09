import { contextBridge, ipcRenderer } from "electron";
import {
  capabilitiesSchema,
  settingsPatchSchema,
  settingsSchema,
  timerCommandSchema,
  timerSnapshotSchema,
  type PomodoroApi,
} from "../shared/contracts.js";

// 领域：Electron / Preload
// 顺序：命令和读快照链第 2 站：Renderer -> window.pomodoro -> ipcRenderer.invoke -> Main IPC。
// 作用：定义 Renderer 唯一可见的计时 API，并在发送和接收 IPC 数据时验证类型。
// 原因：contextIsolation 让页面与 Electron 特权环境分离，避免 Renderer 获取通用 IPC 能力。
// 边界：这里只暴露已列出的业务方法，不暴露 ipcRenderer、Node 模块、文件路径或 channel 名称。
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

// 领域：Electron / Preload
// 顺序：启动链：BrowserWindow 加载 preload -> 暴露 window.pomodoro -> Renderer App 调用 API。
// 作用：把经过限制的 API 注入隔离世界的 window.pomodoro。
// 原因：contextBridge 会复制受控接口，而不是共享 Electron 内部对象。
// 边界：Renderer 只能调用 PomodoroApi；所有实际权限与业务校验仍由 Main 和 Core 执行。
contextBridge.exposeInMainWorld("pomodoro", api);

import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import { dismissReminderSchema, nullableCompletionReminderSchema, type ReminderApi } from "../shared/reminder.js";

// 领域：Electron / 提醒 Preload
// 顺序：提醒链第 2 站，独立提醒视图 -> 白名单 IPC -> Main 提醒状态。
// 作用：校验读取、确认和推送数据，仅暴露三个提醒方法。
// 原因：附加窗口不能继承计时命令、设置修改和摄像头权限。
// 边界：不暴露 ipcRenderer、Node、通用通道或主窗口的 PomodoroApi。
const api: ReminderApi = {
  getReminder: async () => nullableCompletionReminderSchema.parse(await ipcRenderer.invoke("pomodoro:get-reminder")),
  dismissReminder: async (id) => z.boolean().parse(await ipcRenderer.invoke("pomodoro:dismiss-reminder", dismissReminderSchema.parse({ id }))),
  subscribeReminder: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const result = nullableCompletionReminderSchema.safeParse(raw);
      if (result.success) listener(result.data);
    };
    ipcRenderer.on("pomodoro:reminder", handler);
    return () => ipcRenderer.removeListener("pomodoro:reminder", handler);
  },
};

contextBridge.exposeInMainWorld("pomodoro", api);

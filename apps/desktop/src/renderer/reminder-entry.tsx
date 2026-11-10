import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ReminderApi } from "../shared/reminder";
import { Reminder } from "./Reminder";

// 领域：React / 独立提醒入口
// 顺序：提醒链第 1 站，提醒专用 BrowserWindow -> 专用 Preload -> Reminder。
// 作用：将本窗口的受限桥接接口交给提醒组件。
// 原因：同名 window.pomodoro 在主窗口和提醒窗口由不同的 Preload 提供。
// 边界：局部声明不扩展主窗口全局类型，不加载 App 或摄像头模块。
const reminderWindow = window as unknown as { pomodoro: ReminderApi };
const root = document.getElementById("root");
if (!root) throw new Error("Reminder root is missing.");

createRoot(root).render(<StrictMode><Reminder api={reminderWindow.pomodoro} /></StrictMode>);

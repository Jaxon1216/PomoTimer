import type { PomodoroApi } from "./contracts";

declare global {
  interface Window {
    pomodoro: PomodoroApi;
  }
}

export {};

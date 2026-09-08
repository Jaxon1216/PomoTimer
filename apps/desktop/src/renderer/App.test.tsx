import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type {
  Capabilities,
  Settings,
  TimerSnapshot,
} from "../shared/contracts";

const snapshot: TimerSnapshot = {
  revision: 0,
  emittedAt: "2026-09-08T09:00:00.000Z",
  round: {
    kind: "focus",
    cycleNumber: 1,
    positionInCycle: 1,
    focusRoundNumber: 1,
    breakMode: null,
    totalDurationMs: 1_800_000,
  },
  status: "idle",
  remainingMs: 1_800_000,
  automation: {
    activePresenceSource: "input",
    inputPresence: "unknown",
    cameraPresence: "unknown",
    inputMonitoringAvailable: true,
    cameraMonitoringAvailable: false,
    manualPauseLocked: false,
    pauseReason: "none",
  },
};

const settings: Settings = {
  version: 1,
  focusDurationSeconds: 1_800,
  shortBreakDurationSeconds: 300,
  longBreakDurationSeconds: 600,
  focusRoundsPerCycle: 3,
  inputIdleThresholdSeconds: 40,
  focusPresenceSource: "input",
  defaultBreakMode: "active",
  theme: "system",
  alwaysOnTop: false,
  notificationsEnabled: true,
};

const capabilities: Capabilities = {
  inputMonitoring: true,
  cameraPresence: false,
  standingFocus: false,
};

const runningSnapshot: TimerSnapshot = {
  ...snapshot,
  revision: 1,
  status: "running",
  automation: {
    ...snapshot.automation,
    pauseReason: "none",
  },
};

describe("App", () => {
  beforeEach(() => {
    window.pomodoro = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      getSettings: vi.fn().mockResolvedValue(settings),
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      command: vi.fn(),
      updateSettings: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
  });

  it("renders the Core snapshot in the compact timer shell", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "专注" }),
    ).toBeInTheDocument();
    expect(screen.getByText("30:00")).toBeInTheDocument();
    expect(screen.getByText("本地计时")).toBeInTheDocument();
    expect(screen.getByText("输入检测 · 40 秒")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开始计时" }),
    ).toBeEnabled();
  });

  it("uses the Core command result as the interactive timer state", async () => {
    const command = vi.fn().mockResolvedValue(runningSnapshot);
    window.pomodoro.command = command;

    render(<App />);
    const start = await screen.findByRole("button", { name: "开始计时" });
    fireEvent.click(start);

    await waitFor(() => {
      expect(command).toHaveBeenCalledWith("start");
    });
    expect(
      await screen.findByRole("button", { name: "暂停计时" }),
    ).toBeEnabled();
  });

  it("surfaces an unavailable Core without substituting local state", async () => {
    window.pomodoro.getSnapshot = vi
      .fn()
      .mockRejectedValue(new Error("core unavailable"));

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "未连接到计时核心" }),
    ).toBeInTheDocument();
  });
});

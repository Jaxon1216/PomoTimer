import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { formatDuration } from "./time";
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

const shortBreakSnapshot: TimerSnapshot = {
  ...snapshot,
  revision: 2,
  round: {
    ...snapshot.round,
    kind: "short-break",
    focusRoundNumber: null,
    breakMode: "active",
    totalDurationMs: 300_000,
  },
  remainingMs: 300_000,
};

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    [1_800_000, "30:00"],
    [1_771_000, "29:31"],
    [599_000, "09:59"],
    [0, "00:00"],
    [7_200_000, "120:00"],
  ])("formats %s milliseconds as %s without assuming two minute digits", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });

  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    window.pomodoro = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      getSettings: vi.fn().mockResolvedValue(settings),
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      getStatistics: vi.fn().mockResolvedValue({
        generatedAt: "2026-09-08T09:00:00.000Z",
        today: { localDate: "2026-09-08", completedFocusMinutes: 0, completedFocusRounds: 0 },
        week: [],
        heatmap: [],
      }),
      command: vi.fn(),
      updateSettings: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
  });

  it("renders the Core snapshot in the Pomotroid-style timer shell", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "专注" }),
    ).toBeInTheDocument();
    expect(screen.getByText("30:00")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("round-focus");
    expect(
      screen.getByRole("button", { name: "开始计时" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "重新开始当前轮次" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "跳到下一轮" })).toBeEnabled();
  });

  it("applies the short-break color variant from the Core round kind", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue(shortBreakSnapshot);

    render(<App />);

    await screen.findByRole("heading", { name: "短休" });
    expect(screen.getByRole("main")).toHaveClass("round-short-break");
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

  it("resizes presentation without changing a manually paused Core snapshot", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      status: "manual-paused",
      remainingMs: 7_200_000,
      round: { ...snapshot.round, totalDurationMs: 7_200_000 },
      automation: { ...snapshot.automation, manualPauseLocked: true },
    } satisfies TimerSnapshot);
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });

    vi.stubGlobal("innerWidth", 160);
    vi.stubGlobal("innerHeight", 180);
    fireEvent.resize(window);
    expect(screen.getByRole("main")).toHaveClass("compact");
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByText("手动暂停")).toBeInTheDocument();

    vi.stubGlobal("innerWidth", 301);
    vi.stubGlobal("innerHeight", 391);
    fireEvent.resize(window);
    expect(screen.getByRole("main")).not.toHaveClass("compact");
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续计时" })).toBeEnabled();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
    expect(window.pomodoro.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("retains the full pause reason when compact status text is shortened", async () => {
    vi.stubGlobal("innerWidth", 160);
    vi.stubGlobal("innerHeight", 180);
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      status: "auto-paused",
      automation: {
        ...snapshot.automation,
        inputMonitoringAvailable: false,
        pauseReason: "source-unavailable",
      },
    } satisfies TimerSnapshot);
    render(<App />);

    expect(await screen.findByText("检测不可用 · 手动控制"))
      .toHaveAttribute("title", "输入检测不可用，需手动控制");
    expect(screen.getByLabelText("专注，剩余 30:00，输入检测不可用，需手动控制"))
      .toBeInTheDocument();
  });

  it("surfaces an unavailable Core without substituting local state", async () => {
    window.pomodoro.getSnapshot = vi
      .fn()
      .mockRejectedValue(new Error("core unavailable"));

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "计时核心不可用" }),
    ).toBeInTheDocument();
  });

  it("updates a system theme when the operating system theme changes", async () => {
    let matches = false;
    let listener: (() => void) | undefined;
    window.matchMedia = vi.fn(() => ({
      get matches() {
        return matches;
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (_type: string, callback: () => void) => {
        listener = callback;
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;

    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    expect(document.documentElement).not.toHaveClass("dark");

    matches = true;
    listener?.();
    expect(document.documentElement).toHaveClass("dark");
  });
});

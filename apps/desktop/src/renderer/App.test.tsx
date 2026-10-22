import {
  act,
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
  CoreEvent,
  Settings,
  TimerSnapshot,
  WindowMode,
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

const waitingBreakSnapshot: TimerSnapshot = {
  ...shortBreakSnapshot,
  status: "auto-paused",
  automation: {
    ...shortBreakSnapshot.automation,
    inputPresence: "present",
    pauseReason: "break-condition",
  },
};

describe("App", () => {
  let eventListener: ((event: CoreEvent) => void) | undefined;

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
    eventListener = undefined;
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    window.pomodoro = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      getSettings: vi.fn().mockResolvedValue(settings),
      getCapabilities: vi.fn().mockResolvedValue(capabilities),
      getWindowMode: vi.fn().mockResolvedValue("regular"),
      setWindowMode: vi.fn().mockImplementation(async (mode: WindowMode) => mode),
      getStatistics: vi.fn().mockResolvedValue({
        generatedAt: "2026-09-08T09:00:00.000Z",
        today: { localDate: "2026-09-08", completedFocusMinutes: 0, completedFocusRounds: 0 },
        week: [],
        heatmap: [],
      }),
      command: vi.fn(),
      updateSettings: vi.fn(),
      subscribe: vi.fn((listener) => {
        eventListener = listener;
        return () => { eventListener = undefined; };
      }),
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
    expect(screen.getByRole("button", { name: "跳到下一轮" })).toBeEnabled();
    expect(screen.getByRole("main")).toHaveAttribute("data-window-mode", "regular");
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "重新开始当前轮次" })).toBeEnabled();
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

  it("resizes regular presentation without selecting mini mode or changing the Core snapshot", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      status: "manual-paused",
      remainingMs: 7_200_000,
      round: { ...snapshot.round, totalDurationMs: 7_200_000 },
      automation: { ...snapshot.automation, manualPauseLocked: true },
    } satisfies TimerSnapshot);
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });

    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 300);
    fireEvent.resize(window);
    expect(screen.getByRole("main")).not.toHaveClass("mini");
    expect(screen.getByRole("main")).toHaveAttribute("data-window-mode", "regular");
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByText("手动暂停 · 点击继续")).toBeInTheDocument();

    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 478);
    fireEvent.resize(window);
    expect(screen.getByRole("main")).not.toHaveClass("mini");
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续计时" })).toBeEnabled();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
    expect(window.pomodoro.setWindowMode).not.toHaveBeenCalled();
    expect(window.pomodoro.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("follows explicit Main window mode events without changing timer state", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });

    act(() => eventListener?.({ type: "window.modeChanged", mode: "mini" }));
    expect(screen.getByRole("main")).toHaveClass("mini");
    expect(screen.getByRole("main")).toHaveAttribute("data-window-mode", "mini");
    expect(screen.getByText("30:00")).toBeInTheDocument();

    act(() => eventListener?.({ type: "window.modeChanged", mode: "regular" }));
    expect(screen.getByRole("main")).not.toHaveClass("mini");
    expect(screen.getByRole("main")).toHaveAttribute("data-window-mode", "regular");
    expect(window.pomodoro.command).not.toHaveBeenCalled();
    expect(window.pomodoro.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("explicitly enters mini mode and restores regular mode through the menu", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "切换迷你模式" }));

    await waitFor(() => expect(screen.getByRole("main")).toHaveClass("mini"));
    expect(window.pomodoro.setWindowMode).toHaveBeenCalledWith("mini");
    expect(screen.queryByRole("button", { name: "打开统计" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "打开统计" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "打开设置" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "重新开始当前轮次" })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复常规窗口" }));

    await waitFor(() => expect(screen.getByRole("main")).not.toHaveClass("mini"));
    expect(window.pomodoro.setWindowMode).toHaveBeenCalledWith("regular");
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it.each(["regular", "mini"] as const)("keeps menu navigation reachable in %s mode", async (mode) => {
    window.pomodoro.getWindowMode = vi.fn().mockResolvedValue(mode);
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "打开设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("keeps the complete unavailable-monitoring reason visible in mini mode", async () => {
    window.pomodoro.getWindowMode = vi.fn().mockResolvedValue("mini");
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

    expect(await screen.findByText("输入检测不可用")).toBeInTheDocument();
    expect(screen.getByText("已暂停 · 可手动继续")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("mini");
    expect(screen.getByRole("button", { name: "继续计时" })).toBeEnabled();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", "准备开始", "开始计时"],
    ["manual-paused", "手动暂停 · 点击继续", "继续计时"],
  ] as const)("keeps unavailable input monitoring visible without overriding %s state", async (status, statusLabel, actionLabel) => {
    window.pomodoro.getWindowMode = vi.fn().mockResolvedValue("mini");
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      status,
      automation: {
        ...snapshot.automation,
        inputPresence: "unknown",
        inputMonitoringAvailable: false,
        manualPauseLocked: status === "manual-paused",
      },
    } satisfies TimerSnapshot);
    render(<App />);

    expect(await screen.findByText("输入检测不可用 · 手动控制")).toBeInTheDocument();
    expect(screen.getByText(statusLabel)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: actionLabel })).toBeEnabled();
    expect(screen.queryByText("已暂停 · 可手动继续")).not.toBeInTheDocument();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "等待离席 · 将自动开始"],
    ["desk", "等待无输入 · 将自动开始"],
  ] as const)("shows %s break automation with an optional manual start", async (breakMode, message) => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...waitingBreakSnapshot,
      round: { ...waitingBreakSnapshot.round, breakMode },
    } satisfies TimerSnapshot);
    window.pomodoro.command = vi.fn().mockResolvedValue({
      ...waitingBreakSnapshot,
      status: "running",
    } satisfies TimerSnapshot);
    render(<App />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    const manualStart = screen.getByRole("button", { name: "手动开始休息" });
    expect(manualStart).toBeEnabled();
    expect(screen.getByRole("button", { name: "跳到下一轮" })).toBeEnabled();
    expect(window.pomodoro.command).not.toHaveBeenCalled();

    fireEvent.click(manualStart);
    await waitFor(() => expect(window.pomodoro.command).toHaveBeenCalledWith("resume"));
    expect(await screen.findByRole("button", { name: "暂停计时" })).toBeEnabled();
  });

  it("shows the completed focus round's waiting break and follows its automatic Core start", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue(runningSnapshot);
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });

    act(() => eventListener?.({ type: "timer.snapshot", snapshot: waitingBreakSnapshot }));
    expect(screen.getByRole("heading", { name: "短休" })).toBeInTheDocument();
    expect(screen.getByText("等待离席 · 将自动开始")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "手动开始休息" })).toBeEnabled();

    act(() => eventListener?.({
      type: "timer.snapshot",
      snapshot: {
        ...waitingBreakSnapshot,
        revision: 3,
        status: "running",
        automation: { ...waitingBreakSnapshot.automation, inputPresence: "away", pauseReason: "none" },
      },
    }));
    expect(screen.getByRole("button", { name: "暂停计时" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "手动开始休息" })).not.toBeInTheDocument();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("keeps manually paused breaks locked until the user continues", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...waitingBreakSnapshot,
      status: "manual-paused",
      automation: { ...waitingBreakSnapshot.automation, manualPauseLocked: true },
    } satisfies TimerSnapshot);
    render(<App />);

    expect(await screen.findByText("手动暂停 · 点击继续")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续计时" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "手动开始休息" })).not.toBeInTheDocument();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
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

  it("uses the Core error path when the initial window mode cannot be read", async () => {
    window.pomodoro.getWindowMode = vi.fn().mockRejectedValue(new Error("window mode unavailable"));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "计时核心不可用" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始计时" })).not.toBeInTheDocument();
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

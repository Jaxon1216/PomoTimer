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
  StatisticsSnapshot,
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

const statistics: StatisticsSnapshot = {
  generatedAt: "2026-11-06T09:00:00.000Z",
  today: { localDate: "2026-11-06", completedFocusMinutes: 30, completedFocusRounds: 1 },
  week: [],
  heatmap: [
    { localDate: "2026-10-31", completedFocusMinutes: 0, completedFocusRounds: 0 },
    { localDate: "2026-11-01", completedFocusMinutes: 30, completedFocusRounds: 1 },
    { localDate: "2026-11-02", completedFocusMinutes: 60, completedFocusRounds: 2 },
    { localDate: "2026-11-03", completedFocusMinutes: 0, completedFocusRounds: 0 },
    { localDate: "2026-11-04", completedFocusMinutes: 0, completedFocusRounds: 0 },
    { localDate: "2026-11-05", completedFocusMinutes: 0, completedFocusRounds: 0 },
    { localDate: "2026-11-06", completedFocusMinutes: 30, completedFocusRounds: 1 },
  ],
};

async function openSettings(): Promise<void> {
  await screen.findByRole("heading", { name: "专注" });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "打开设置" }));
  await screen.findByRole("heading", { name: "设置" });
}

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

  it.each([
    ["专注时长", "", "请输入 5–120 之间的整数"],
    ["专注时长", "4", "请输入 5–120 之间的整数"],
    ["短休时长", "1.5", "请输入 1–60 之间的整数"],
    ["长休时长", "91", "请输入 1–90 之间的整数"],
    ["输入闲置阈值", "601", "请输入 10–600 之间的整数"],
  ])("validates %s locally for %s and keeps editable drafts", async (label, value, message) => {
    render(<App />);
    await openSettings();
    const input = screen.getByRole("spinbutton", { name: label });
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(value === "" ? null : Number(value));
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.getByText(message)).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(window.pomodoro.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "设置" })).toBeVisible();
  });

  it("keeps failed settings saves local and allows retry without losing the draft", async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error("写入失败"))
      .mockResolvedValue({ ...settings, focusDurationSeconds: 1_500 });
    window.pomodoro.updateSettings = update;
    render(<App />);
    await openSettings();
    fireEvent.change(screen.getByRole("spinbutton", { name: "专注时长" }), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByRole("spinbutton", { name: "专注时长" })).toHaveValue(25);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("已保存")).toBeVisible();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("disables duplicate saves while a settings write is pending", async () => {
    let finish: ((value: Settings) => void) | undefined;
    window.pomodoro.updateSettings = vi.fn(() => new Promise<Settings>((resolve) => { finish = resolve; }));
    render(<App />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await act(async () => finish?.(settings));
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
  });

  it.each(["command", "window mode"])("keeps the timer usable after a failed %s operation", async (operation) => {
    if (operation === "command") window.pomodoro.command = vi.fn().mockRejectedValue(new Error("操作失败"));
    else window.pomodoro.setWindowMode = vi.fn().mockRejectedValue(new Error("操作失败"));
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    fireEvent.click(screen.getByRole("button", { name: operation === "command" ? "开始计时" : "切换迷你模式" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败");
    expect(screen.getByRole("heading", { name: "专注" })).toBeVisible();
    expect(screen.getByRole("button", { name: "开始计时" })).toBeEnabled();
  });

  it("surfaces a persistent storage failure instead of leaving active timer controls", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue(runningSnapshot);
    render(<App />);
    await screen.findByRole("button", { name: "暂停计时" });
    act(() => eventListener?.({ type: "core.error", code: "STORAGE_UNAVAILABLE", message: "本地数据写入失败", recoverable: false }));
    expect(screen.getByRole("alert")).toHaveTextContent("本地数据写入失败");
    expect(screen.getByRole("heading", { name: "本地存储不可用" })).toBeVisible();
    expect(screen.getByText("计时已安全暂停，请重新打开应用后重试。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "暂停计时" })).not.toBeInTheDocument();
  });

  it("shows recoverable Core errors without removing timer controls", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    act(() => eventListener?.({ type: "core.error", code: "TEMPORARY", message: "请重试", recoverable: true }));
    expect(screen.getByRole("alert")).toHaveTextContent("请重试");
    expect(screen.getByRole("button", { name: "开始计时" })).toBeEnabled();
  });

  it("retries statistics loading failures and refreshes on focus and reentry", async () => {
    const getStatistics = vi.fn().mockRejectedValueOnce(new Error("统计读取失败")).mockResolvedValue(statistics);
    window.pomodoro.getStatistics = getStatistics;
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "打开统计" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("统计读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载统计" }));
    await screen.findByText("今日专注");
    expect(getStatistics).toHaveBeenCalledTimes(2);
    fireEvent.focus(window);
    await waitFor(() => expect(getStatistics).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "返回计时器" }));
    expect(screen.getByRole("button", { name: "开始计时" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "打开统计" }));
    await waitFor(() => expect(getStatistics).toHaveBeenCalledTimes(4));
  });

  it("opens the heatmap at its latest week and exposes daily values through keyboard navigation", async () => {
    window.pomodoro.getStatistics = vi.fn().mockResolvedValue(statistics);
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "打开统计" }));
      const latest = await screen.findByRole("button", { name: "2026-11-06，专注 30 分钟" });
      const frame = screen.getByRole("region", { name: "最近 52 周专注热力图" });
      await waitFor(() => expect(frame.scrollLeft).toBe(600));
      expect(latest).toHaveAttribute("tabindex", "0");
      fireEvent.focus(latest);
      fireEvent.keyDown(latest, { key: "ArrowUp" });
      expect(screen.getByRole("button", { name: "2026-11-05，专注 0 分钟" })).toHaveFocus();
      expect(screen.getByText("2026-11-05 · 0 分钟")).toBeVisible();
      expect(screen.getByText("10月")).toBeVisible();
      expect(screen.getByText("11月")).toBeVisible();
      expect(screen.getByText(/颜色越深，完成专注分钟越多/)).toBeVisible();
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("announces selected appearance and break mode choices", async () => {
    render(<App />);
    await openSettings();
    expect(screen.getByRole("button", { name: "跟随系统" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "跟随系统" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "桌前休息" }));
    expect(screen.getByRole("button", { name: "桌前休息" })).toHaveAttribute("aria-pressed", "true");
  });

  it("positions the first heatmap record at the latest week when statistics arrive live", async () => {
    window.pomodoro.getStatistics = vi.fn().mockResolvedValue({
      ...statistics,
      heatmap: statistics.heatmap.map((day) => ({ ...day, completedFocusMinutes: 0, completedFocusRounds: 0 })),
    });
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "打开统计" }));
      await screen.findByText("还没有完成记录");
      act(() => eventListener?.({ type: "stats.changed", statistics }));
      expect(screen.getByRole("region", { name: "最近 52 周专注热力图" }).scrollLeft).toBe(600);
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("keeps the latest day keyboard reachable after the selected date leaves the rolling heatmap", async () => {
    window.pomodoro.getStatistics = vi.fn().mockResolvedValue(statistics);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "打开统计" }));
    const oldest = await screen.findByRole("button", { name: "2026-10-31，专注 0 分钟" });
    act(() => oldest.focus());
    expect(oldest).toHaveAttribute("tabindex", "0");
    const newDay = { localDate: "2026-11-07", completedFocusMinutes: 0, completedFocusRounds: 0 };
    act(() => eventListener?.({ type: "stats.changed", statistics: {
      ...statistics, today: newDay, heatmap: [...statistics.heatmap.slice(1), newDay],
    } }));
    expect(screen.queryByRole("button", { name: "2026-10-31，专注 0 分钟" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2026-11-07，专注 0 分钟" })).toHaveAttribute("tabindex", "0");
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

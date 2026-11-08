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
import { startCameraPresence } from "./camera-presence";
vi.mock("./camera-presence", () => ({ startCameraPresence: vi.fn(() => vi.fn()) }));
import type {
  Capabilities,
  CoreEvent,
  Settings,
  StatisticsSnapshot,
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
      getCameraState: vi.fn().mockResolvedValue({ enabled: false, generation: 0 }),
      reportCameraPresence: vi.fn().mockResolvedValue(snapshot),
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
    const start = screen.getByRole("button", { name: "开始计时" });
    expect(start).toBeEnabled();
    expect(start).toHaveAttribute("title", "开始计时");
    expect(start.textContent).toBe("");
    expect(screen.getByRole("button", { name: "打开统计" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "跳到下一轮" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "重新开始当前轮次" })).toBeEnabled();
  });

  it("keeps camera off by default and switches modes only after an explicit choice", async () => {
    const start = vi.mocked(startCameraPresence);
    start.mockClear();
    vi.mocked(window.pomodoro.updateSettings).mockResolvedValue({ ...settings, focusPresenceSource: "camera" });
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "感知模式：触控，切换为监控" }));
    await waitFor(() => expect(window.pomodoro.updateSettings).toHaveBeenCalledWith({ focusPresenceSource: "camera" }));
    await act(async () => eventListener?.({ type: "camera.state", state: { enabled: true, generation: 2 } }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "感知模式：监控，切换为触控" })).toBeEnabled();
    const [report] = start.mock.calls[0]!;
    await act(async () => { await report("present"); });
    expect(window.pomodoro.reportCameraPresence).toHaveBeenCalledWith("present", 2);
    const stop = start.mock.results[0]!.value;
    await act(async () => {
      eventListener?.({ type: "settings.changed", settings });
      eventListener?.({ type: "camera.state", state: { enabled: false, generation: 3 } });
    });
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => { await report("away"); });
    expect(window.pomodoro.reportCameraPresence).toHaveBeenCalledTimes(1);
  });

  it("puts the sensing icon before statistics and more, including during a break", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue(waitingBreakSnapshot);
    render(<App />);
    await screen.findByRole("heading", { name: "短休" });
    const mode = screen.getByRole("button", { name: "感知模式：触控，切换为监控" });
    const header = screen.getByRole("banner");
    expect(Array.from(header.querySelectorAll("button"))).toEqual([
      mode, screen.getByRole("button", { name: "打开统计" }), screen.getByRole("button", { name: "更多操作" }),
    ]);
    expect(mode.textContent).toBe("");
    expect(mode).toHaveAttribute("title", expect.stringContaining("当前：触控感知"));
    expect(mode).toHaveAttribute("title", expect.stringContaining("系统输入"));
    expect(document.querySelector(".roundMeta button")).not.toBeInTheDocument();
    vi.mocked(window.pomodoro.updateSettings).mockResolvedValue({ ...settings, focusPresenceSource: "camera" });
    fireEvent.click(mode);
    await waitFor(() => expect(window.pomodoro.updateSettings).toHaveBeenCalledWith({ focusPresenceSource: "camera" }));
    expect(screen.getByRole("button", { name: "感知模式：监控，切换为触控" })).toHaveAttribute("title", expect.stringContaining("摄像头"));
  });

  it("uses Space to start, pause, and continue only once per press", async () => {
    const paused: TimerSnapshot = {
      ...runningSnapshot, status: "manual-paused",
      automation: { ...runningSnapshot.automation, manualPauseLocked: true },
    };
    vi.mocked(window.pomodoro.command).mockResolvedValueOnce(runningSnapshot).mockResolvedValueOnce(paused).mockResolvedValueOnce(runningSnapshot);
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " " })).toBe(false);
    await screen.findByRole("button", { name: "暂停计时" });
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "暂停计时" }), { code: "Space", key: " " })).toBe(false);
    await screen.findByRole("button", { name: "继续计时" });
    fireEvent.keyDown(document.body, { code: "Space", key: " " });
    await screen.findByRole("button", { name: "暂停计时" });
    expect(vi.mocked(window.pomodoro.command).mock.calls).toEqual([["start"], ["pause"], ["resume"]]);
  });

  it.each([
    { repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 },
  ])("ignores Space with repeat, modifiers, or composition: %j", async (options) => {
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " ", ...options })).toBe(true);
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("leaves Space to interactive controls and an open menu", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    for (const button of [screen.getByRole("button", { name: "打开统计" }), screen.getByRole("button", { name: "更多操作" }), screen.getByRole("button", { name: "跳到下一轮" })]) {
      expect(fireEvent.keyDown(button, { code: "Space", key: " " })).toBe(true);
    }
    const host = document.createElement("div");
    host.innerHTML = '<input /><select><option>Choice</option></select><textarea></textarea><div contenteditable="true"><span>edit</span></div><a href="#">link</a><div role="slider" tabindex="0"></div>';
    document.body.append(host);
    for (const target of host.querySelectorAll("input, select, textarea, [contenteditable] span, a, [role=slider]")) {
      expect(fireEvent.keyDown(target, { code: "Space", key: " " })).toBe(true);
    }
    host.remove();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(fireEvent.keyDown(screen.getByRole("menuitem", { name: "重新开始当前轮次" }), { code: "Space", key: " " })).toBe(true);
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " " })).toBe(true);
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("does not intercept Space in settings or statistics", async () => {
    render(<App />);
    await openSettings();
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " " })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("spinbutton", { name: "专注时长" }), { code: "Space", key: " " })).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "返回计时器" }));
    fireEvent.click(screen.getByRole("button", { name: "打开统计" }));
    await screen.findByRole("heading", { name: "统计" });
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " " })).toBe(true);
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("shows the full input preparation threshold until the final ten seconds, then follows Core without losing break time", async () => {
    const prepare = (remainingSeconds: number, countdown: boolean) => ({
      ...waitingBreakSnapshot,
      automation: { ...waitingBreakSnapshot.automation, breakPreparation: { remainingSeconds, countdown } },
    });
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue(prepare(40, false));
    render(<App />);
    expect(await screen.findByText("无输入 40 秒开始休息")).toBeInTheDocument();
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: prepare(11, false) }));
    expect(screen.getByText("无输入 40 秒开始休息")).toBeInTheDocument();
    for (const seconds of [10, 9, 1]) {
      act(() => eventListener?.({ type: "timer.snapshot", snapshot: prepare(seconds, true) }));
      expect(screen.getByText(`${seconds} 秒后开始休息`)).toBeInTheDocument();
    }
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: prepare(40, false) }));
    expect(screen.getByText("无输入 40 秒开始休息")).toBeInTheDocument();
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: {
      ...waitingBreakSnapshot, status: "running",
      automation: { ...waitingBreakSnapshot.automation, inputPresence: "away", pauseReason: "none" },
    } }));
    expect(screen.getByText("05:00")).toBeInTheDocument();
    expect(screen.getByText("休息中")).toBeInTheDocument();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("uses camera presence rather than the input threshold for an active camera break", async () => {
    window.pomodoro.getSettings = vi.fn().mockResolvedValue({ ...settings, focusPresenceSource: "camera" });
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({ ...waitingBreakSnapshot, automation: {
      ...waitingBreakSnapshot.automation, activePresenceSource: "camera", cameraPresence: "present", cameraMonitoringAvailable: true,
    } });
    render(<App />);
    expect(await screen.findByText("等待离席 · 将自动开始")).toBeInTheDocument();
    expect(screen.queryByText("无输入 40 秒开始休息")).not.toBeInTheDocument();
  });

  it("explains manual input startup and automatic camera startup while preserving its pause lock", async () => {
    render(<App />);
    expect(await screen.findByText("准备开始")).toBeInTheDocument();
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: { ...snapshot, automation: {
      ...snapshot.automation, activePresenceSource: "camera", cameraPresence: "unknown",
    } } }));
    expect(screen.getByText("等待摄像头检测 · 将自动开始")).toBeInTheDocument();
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: { ...snapshot, status: "manual-paused", automation: {
      ...snapshot.automation, activePresenceSource: "camera", cameraPresence: "present", manualPauseLocked: true,
    } } }));
    expect(screen.getByText("手动暂停 · 点击继续")).toBeInTheDocument();
  });

  it("sizes and describes every stage using its planned duration and the current Core round", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    const sequence = screen.getByRole("img", { name: /第 1 \/ 6 阶段/ });
    const stages = Array.from(sequence.querySelectorAll("span"));
    expect(stages.map((stage) => stage.style.flexGrow)).toEqual(["1800", "300", "1800", "300", "1800", "600"]);
    expect(stages.map((stage) => stage.title)).toEqual([
      "第 1 阶段 · 专注 · 30 分钟", "第 2 阶段 · 短休 · 5 分钟", "第 3 阶段 · 专注 · 30 分钟",
      "第 4 阶段 · 短休 · 5 分钟", "第 5 阶段 · 专注 · 30 分钟", "第 6 阶段 · 长休 · 10 分钟",
    ]);
    expect(sequence).toHaveAttribute("aria-label", expect.stringContaining("专注 30 分钟 → 短休 5 分钟"));
    expect(screen.getByText("第 1/3 轮专注")).toBeInTheDocument();
    act(() => eventListener?.({ type: "settings.changed", settings: { ...settings, focusDurationSeconds: 1_500, focusRoundsPerCycle: 2 } }));
    expect(Array.from(sequence.querySelectorAll("span")).map((stage) => stage.style.flexGrow)).toEqual(["1800", "300", "1500", "600"]);
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: {
      ...waitingBreakSnapshot, activeCycleRounds: 2,
      round: { ...waitingBreakSnapshot.round, positionInCycle: 2, totalDurationMs: 240_000 }, remainingMs: 240_000,
    } }));
    expect(screen.getByText("第 1 轮后的短休")).toBeInTheDocument();
    expect(Array.from(screen.getByRole("img", { name: /第 2 \/ 4 阶段/ }).querySelectorAll("span")).map((stage) => stage.style.flexGrow)).toEqual(["1500", "240", "1500", "600"]);
    act(() => eventListener?.({ type: "timer.snapshot", snapshot: {
      ...waitingBreakSnapshot, activeCycleRounds: 2,
      round: { ...waitingBreakSnapshot.round, kind: "long-break", positionInCycle: 4, totalDurationMs: 600_000 }, remainingMs: 600_000,
    } }));
    expect(screen.getByText("第 2 轮后的长休")).toBeInTheDocument();
    expect(screen.queryByText(/本周期/)).not.toBeInTheDocument();
  });

  it("reports camera failure to Main and reflects the visible input fallback", async () => {
    const start = vi.mocked(startCameraPresence);
    start.mockClear();
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    await act(async () => eventListener?.({ type: "camera.state", state: { enabled: true, generation: 4 } }));
    await act(async () => { start.mock.calls[0]![1]("摄像头权限未开启"); });
    expect(window.pomodoro.reportCameraPresence).toHaveBeenCalledWith("unknown", 4);
    await act(async () => {
      eventListener?.({ type: "settings.changed", settings });
      eventListener?.({ type: "camera.state", state: { enabled: false, generation: 5 } });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("摄像头权限未开启");
    expect(screen.getByRole("button", { name: "感知模式：触控，切换为监控" })).toBeEnabled();
  });

  it("preserves unsaved settings when the immediate sensing mode changes", async () => {
    render(<App />);
    await openSettings();
    fireEvent.change(screen.getByRole("spinbutton", { name: "专注时长" }), { target: { value: "25" } });
    await act(async () => eventListener?.({ type: "settings.changed", settings: { ...settings, focusPresenceSource: "camera" } }));
    expect(screen.getByRole("spinbutton", { name: "专注时长" })).toHaveValue(25);
    expect(screen.getByRole("button", { name: "监控" })).toHaveAttribute("aria-pressed", "true");
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

  it("keeps timer state and actions across viewport resizes", async () => {
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
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByTitle("手动暂停 · 点击继续")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开统计" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "更多操作" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "继续计时" })).toHaveAttribute("title", "继续计时");

    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 478);
    fireEvent.resize(window);
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续计时" })).toBeEnabled();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
    expect(window.pomodoro.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps all menu actions reachable with the keyboard", async () => {
    render(<App />);
    const more = await screen.findByRole("button", { name: "更多操作" });
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const stats = screen.getByRole("menuitem", { name: "打开统计" });
    const openSettingsItem = screen.getByRole("menuitem", { name: "打开设置" });
    const restart = screen.getByRole("menuitem", { name: "重新开始当前轮次" });
    const switchMode = screen.getByRole("menuitem", { name: "切换为监控感知" });
    expect(screen.getAllByRole("menuitem")).toEqual([stats, openSettingsItem, switchMode, restart]);
    expect(stats).toHaveFocus();
    fireEvent.keyDown(stats, { key: "ArrowDown" });
    expect(openSettingsItem).toHaveFocus();
    fireEvent.keyDown(openSettingsItem, { key: "End" });
    expect(restart).toHaveFocus();
    fireEvent.keyDown(restart, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it("keeps the complete unavailable-monitoring reason visible", async () => {
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
    expect(screen.getByRole("button", { name: "继续计时" })).toBeEnabled();
    expect(window.pomodoro.command).not.toHaveBeenCalled();
  });

  it.each([
    ["idle", "准备开始", "开始计时"],
    ["manual-paused", "手动暂停 · 点击继续", "继续计时"],
  ] as const)("keeps unavailable input monitoring visible without overriding %s state", async (status, statusLabel, actionLabel) => {
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
    ["active", "无输入 40 秒开始休息"],
    ["desk", "无输入 40 秒开始休息"],
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
    expect(screen.getByText("无输入 40 秒开始休息")).toBeInTheDocument();
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

  it("offers continue when input interrupts a break already in progress", async () => {
    const paused = { ...waitingBreakSnapshot, remainingMs: 210_000 };
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue(paused);
    window.pomodoro.command = vi.fn().mockResolvedValue({ ...paused, status: "running" });
    render(<App />);

    expect(await screen.findByText("无输入 40 秒继续休息")).toBeInTheDocument();
    const resume = screen.getByRole("button", { name: "继续计时" });
    expect(resume).toHaveAttribute("title", "继续计时");
    fireEvent.click(resume);
    expect(window.pomodoro.command).toHaveBeenCalledWith("resume");
    expect(await screen.findByRole("button", { name: "暂停计时" })).toHaveAttribute("title", "暂停计时");
  });

  it("attributes automatic focus pauses to the observed input signal", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...snapshot,
      status: "auto-paused",
      automation: { ...snapshot.automation, inputPresence: "away", pauseReason: "input-away" },
    } satisfies TimerSnapshot);
    render(<App />);
    expect(await screen.findByText("无输入 · 自动暂停")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续计时" })).toHaveAttribute("title", "继续计时");
  });

  it("explains that paused breaks will continue automatically when their condition is met", async () => {
    window.pomodoro.getSnapshot = vi.fn().mockResolvedValue({
      ...waitingBreakSnapshot,
      remainingMs: 210_000,
      automation: { ...waitingBreakSnapshot.automation, manualPauseLocked: false },
    } satisfies TimerSnapshot);
    render(<App />);

    expect(await screen.findByText("无输入 40 秒继续休息")).toBeInTheDocument();
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

  it("keeps the timer usable after a failed command", async () => {
    window.pomodoro.command = vi.fn().mockRejectedValue(new Error("操作失败"));
    render(<App />);
    await screen.findByRole("heading", { name: "专注" });
    fireEvent.click(screen.getByRole("button", { name: "开始计时" }));
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

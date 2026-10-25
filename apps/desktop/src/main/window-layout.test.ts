import { describe, expect, it, vi } from "vitest";
import { coreEventSchema } from "../shared/contracts.js";
import { defaultSettings, TimerEngine, type TimerStore } from "./timer.js";
import { WindowLayoutController, type WindowRectangle } from "./window-layout.js";

class FakeWindow {
  bounds: WindowRectangle;
  readonly setMinimumSize = vi.fn<(width: number, height: number) => void>();
  readonly setBounds = vi.fn<(bounds: WindowRectangle, animate?: boolean) => void>((bounds) => {
    this.bounds = { ...bounds };
  });

  constructor(
    contentWidth = 360,
    contentHeight = 478,
    private readonly frame = { width: 0, height: 0 },
  ) {
    this.bounds = { x: 100, y: 100, width: contentWidth + frame.width, height: contentHeight + frame.height };
  }

  getBounds(): WindowRectangle {
    return { ...this.bounds };
  }

  getContentBounds(): WindowRectangle {
    return { ...this.bounds, width: this.bounds.width - this.frame.width, height: this.bounds.height - this.frame.height };
  }
}

const desktop = { x: 0, y: 0, width: 1920, height: 1080 };

describe("WindowLayoutController", () => {
  it("starts with 360×478 content and allows a 160×180 minimum without a native frame", () => {
    const window = new FakeWindow();
    const layout = new WindowLayoutController(() => desktop);

    layout.initialize(window);

    expect(window.setMinimumSize).toHaveBeenLastCalledWith(160, 180);
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 360, height: 478 }, false);
  });

  it("adds Windows native frame dimensions to the minimum while preserving default content size", () => {
    const window = new FakeWindow(360, 478, { width: 16, height: 39 });
    const layout = new WindowLayoutController(() => desktop);

    layout.initialize(window);

    expect(window.setMinimumSize).toHaveBeenLastCalledWith(176, 219);
    expect(window.getContentBounds()).toMatchObject({ width: 360, height: 478 });
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 376, height: 517 }, false);
  });

  it("restores a freely resized window and its native position after closing and recreating it", () => {
    const original = new FakeWindow();
    const layout = new WindowLayoutController(() => desktop);
    layout.initialize(original);
    original.bounds = { x: 700, y: 500, width: 360, height: 180 };
    layout.remember(original);

    const reopened = new FakeWindow();
    layout.initialize(reopened);

    expect(reopened.bounds).toEqual(original.bounds);
    expect(reopened.setMinimumSize).toHaveBeenLastCalledWith(160, 180);
  });

  it("restores remembered content size using the recreated window's current frame", () => {
    const original = new FakeWindow(360, 478, { width: 16, height: 39 });
    const layout = new WindowLayoutController(() => desktop);
    layout.initialize(original);
    original.bounds = { x: 600, y: 300, width: 236, height: 279 };
    layout.remember(original);

    const reopened = new FakeWindow(360, 478, { width: 20, height: 42 });
    layout.initialize(reopened);

    expect(reopened.bounds).toEqual({ x: 600, y: 300, width: 240, height: 282 });
    expect(reopened.getContentBounds()).toMatchObject({ width: 220, height: 240 });
    expect(reopened.setMinimumSize).toHaveBeenLastCalledWith(180, 222);
  });

  it("clamps a restored window inside a changed display work area without animation", () => {
    const original = new FakeWindow();
    let workArea = desktop;
    const layout = new WindowLayoutController(() => workArea);
    layout.initialize(original);
    original.bounds = { x: 1500, y: 580, width: 420, height: 500 };
    layout.remember(original);
    workArea = { x: 0, y: 24, width: 1440, height: 876 };

    const reopened = new FakeWindow();
    layout.initialize(reopened);

    expect(reopened.setBounds).toHaveBeenLastCalledWith({ x: 1020, y: 400, width: 420, height: 500 }, false);
  });

  it("fits a large remembered window into a smaller display at negative screen coordinates", () => {
    const original = new FakeWindow();
    let workArea = desktop;
    const layout = new WindowLayoutController(() => workArea);
    layout.initialize(original);
    original.bounds = { x: 200, y: 100, width: 1600, height: 900 };
    layout.remember(original);
    workArea = { x: -1280, y: 40, width: 1280, height: 760 };

    const reopened = new FakeWindow();
    layout.initialize(reopened);

    expect(reopened.bounds).toEqual({ x: -1280, y: 40, width: 1280, height: 760 });
    expect(reopened.setMinimumSize).toHaveBeenLastCalledWith(160, 180);
  });

  it("enforces the native minimum when remembered content is below 160×180", () => {
    const original = new FakeWindow();
    const layout = new WindowLayoutController(() => desktop);
    layout.initialize(original);
    original.bounds = { x: 300, y: 200, width: 120, height: 140 };
    layout.remember(original);

    const reopened = new FakeWindow(360, 478, { width: 16, height: 39 });
    layout.initialize(reopened);

    expect(reopened.bounds).toEqual({ x: 300, y: 200, width: 176, height: 219 });
  });

  it("remembers native drag sizing without writing back bounds or minimums", () => {
    const window = new FakeWindow();
    const layout = new WindowLayoutController(() => desktop);
    layout.initialize(window);
    window.setBounds.mockClear();
    window.setMinimumSize.mockClear();
    window.bounds = { x: 300, y: 200, width: 160, height: 478 };

    layout.remember(window);

    expect(window.bounds).toEqual({ x: 300, y: 200, width: 160, height: 478 });
    expect(window.setBounds).not.toHaveBeenCalled();
    expect(window.setMinimumSize).not.toHaveBeenCalled();
  });

  it("preserves a manual-pause snapshot and persistence while resizing and recreating the window", () => {
    const store: TimerStore = {
      loadSnapshot: () => undefined,
      saveSnapshot: vi.fn(),
      commitCompletedSessionAndSnapshot: vi.fn(),
      loadSettings: () => defaultSettings,
    };
    const clock = { now: () => 0, wallDate: () => new Date("2026-10-20T09:00:00.000Z") };
    const engine = new TimerEngine(store, clock);
    engine.command("start");
    const before = structuredClone(engine.command("pause"));
    const command = vi.spyOn(engine, "command");
    vi.mocked(store.saveSnapshot).mockClear();
    const window = new FakeWindow();
    const layout = new WindowLayoutController(() => desktop);

    layout.initialize(window);
    for (const [width, height] of [[160, 180], [160, 478], [360, 180], [720, 480]] as const) {
      window.bounds = { x: 100, y: 100, width, height };
      layout.remember(window);
    }
    layout.initialize(new FakeWindow());

    expect(engine.snapshot).toEqual(before);
    expect(engine.snapshot.automation.manualPauseLocked).toBe(true);
    expect(command).not.toHaveBeenCalled();
    expect(store.saveSnapshot).not.toHaveBeenCalled();
    expect(store.commitCompletedSessionAndSnapshot).not.toHaveBeenCalled();
  });
});

describe("window layout IPC boundary", () => {
  it("rejects the removed window-mode event instead of exposing a layout channel", () => {
    expect(coreEventSchema.safeParse({ type: "window.modeChanged", mode: "mini" }).success).toBe(false);
    expect(coreEventSchema.safeParse({ type: "window.resized", width: 160, height: 180 }).success).toBe(false);
  });
});

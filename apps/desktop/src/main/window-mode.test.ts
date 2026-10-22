import { describe, expect, it, vi } from "vitest";
import { coreEventSchema, windowModeSchema } from "../shared/contracts.js";
import { defaultSettings, TimerEngine, type TimerStore } from "./timer.js";
import { WindowModeController, type WindowRectangle } from "./window-mode.js";

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

describe("WindowModeController", () => {
  it("initializes regular mode with content-based minimums on a native Windows frame", () => {
    const window = new FakeWindow(360, 478, { width: 16, height: 39 });
    const modes = new WindowModeController(() => desktop);

    modes.initialize(window);

    expect(modes.mode).toBe("regular");
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(336, 339);
    expect(window.getContentBounds()).toMatchObject({ width: 360, height: 478 });
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 376, height: 517 }, false);

    modes.setMode(window, "mini");
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(236, 279);
    expect(window.getContentBounds()).toMatchObject({ width: 220, height: 240 });
  });

  it("remembers separate native positions and content sizes for both modes", () => {
    const window = new FakeWindow();
    const modes = new WindowModeController(() => desktop);
    modes.initialize(window);
    window.bounds = { x: 200, y: 150, width: 480, height: 560 };

    expect(modes.setMode(window, "mini")).toBe("mini");
    expect(window.bounds).toEqual({ x: 200, y: 150, width: 220, height: 240 });
    window.bounds = { x: 1300, y: 600, width: 240, height: 270 };

    expect(modes.setMode(window, "regular")).toBe("regular");
    expect(window.bounds).toEqual({ x: 200, y: 150, width: 480, height: 560 });
    modes.setMode(window, "mini");
    expect(window.bounds).toEqual({ x: 1300, y: 600, width: 240, height: 270 });
  });

  it("clamps a restored regular window above the screen's lower edge without animation", () => {
    const window = new FakeWindow();
    let workArea = desktop;
    const modes = new WindowModeController(() => workArea);
    modes.initialize(window);
    window.bounds = { x: 1500, y: 580, width: 420, height: 500 };
    modes.setMode(window, "mini");
    workArea = { x: 0, y: 24, width: 1440, height: 876 };

    modes.setMode(window, "regular");

    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 1020, y: 400, width: 420, height: 500 }, false);
  });

  it("fits a remembered large window into a smaller work area while retaining the minimum", () => {
    const window = new FakeWindow();
    let workArea = desktop;
    const modes = new WindowModeController(() => workArea);
    modes.initialize(window);
    window.bounds = { x: 200, y: 100, width: 1600, height: 900 };
    modes.setMode(window, "mini");
    workArea = { x: -1280, y: 40, width: 1280, height: 760 };

    modes.setMode(window, "regular");

    expect(window.bounds).toEqual({ x: -1280, y: 40, width: 1280, height: 760 });
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(320, 300);
  });

  it("keeps native resizing independent from mode selection and avoids repeated bounds writes", () => {
    const window = new FakeWindow();
    const modes = new WindowModeController(() => desktop);
    modes.initialize(window);
    window.setBounds.mockClear();
    window.setMinimumSize.mockClear();
    window.bounds = { x: 100, y: 100, width: 320, height: 300 };

    expect(modes.mode).toBe("regular");
    expect(modes.setMode(window, "regular")).toBe("regular");
    expect(window.setBounds).not.toHaveBeenCalled();
    expect(window.setMinimumSize).not.toHaveBeenCalled();

    modes.setMode(window, "mini");
    window.bounds = { x: 100, y: 100, width: 640, height: 480 };
    expect(modes.mode).toBe("mini");
  });

  it("restores the current mode after recreating a closed window within the same session", () => {
    const original = new FakeWindow();
    const modes = new WindowModeController(() => desktop);
    modes.initialize(original);
    modes.setMode(original, "mini");
    original.bounds = { x: 700, y: 500, width: 260, height: 280 };
    modes.remember(original);

    const reopened = new FakeWindow();
    modes.initialize(reopened);

    expect(modes.mode).toBe("mini");
    expect(reopened.bounds).toEqual(original.bounds);
    expect(reopened.setMinimumSize).toHaveBeenLastCalledWith(220, 240);
  });

  it("does not command or persist TimerEngine when switching modes or resizing", () => {
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
    const modes = new WindowModeController(() => desktop);

    modes.initialize(window);
    modes.setMode(window, "mini");
    window.bounds = { x: 100, y: 100, width: 280, height: 300 };
    modes.setMode(window, "regular");

    expect(engine.snapshot).toEqual(before);
    expect(command).not.toHaveBeenCalled();
    expect(store.saveSnapshot).not.toHaveBeenCalled();
  });
});

describe("window-mode IPC schemas", () => {
  it("accepts only explicit window-mode enum values and strict event payloads", () => {
    expect(windowModeSchema.parse("regular")).toBe("regular");
    expect(windowModeSchema.parse("mini")).toBe("mini");
    expect(windowModeSchema.safeParse({ mode: "mini" }).success).toBe(false);
    expect(windowModeSchema.safeParse("compact").success).toBe(false);
    expect(coreEventSchema.safeParse({ type: "window.modeChanged", mode: "mini" }).success).toBe(true);
    expect(coreEventSchema.safeParse({ type: "window.modeChanged", mode: "mini", width: 220 }).success).toBe(false);
  });
});

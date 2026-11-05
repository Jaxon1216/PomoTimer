import { describe, expect, it, vi } from "vitest";
import { WindowLayout, type WindowRectangle } from "./window-layout.js";

const desktop = { x: 0, y: 0, width: 1920, height: 1080 };
const noFrame = { width: 0, height: 0 };
const windowsFrame = { width: 16, height: 39 };

class FakeWindow {
  bounds: WindowRectangle;
  normal = true;
  normalBounds?: WindowRectangle;
  readonly setMinimumSize = vi.fn<(width: number, height: number) => void>();
  readonly setBounds = vi.fn<(bounds: WindowRectangle, animate?: boolean) => void>((bounds) => {
    this.bounds = { ...bounds };
  });

  constructor(private readonly frame = noFrame) {
    this.bounds = { x: 100, y: 100, width: 360 + frame.width, height: 478 + frame.height };
  }

  getBounds(): WindowRectangle { return { ...this.bounds }; }
  getContentBounds(): WindowRectangle {
    return { ...this.bounds, width: this.bounds.width - this.frame.width, height: this.bounds.height - this.frame.height };
  }
  getNormalBounds(): WindowRectangle { return this.normalBounds ?? this.getBounds(); }
  isNormal(): boolean { return this.normal; }
}

describe("WindowLayout", () => {
  it("opens at 360×478 and sets a 160×180 content minimum including the Windows frame", () => {
    const window = new FakeWindow(windowsFrame);
    const layout = new WindowLayout("win32", () => desktop);
    layout.initialize(window);

    expect(window.setMinimumSize).toHaveBeenCalledWith(176, 219);
    expect(window.getContentBounds()).toMatchObject({ width: 360, height: 478 });
    expect(window.setBounds).not.toHaveBeenCalled();
  });

  it.each([
    [263, 180, 263, 180],
    [360, 478, 360, 478],
    [160, 180, 160, 180],
    [100, 100, 160, 180],
    [263, 900, 263, 394],
    [160, 900, 160, 240],
  ])("constrains programmatic content resize %i×%i to %i×%i", (width, height, expectedWidth, expectedHeight) => {
    const window = new FakeWindow(windowsFrame);
    const layout = new WindowLayout("win32", () => desktop);
    layout.initialize(window);
    window.bounds = { x: 90, y: 120, width: width + 16, height: height + 39 };
    window.setBounds.mockImplementation((bounds) => {
      window.bounds = bounds;
      layout.didResize(window);
    });

    layout.didResize(window);
    layout.didResize(window);
    expect(window.getContentBounds()).toEqual({ x: 90, y: 120, width: expectedWidth, height: expectedHeight });
    expect(window.setBounds).toHaveBeenCalledTimes(width === expectedWidth && height === expectedHeight ? 0 : 1);
  });

  it.each(["left", "right", "top", "bottom", "top-left", "bottom-left", "top-right", "bottom-right"])(
    "clamps the Windows %s grip on the first proposal and anchors the opposite edge",
    (edge) => {
      const window = new FakeWindow(windowsFrame);
      const layout = new WindowLayout("win32", () => desktop);
      layout.initialize(window);
      const old = window.getBounds();
      const width = edge === "top" || edge === "bottom" ? old.width : 216;
      const height = edge === "left" || edge === "right" ? old.height : 739;
      const proposed = {
        x: edge.includes("left") ? old.x + old.width - width : old.x,
        y: edge.includes("top") ? old.y + old.height - height : old.y,
        width, height,
      };
      const preventDefault = vi.fn();
      layout.willResize(window, proposed, edge, { preventDefault });
      const expectedHeight = Math.floor((width - 16) * 1.5) + 39;
      expect(window.getBounds()).toEqual({
        x: proposed.x,
        y: edge.includes("top") ? old.y + old.height - expectedHeight : old.y,
        width, height: expectedHeight,
      });
      layout.willResize(window, proposed, edge, { preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(2);
      expect(window.setBounds).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "left", "right"])(
    "uses actual macOS origins for the %s grip when AppKit reports only the dominant axis",
    (grip) => {
      const window = new FakeWindow();
      const layout = new WindowLayout("darwin", () => desktop);
      layout.initialize(window);
      const old = window.getBounds();
      const width = grip === "top" || grip === "bottom" ? old.width : 200;
      const height = grip === "left" || grip === "right" ? old.height : 700;
      // Electron 33 keeps the old Cocoa origin in the proposal, regardless of the real grip.
      const axis = old.width - width > height - old.height ? "right" : "bottom";
      const proposed = { x: old.x, y: old.y + old.height - height, width, height };
      const event = { preventDefault: vi.fn() };
      layout.willResize(window, proposed, axis, event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      window.bounds = {
        x: grip.includes("left") ? old.x + old.width - width : old.x,
        y: grip.includes("top") ? old.y + old.height - height : old.y,
        width, height,
      };
      layout.didResize(window);

      const expectedHeight = Math.floor(width * 1.5);
      expect(window.getBounds()).toEqual({
        x: grip.includes("left") ? old.x + old.width - width : old.x,
        y: grip.includes("top") ? old.y + old.height - expectedHeight : old.y,
        width, height: expectedHeight,
      });
      expect(window.setBounds).toHaveBeenCalledTimes(1);
    },
  );

  it("holds a macOS vertical drag at the boundary and lets a narrower width keep reducing height", () => {
    const window = new FakeWindow();
    const layout = new WindowLayout("darwin", () => desktop);
    layout.initialize(window);
    window.bounds = { x: 100, y: 100, width: 200, height: 300 };
    const event = { preventDefault: vi.fn() };
    layout.willResize(window, { ...window.bounds, y: 90, height: 310 }, "bottom", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.setBounds).not.toHaveBeenCalled();

    for (const width of [190, 180, 170, 160]) {
      const proposed = { ...window.bounds, width };
      layout.willResize(window, proposed, "right", event);
      window.bounds = proposed;
      layout.didResize(window);
      expect(window.bounds).toEqual({ x: 100, y: 100, width, height: width * 1.5 });
    }
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(window.setBounds).toHaveBeenCalledTimes(4);
  });

  it("restores session content dimensions and clamps the single placement to a smaller work area", () => {
    let area = desktop;
    const layout = new WindowLayout("win32", () => area);
    const original = new FakeWindow(windowsFrame);
    layout.initialize(original);
    original.bounds = { x: 1500, y: 580, width: 436, height: 539 };
    layout.remember(original);

    area = { x: -1280, y: 24, width: 1280, height: 876 };
    const reopened = new FakeWindow();
    layout.initialize(reopened);
    expect(reopened.bounds).toEqual({ x: -420, y: 400, width: 420, height: 500 });

    area = { x: 0, y: 24, width: 200, height: 700 };
    layout.initialize(reopened);
    expect(reopened.bounds).toEqual({ x: 0, y: 424, width: 200, height: 300 });
  });

  it("leaves system-managed bounds untouched and remembers the ordinary window when closed there", () => {
    const window = new FakeWindow(windowsFrame);
    const layout = new WindowLayout("win32", () => desktop);
    layout.initialize(window);
    window.normalBounds = window.getBounds();
    window.normal = false;
    window.bounds = { x: 0, y: 0, width: 768, height: 1366 };
    const event = { preventDefault: vi.fn() };
    layout.willResize(window, window.bounds, "bottom", event);
    layout.didResize(window);
    layout.remember(window);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.setBounds).not.toHaveBeenCalled();
    const reopened = new FakeWindow();
    layout.initialize(reopened);
    expect(reopened.getContentBounds()).toEqual({ x: 100, y: 100, width: 360, height: 478 });
  });
});

interface Size {
  width: number;
  height: number;
}

type ResizeEdge = Electron.WillResizeDetails["edge"] | "top";

export interface WindowRectangle extends Size {
  x: number;
  y: number;
}

interface NativeWindow {
  getBounds(): WindowRectangle;
  getContentBounds(): WindowRectangle;
  getNormalBounds(): WindowRectangle;
  isNormal(): boolean;
  setMinimumSize(width: number, height: number): void;
  setBounds(bounds: WindowRectangle, animate?: boolean): void;
}

export const initialContentSize: Size = { width: 360, height: 478 };
export const windowsCaptionHeight = 32;
const minimumContentSize: Size = { width: 160, height: 180 };

function fitWindowSize(bounds: Size, frame: Size): Size {
  const contentWidth = Math.max(minimumContentSize.width, bounds.width - frame.width);
  const contentHeight = Math.max(minimumContentSize.height, Math.min(bounds.height - frame.height, Math.floor(contentWidth * 1.5)));
  return { width: contentWidth + frame.width, height: contentHeight + frame.height };
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

// WindowLayout 管理用户拖动和恢复时的原生内容尺寸。
// 领域：Electron / 窗口布局
// 顺序：BrowserWindow 创建、resize、关闭 -> WindowLayout -> 原生边界。
// 作用：按内容宽度限制高度，在本次进程内恢复位置和大小。
// 原因：Windows 边框占用外框尺寸；AppKit 只报告拖动主轴和旧原点，需在 resize 时用实际原点确定固定边。
// 边界：仅约束普通窗口，不改变最大化、全屏或计时状态。
export class WindowLayout {
  private placement?: WindowRectangle;
  private frame: Size = { width: 0, height: 0 };
  private beforeMacResize?: WindowRectangle;
  private writingBounds = false;

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly workAreaFor: (bounds: WindowRectangle) => WindowRectangle,
    private readonly captionHeight = 0,
  ) {}

  initialize(window: NativeWindow): void {
    const current = window.getBounds();
    const content = window.getContentBounds();
    this.beforeMacResize = undefined;
    this.frame = { width: current.width - content.width, height: current.height - content.height + this.captionHeight };
    window.setMinimumSize(minimumContentSize.width + this.frame.width, minimumContentSize.height + this.frame.height);
    const desired = {
      x: this.placement?.x ?? current.x,
      y: this.placement?.y ?? current.y,
      width: (this.placement?.width ?? initialContentSize.width) + this.frame.width,
      height: (this.placement?.height ?? initialContentSize.height) + this.frame.height,
    };
    const area = this.workAreaFor(desired);
    const size = fitWindowSize({
      width: Math.min(area.width, desired.width),
      height: Math.min(area.height, desired.height),
    }, this.frame);
    this.apply(window, {
      x: Math.max(area.x, Math.min(desired.x, area.x + area.width - size.width)),
      y: Math.max(area.y, Math.min(desired.y, area.y + area.height - size.height)),
      ...size,
    });
  }

  remember(window: NativeWindow): void {
    const bounds = window.getNormalBounds();
    this.placement = { ...bounds, width: bounds.width - this.frame.width, height: bounds.height - this.frame.height };
  }

  willResize(window: NativeWindow, proposed: WindowRectangle, edge: ResizeEdge, event: { preventDefault(): void }): void {
    this.beforeMacResize = undefined;
    if (this.writingBounds || !window.isNormal()) return;
    const size = fitWindowSize(proposed, this.frame);
    if (sameSize(size, proposed)) return;

    const current = window.getBounds();
    if (this.platform === "darwin") {
      if (sameSize(size, current)) event.preventDefault();
      else this.beforeMacResize = current;
      return;
    }

    event.preventDefault();
    this.apply(window, {
      x: edge.includes("left") ? proposed.x + proposed.width - size.width : proposed.x,
      y: edge.includes("top") ? proposed.y + proposed.height - size.height : proposed.y,
      ...size,
    });
  }

  didResize(window: NativeWindow): void {
    const before = this.beforeMacResize;
    this.beforeMacResize = undefined;
    if (this.writingBounds || !window.isNormal()) return;
    const actual = window.getBounds();
    const size = fitWindowSize(actual, this.frame);
    if (sameSize(size, actual)) return;
    const fixedRight = before && Math.abs(before.x + before.width - actual.x - actual.width) < Math.abs(before.x - actual.x);
    const fixedBottom = before && Math.abs(before.y + before.height - actual.y - actual.height) < Math.abs(before.y - actual.y);
    this.apply(window, {
      x: fixedRight ? actual.x + actual.width - size.width : actual.x,
      y: fixedBottom ? actual.y + actual.height - size.height : actual.y,
      ...size,
    });
  }

  private apply(window: NativeWindow, bounds: WindowRectangle): void {
    const current = window.getBounds();
    if (sameSize(current, bounds) && current.x === bounds.x && current.y === bounds.y) return;
    this.writingBounds = true;
    try {
      window.setBounds(bounds, false);
    } finally {
      this.writingBounds = false;
    }
  }
}

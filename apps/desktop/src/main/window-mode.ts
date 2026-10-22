import type { WindowMode } from "../shared/contracts.js";

interface WindowSize {
  width: number;
  height: number;
}

export interface WindowRectangle extends WindowSize {
  x: number;
  y: number;
}

interface WindowPlacement extends WindowRectangle {
  contentWidth: number;
  contentHeight: number;
}

interface NativeWindow {
  getBounds(): WindowRectangle;
  getContentBounds(): WindowRectangle;
  setMinimumSize(width: number, height: number): void;
  setBounds(bounds: WindowRectangle, animate?: boolean): void;
}

export const windowModeLayouts: Readonly<Record<WindowMode, { defaultSize: WindowSize; minimumSize: WindowSize }>> = {
  regular: { defaultSize: { width: 360, height: 478 }, minimumSize: { width: 320, height: 300 } },
  mini: { defaultSize: { width: 220, height: 240 }, minimumSize: { width: 220, height: 240 } },
};

// WindowModeController 管理单个原生窗口的形态和会话内布局记忆。
// 领域：Electron / 窗口布局
// 顺序：窗口模式链第 4 站，Main IPC -> WindowModeController -> BrowserWindow。
// 作用：显式切换形态、恢复各自尺寸位置并避开屏幕工作区边缘。
// 原因：原生边框因平台不同，最小内容尺寸必须在主进程换算。
// 边界：不监听 resize、不访问 TimerEngine，也不读写用户数据库。
export class WindowModeController {
  private modeValue: WindowMode = "regular";
  private readonly placements: Partial<Record<WindowMode, WindowPlacement>> = {};

  constructor(private readonly workAreaFor: (bounds: WindowRectangle) => WindowRectangle) {}

  get mode(): WindowMode {
    return this.modeValue;
  }

  initialize(window: NativeWindow): void {
    this.apply(window, this.modeValue, this.placements[this.modeValue]);
  }

  remember(window: NativeWindow): void {
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    this.placements[this.modeValue] = { ...bounds, contentWidth: content.width, contentHeight: content.height };
  }

  setMode(window: NativeWindow, mode: WindowMode): WindowMode {
    if (mode === this.modeValue) return this.modeValue;
    this.remember(window);
    this.apply(window, mode, this.placements[mode]);
    this.modeValue = mode;
    return this.modeValue;
  }

  private apply(window: NativeWindow, mode: WindowMode, placement?: WindowPlacement): void {
    const current = window.getBounds();
    const content = window.getContentBounds();
    const frame = { width: current.width - content.width, height: current.height - content.height };
    const { minimumSize, defaultSize } = windowModeLayouts[mode];
    const minimum = { width: minimumSize.width + frame.width, height: minimumSize.height + frame.height };
    const desired = {
      x: placement?.x ?? current.x,
      y: placement?.y ?? current.y,
      width: Math.max(minimumSize.width, placement?.contentWidth ?? defaultSize.width) + frame.width,
      height: Math.max(minimumSize.height, placement?.contentHeight ?? defaultSize.height) + frame.height,
    };
    const workArea = this.workAreaFor(desired);
    const width = Math.max(minimum.width, Math.min(desired.width, workArea.width));
    const height = Math.max(minimum.height, Math.min(desired.height, workArea.height));
    const bounds = {
      x: Math.max(workArea.x, Math.min(desired.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(desired.y, workArea.y + workArea.height - height)),
      width,
      height,
    };
    window.setMinimumSize(minimum.width, minimum.height);
    window.setBounds(bounds, false);
  }
}

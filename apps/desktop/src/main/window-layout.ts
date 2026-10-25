interface WindowSize {
  width: number;
  height: number;
}

export interface WindowRectangle extends WindowSize {
  x: number;
  y: number;
}

interface WindowPlacement {
  x: number;
  y: number;
  contentWidth: number;
  contentHeight: number;
}

interface NativeWindow {
  getBounds(): WindowRectangle;
  getContentBounds(): WindowRectangle;
  setMinimumSize(width: number, height: number): void;
  setBounds(bounds: WindowRectangle, animate?: boolean): void;
}

export const windowLayout = {
  defaultSize: { width: 360, height: 478 },
  minimumSize: { width: 160, height: 180 },
} as const;

// WindowLayoutController 管理单个原生窗口的尺寸和会话内位置记忆。
// 领域：Electron / 窗口布局
// 顺序：应用启动链第 3 站，Main createWindow -> WindowLayoutController -> BrowserWindow。
// 作用：恢复上次内容尺寸与原生位置，并避开屏幕工作区边缘。
// 原因：原生边框因平台不同，最小内容尺寸必须在主进程换算。
// 边界：不监听 resize、不访问 TimerEngine，也不读写用户数据库。
export class WindowLayoutController {
  private placement: WindowPlacement | undefined;

  constructor(private readonly workAreaFor: (bounds: WindowRectangle) => WindowRectangle) {}

  initialize(window: NativeWindow): void {
    const current = window.getBounds();
    const content = window.getContentBounds();
    const frame = { width: current.width - content.width, height: current.height - content.height };
    const { minimumSize, defaultSize } = windowLayout;
    const minimum = { width: minimumSize.width + frame.width, height: minimumSize.height + frame.height };
    const desired = {
      x: this.placement?.x ?? current.x,
      y: this.placement?.y ?? current.y,
      width: Math.max(minimumSize.width, this.placement?.contentWidth ?? defaultSize.width) + frame.width,
      height: Math.max(minimumSize.height, this.placement?.contentHeight ?? defaultSize.height) + frame.height,
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

  remember(window: NativeWindow): void {
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    this.placement = { x: bounds.x, y: bounds.y, contentWidth: content.width, contentHeight: content.height };
  }
}

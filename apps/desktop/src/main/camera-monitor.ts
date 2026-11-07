import type { CameraState } from "../shared/contracts.js";

// 领域：Electron / 摄像头会话
// 顺序：Main 模式与电源事件 -> CameraMonitor -> Renderer 本地检测 -> report。
// 作用：隔离每次检测会话，并为启动和后续样本设置有界期限。
// 原因：Renderer 卡死或迟到的报告不能让旧的在场结果持续控制计时。
// 边界：仅保存代次和单调期限，不接收视频或持久化采样。
export class CameraMonitor {
  private value: CameraState = { enabled: false, generation: 0 };
  private deadline = 0;

  get state(): CameraState { return { ...this.value }; }

  setEnabled(enabled: boolean, now: number): boolean {
    if (this.value.enabled === enabled) return false;
    this.value = { enabled, generation: this.value.generation + 1 };
    this.deadline = enabled ? now + 25_000 : 0;
    return true;
  }

  report(generation: number, now: number): void {
    if (!this.value.enabled || generation !== this.value.generation) throw new Error("摄像头会话已失效");
    if (this.expired(now)) throw new Error("摄像头检测响应超时");
    this.deadline = now + 5_000;
  }

  expired(now: number): boolean { return this.value.enabled && now >= this.deadline; }
}

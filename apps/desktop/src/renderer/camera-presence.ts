import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Presence } from "../shared/contracts";

const SAMPLE_INTERVAL_MS = 500;
const ABSENCE_GRACE_MS = 3_000;
const STARTUP_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 3_000;

// 领域：Camera / Renderer 本地感知
// 顺序：感知链第 1 站，App 显式选择监控 -> 本地视频推理 -> Preload 感知样本。
// 作用：仅报告在场状态，并在取消、初始化超时或视频故障时释放摄像头。
// 原因：权限和模型初始化都可能晚于模式切换完成，迟到资源也必须立即关闭。
// 边界：视频和检测框只在当前函数内存中使用；计时与自动化仍由 Main 决定。
export function startCameraPresence(
  onPresence: (presence: Presence) => Promise<void> | void,
  onFailure: (message: string) => void,
): () => void {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  let stream: MediaStream | undefined;
  let detector: FaceDetector | undefined;
  let stopped = false;
  let nextSample: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<() => void> = [];

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimeout);
    clearTimeout(nextSample);
    listeners.splice(0).forEach((remove) => remove());
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.pause();
    video.srcObject = null;
    detector?.close();
    detector = undefined;
  }

  function fail(message: string): void {
    if (stopped) return;
    stop();
    onFailure(message);
  }

  function listen(target: EventTarget, event: string, handler: () => void): void {
    target.addEventListener(event, handler);
    listeners.push(() => target.removeEventListener(event, handler));
  }

  let stablePresence: Presence = "unknown";
  let absentSince: number | undefined;
  let lastVideoTime = -1;
  let lastFrameAt = 0;

  async function sample(): Promise<void> {
    if (stopped || !detector) return;
    try {
      const now = performance.now();
      const track = stream?.getVideoTracks()[0];
      if (!track || track.readyState !== "live" || track.muted || !track.enabled) {
        fail("摄像头已断开或暂停，请重试监控感知。");
        return;
      }
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        lastFrameAt = now;
        const result = detector.detectForVideo(video, now);
        const present = result.detections.some((face) =>
          face.boundingBox !== undefined &&
          face.boundingBox.height >= video.videoHeight * 0.15 &&
          (face.categories[0]?.score ?? 0) >= 0.8,
        );
        if (present) {
          stablePresence = "present";
          absentSince = undefined;
        } else {
          absentSince ??= now;
          if (now - absentSince >= ABSENCE_GRACE_MS) stablePresence = "away";
        }
      } else if (now - lastFrameAt >= FRAME_TIMEOUT_MS) {
        fail("摄像头画面已停止更新，请重试监控感知。");
        return;
      }

      // 领域：Camera / 样本顺序
      // 顺序：感知链第 2 站，本地检测 -> 串行上报 -> 下一次本地检测。
      // 作用：等待当前上报完成后再采样，避免跨进程响应积压。
      // 原因：模式切换和关闭可发生在任意 await 期间，后续样本必须尊重取消状态。
      // 边界：这里只上报三态结果；Main 负责丢弃过期来源和决定计时行为。
      if (stablePresence !== "unknown") await onPresence(stablePresence);
      if (!stopped) nextSample = setTimeout(() => { void sample(); }, SAMPLE_INTERVAL_MS);
    } catch {
      fail("摄像头检测失败，请重试监控感知或切换到触控感知。");
    }
  }

  async function initialize(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail("当前环境无法使用摄像头，请切换到触控感知。");
        return;
      }
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 5, max: 10 },
        },
      });
      if (stopped) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      for (const track of stream.getVideoTracks()) {
        listen(track, "ended", () => fail("摄像头已断开，请重试监控感知。"));
        listen(track, "mute", () => fail("摄像头已暂停，请重试监控感知。"));
      }
      listen(video, "error", () => fail("摄像头画面不可用，请重试监控感知。"));
      video.srcObject = stream;
      await video.play();
      if (stopped) return;
      const assetRoot = new URL("./mediapipe/", document.baseURI);
      const vision = await FilesetResolver.forVisionTasks(assetRoot.href.replace(/\/$/, ""));
      if (stopped) return;
      const created = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: new URL("blaze_face_short_range.tflite", assetRoot).href },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.8,
      });
      if (stopped) {
        created.close();
        return;
      }
      detector = created;
      clearTimeout(startupTimeout);
      lastFrameAt = performance.now();
      await sample();
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      fail(denied
        ? "摄像头权限未开启，请在系统设置中允许访问后重试。"
        : "摄像头无法启动，请检查设备是否连接或被其他应用占用，然后重试。");
    }
  }

  const startupTimeout = setTimeout(() => fail("摄像头启动超时，请确认权限和设备后重试。"), STARTUP_TIMEOUT_MS);
  void initialize();
  return stop;
}

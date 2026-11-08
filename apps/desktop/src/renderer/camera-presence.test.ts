import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import type { FaceDetectorResult } from "@mediapipe/tasks-vision";
import { startCameraPresence } from "./camera-presence";

vi.mock("@mediapipe/tasks-vision", () => ({
  FaceDetector: { createFromOptions: vi.fn() },
  FilesetResolver: { forVisionTasks: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function detection(score = 0.9, height = 120): FaceDetectorResult {
  return {
    detections: [{
      boundingBox: { originX: 0, originY: 0, width: 100, height, angle: 0 },
      categories: [{ score, index: 0, categoryName: "face", displayName: "face" }],
      keypoints: [],
    }],
  };
}

describe("local camera presence", () => {
  let video: HTMLVideoElement;
  let track: EventTarget & { readyState: string; muted: boolean; enabled: boolean; stop: ReturnType<typeof vi.fn> };
  let stream: MediaStream;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let detect: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let onPresence: ReturnType<typeof vi.fn>;
  let onFailure: ReturnType<typeof vi.fn>;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
      videoHeight: { value: 480 },
      currentTime: { configurable: true, get: () => performance.now() / 1_000 },
    });
    vi.spyOn(video, "play").mockResolvedValue();
    vi.spyOn(video, "pause").mockImplementation(() => undefined);
    vi.spyOn(document, "createElement").mockReturnValue(video);
    track = Object.assign(new EventTarget(), { readyState: "live", muted: false, enabled: true, stop: vi.fn() });
    stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    detect = vi.fn().mockReturnValue(detection());
    close = vi.fn();
    vi.mocked(FilesetResolver.forVisionTasks).mockResolvedValue({ wasmLoaderPath: "local.js", wasmBinaryPath: "local.wasm" });
    vi.mocked(FaceDetector.createFromOptions).mockResolvedValue({ detectForVideo: detect, close } as unknown as FaceDetector);
    onPresence = vi.fn().mockResolvedValue(undefined);
    onFailure = vi.fn();
    stop = undefined;
  });

  afterEach(() => {
    stop?.();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function start(): Promise<void> {
    stop = startCameraPresence(onPresence, onFailure);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("opens video only, uses bundled assets and closes all resources on stop", async () => {
    await start();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 },
        frameRate: { ideal: 5, max: 10 },
      },
    });
    expect(FilesetResolver.forVisionTasks).toHaveBeenCalledWith(new URL("./mediapipe", document.baseURI).href);
    expect(FaceDetector.createFromOptions).toHaveBeenCalledWith(expect.anything(), {
      baseOptions: { modelAssetPath: new URL("./mediapipe/blaze_face_short_range.tflite", document.baseURI).href },
      runningMode: "VIDEO", minDetectionConfidence: 0.8,
    });
    expect(onPresence).toHaveBeenLastCalledWith("present");
    stop?.();
    stop?.();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("cancels an unanswered permission request and closes its late stream", async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    await start();
    stop?.();
    permission.resolve(stream);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(FaceDetector.createFromOptions).not.toHaveBeenCalled();
    expect(onPresence).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("closes a detector that finishes loading after cancellation", async () => {
    const model = deferred<FaceDetector>();
    vi.mocked(FaceDetector.createFromOptions).mockReturnValue(model.promise);
    await start();
    stop?.();
    expect(track.stop).toHaveBeenCalledTimes(1);
    model.resolve({ detectForVideo: detect, close } as unknown as FaceDetector);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("times out startup once and releases a late permission result", async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    await start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("超时"));
    permission.resolve(stream);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onPresence).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("releases the camera when model initialization fails", async () => {
    vi.mocked(FaceDetector.createFromOptions).mockRejectedValue(new Error("model unavailable"));
    await start();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onPresence).not.toHaveBeenCalled();
  });

  it("explains denied permission without loading a detector", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await start();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("权限"));
    expect(FaceDetector.createFromOptions).not.toHaveBeenCalled();
    expect(onPresence).not.toHaveBeenCalled();
  });

  it("releases the stream if video playback never starts", async () => {
    const playback = deferred<void>();
    vi.mocked(video.play).mockReturnValue(playback.promise);
    await start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    playback.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(FaceDetector.createFromOptions).not.toHaveBeenCalled();
    expect(onPresence).not.toHaveBeenCalled();
  });

  it("rejects a stream that never produces its first frame", async () => {
    Object.defineProperty(video, "readyState", { value: HTMLMediaElement.HAVE_METADATA });
    await start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();
    expect(onPresence).not.toHaveBeenCalled();
  });

  it("keeps initial absence unknown until three seconds of fresh frames", async () => {
    detect.mockReturnValue({ detections: [] });
    await start();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onPresence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onPresence).toHaveBeenLastCalledWith("away");
    detect.mockReturnValue(detection());
    await vi.advanceTimersByTimeAsync(500);
    expect(onPresence).toHaveBeenLastCalledWith("present");
  });

  it("ignores short dropouts and small or low-confidence faces", async () => {
    await start();
    detect.mockReturnValue(detection(0.79));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onPresence).toHaveBeenLastCalledWith("present");
    detect.mockReturnValue(detection());
    await vi.advanceTimersByTimeAsync(500);
    detect.mockReturnValue(detection(0.9, 60));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onPresence).toHaveBeenLastCalledWith("present");
    await vi.advanceTimersByTimeAsync(500);
    expect(onPresence).toHaveBeenLastCalledWith("away");
  });

  it.each(["mute", "ended"])("releases resources on track %s without reporting away", async (event) => {
    await start();
    track.dispatchEvent(new Event(event));
    track.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onPresence).not.toHaveBeenCalledWith("away");
  });

  it("fails closed on a detection exception instead of retaining present", async () => {
    await start();
    detect.mockImplementation(() => { throw new Error("inference failed"); });
    await vi.advanceTimersByTimeAsync(500);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onPresence).toHaveBeenCalledTimes(1);
  });

  it("detects frozen video as a failure instead of confirmed absence", async () => {
    Object.defineProperty(video, "currentTime", { value: 0 });
    await start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining("停止更新"));
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onPresence).not.toHaveBeenCalledWith("away");
  });

  it("waits for an in-flight report and does not restart sampling after stop", async () => {
    const report = deferred<void>();
    onPresence.mockReturnValue(report.promise);
    await start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detect).toHaveBeenCalledTimes(1);
    stop?.();
    report.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(onPresence).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

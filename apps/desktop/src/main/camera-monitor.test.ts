import { describe, expect, it } from "vitest";
import { CameraMonitor } from "./camera-monitor.js";

describe("camera heartbeat", () => {
  it("allows startup time, then requires a fresh report within five seconds", () => {
    const camera = new CameraMonitor();
    camera.setEnabled(true, 100);
    expect(camera.expired(25_099)).toBe(false);
    expect(camera.expired(25_100)).toBe(true);
    camera.report(camera.state.generation, 1000);
    expect(camera.expired(5999)).toBe(false);
    expect(camera.expired(6000)).toBe(true);
  });

  it("rejects late results after stopping, restarting or switching modes", () => {
    const camera = new CameraMonitor();
    camera.setEnabled(true, 0);
    const old = camera.state.generation;
    camera.setEnabled(false, 10);
    expect(() => camera.report(old, 20)).toThrow("失效");
    camera.setEnabled(true, 30);
    expect(() => camera.report(old, 40)).toThrow("失效");
    expect(() => camera.report(camera.state.generation, 40)).not.toThrow();
  });
});

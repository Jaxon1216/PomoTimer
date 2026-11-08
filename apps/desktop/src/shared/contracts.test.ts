import { describe, expect, it } from "vitest";
import { automationStateSchema, breakPreparationSchema, cameraPresenceReportSchema, cameraStateSchema, coreEventSchema } from "./contracts.js";

describe("camera IPC boundaries", () => {
  it("rejects frame data and unknown fields instead of forwarding them to Main", () => {
    expect(cameraPresenceReportSchema.safeParse({ presence: "present", generation: 1, frame: "pixels" }).success).toBe(false);
    expect(cameraStateSchema.safeParse({ enabled: true, generation: 1, stream: "camera" }).success).toBe(false);
    expect(coreEventSchema.safeParse({ type: "camera.state", state: { enabled: true, generation: 1 }, identity: "person" }).success).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid camera generation %s", (generation) => {
    expect(cameraPresenceReportSchema.safeParse({ presence: "present", generation }).success).toBe(false);
  });
});


describe("break preparation IPC compatibility", () => {
  it("accepts legacy automation without preparation and validates new runtime preparation", () => {
    const previous = { activePresenceSource: "input", inputPresence: "unknown", cameraPresence: "unknown", inputMonitoringAvailable: true, cameraMonitoringAvailable: false, manualPauseLocked: false, pauseReason: "none" };
    expect(automationStateSchema.safeParse(previous).success).toBe(true);
    expect(automationStateSchema.safeParse({ ...previous, breakPreparation: null }).success).toBe(true);
    expect(automationStateSchema.safeParse({ ...previous, breakPreparation: { remainingSeconds: 10, countdown: true } }).success).toBe(true);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid preparation seconds %s", (remainingSeconds) => {
    expect(breakPreparationSchema.safeParse({ remainingSeconds, countdown: true }).success).toBe(false);
  });

  it("rejects unexpected preparation fields", () => {
    expect(breakPreparationSchema.safeParse({ remainingSeconds: 10, countdown: true, idleSeconds: 30 }).success).toBe(false);
  });
});

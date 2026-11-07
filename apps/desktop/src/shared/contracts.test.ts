import { describe, expect, it } from "vitest";
import { cameraPresenceReportSchema, cameraStateSchema, coreEventSchema } from "./contracts.js";

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

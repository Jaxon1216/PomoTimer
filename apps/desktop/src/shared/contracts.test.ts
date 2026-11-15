import { describe, expect, it } from "vitest";
import { automationStateSchema, breakPreparationSchema, cameraPresenceReportSchema, cameraStateSchema, coreEventSchema, presenceSourceSchema, roundSchema, settingsPatchSchema, timerCommandSchema } from "./contracts.js";

describe("standing break IPC boundaries", () => {
  const round = { kind: "short-break", cycleNumber: 1, positionInCycle: 2, focusRoundNumber: null, breakMode: "standing", totalDurationMs: 600_000 };

  it("allows a standing current round and legacy rounds without a start marker", () => {
    expect(roundSchema.safeParse(round).success).toBe(true);
    expect(roundSchema.safeParse({ ...round, hasStarted: false }).success).toBe(true);
    expect(roundSchema.safeParse({ ...round, hasStarted: true }).success).toBe(true);
    expect(roundSchema.safeParse({ ...round, hasStarted: "false" }).success).toBe(false);
    expect(roundSchema.safeParse({ ...round, kind: "focus" }).success).toBe(false);
  });

  it("does not turn standing into a global default or a selectable presence source", () => {
    expect(settingsPatchSchema.safeParse({ defaultBreakMode: "standing" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ focusPresenceSource: "none" }).success).toBe(false);
    expect(presenceSourceSchema.safeParse("none").success).toBe(false);
    expect(settingsPatchSchema.parse({})).toEqual({});
    expect(settingsPatchSchema.safeParse({ standingDefault: true }).success).toBe(false);
  });

  it.each([
    ["standingShortBreakDurationSeconds", 7_200],
    ["standingLongBreakDurationSeconds", 10_800],
  ] as const)("accepts nullable whole-minute %s and rejects invalid values", (field, maximum) => {
    for (const value of [null, 60, maximum]) {
      expect(settingsPatchSchema.safeParse({ [field]: value }).success).toBe(true);
    }
    for (const value of [0, 59, 61, 60.5, maximum + 60, Number.NaN, Number.POSITIVE_INFINITY, "120", false]) {
      expect(settingsPatchSchema.safeParse({ [field]: value }).success).toBe(false);
    }
  });

  it("accepts only the allowlisted standing command", () => {
    expect(timerCommandSchema.parse("start-standing-break")).toBe("start-standing-break");
    expect(timerCommandSchema.safeParse("restart-standing-break").success).toBe(false);
    expect(timerCommandSchema.safeParse({ command: "start-standing-break", duration: 1 }).success).toBe(false);
  });

  it("can describe a manual standing pause without claiming an active detector", () => {
    expect(automationStateSchema.safeParse({ activePresenceSource: "none", inputPresence: "unknown", cameraPresence: "unknown",
      inputMonitoringAvailable: true, cameraMonitoringAvailable: false, breakPreparation: null,
      manualPauseLocked: false, pauseReason: "standing-confirmation" }).success).toBe(true);
  });
});

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

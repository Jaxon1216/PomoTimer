import { describe, expect, it } from "vitest";
import { automationStateSchema, breakPreparationSchema, cameraPresenceReportSchema, cameraStateSchema, coreEventSchema, presenceSourceSchema, roundSchema, settingsPatchSchema, timerCommandSchema } from "./contracts.js";

describe("standing break IPC boundaries", () => {
  const round = { kind: "short-break", cycleNumber: 1, positionInCycle: 2, focusRoundNumber: null, breakMode: "standing", totalDurationMs: 600_000 };

  it("allows a standing break round without extra start markers and rejects focus standing", () => {
    expect(roundSchema.safeParse(round).success).toBe(true);
    expect(roundSchema.safeParse({ ...round, hasStarted: false }).success).toBe(false);
    expect(roundSchema.safeParse({ ...round, kind: "focus" }).success).toBe(false);
  });

  it("does not turn standing into a global default, presence source, or separate duration setting", () => {
    expect(settingsPatchSchema.safeParse({ defaultBreakMode: "standing" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ focusPresenceSource: "none" }).success).toBe(false);
    expect(presenceSourceSchema.safeParse("none").success).toBe(false);
    expect(settingsPatchSchema.parse({})).toEqual({});
    expect(settingsPatchSchema.safeParse({ standingDefault: true }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ standingShortBreakDurationSeconds: 600 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ standingLongBreakDurationSeconds: 1200 }).success).toBe(false);
  });

  it("accepts only the allowlisted standing enter and exit commands", () => {
    expect(timerCommandSchema.parse("start-standing-break")).toBe("start-standing-break");
    expect(timerCommandSchema.parse("exit-standing-break")).toBe("exit-standing-break");
    expect(timerCommandSchema.safeParse("restart-standing-break").success).toBe(false);
    expect(timerCommandSchema.safeParse({ command: "start-standing-break", duration: 1 }).success).toBe(false);
  });

  it("can describe a manual standing pause without claiming an active detector", () => {
    expect(automationStateSchema.safeParse({ activePresenceSource: "none", inputPresence: "unknown", cameraPresence: "unknown",
      inputMonitoringAvailable: true, cameraMonitoringAvailable: false, breakPreparation: null,
      manualPauseLocked: false, pauseReason: "standing-confirmation" }).success).toBe(true);
  });
});

describe("focus duration settings", () => {
  it.each([60, 240, 7200])("accepts a focus duration of %s seconds", (focusDurationSeconds) => {
    expect(settingsPatchSchema.parse({ focusDurationSeconds })).toEqual({ focusDurationSeconds });
  });

  it.each([0, 59, 60.5, 7201])("rejects an out-of-range or fractional focus duration of %s seconds", (focusDurationSeconds) => {
    expect(settingsPatchSchema.safeParse({ focusDurationSeconds }).success).toBe(false);
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

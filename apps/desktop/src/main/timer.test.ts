import { describe, expect, it } from "vitest";
import type { TimerCheckpoint } from "./checkpoint.js";
import type { TimerSnapshot } from "../shared/contracts.js";
import {
  defaultSettings,
  TimerEngine,
  type CompletedSession,
  type TimerClock,
  type TimerStore,
} from "./timer.js";

class FakeClock implements TimerClock {
  value = 0;
  date = new Date("2026-10-15T09:00:00.000Z");

  now(): number {
    return this.value;
  }

  wallDate(): Date {
    return this.date;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

class FakeStore implements TimerStore {
  snapshot?: TimerCheckpoint;
  settings = defaultSettings;
  sessions: CompletedSession[] = [];
  failCommit = false;
  failSnapshot = false;
  snapshotWrites = 0;

  loadSnapshot(): TimerCheckpoint | undefined {
    return this.snapshot;
  }

  loadSettings() {
    return this.settings;
  }

  saveSnapshot(snapshot: TimerCheckpoint): void {
    this.snapshotWrites += 1;
    if (this.failSnapshot) throw new Error("snapshot failed");
    this.snapshot = structuredClone(snapshot);
  }

  saveSettings(settings: typeof defaultSettings): void {
    this.settings = structuredClone(settings);
  }

  commitCompletedSessionAndSnapshot(session: CompletedSession, snapshot: TimerCheckpoint): void {
    if (this.failCommit) throw new Error("commit failed");
    if (!this.sessions.some((item) => item.id === session.id)) this.sessions.push(structuredClone(session));
    this.snapshot = structuredClone(snapshot);
  }
}

function create() {
  const store = new FakeStore();
  const clock = new FakeClock();
  const engine = new TimerEngine(store, clock);
  return { store, clock, engine };
}

function observeIdle(engine: TimerEngine, clock: FakeClock, firstSecond: number, lastSecond: number): TimerSnapshot {
  let snapshot = engine.snapshot;
  for (let idleSeconds = firstSecond; idleSeconds <= lastSecond; idleSeconds += 1) {
    clock.advance(1_000);
    snapshot = engine.inputSample(idleSeconds, true);
  }
  return snapshot;
}

describe("TimerEngine", () => {
  describe("camera presence across focus and breaks", () => {
    it("automatically starts and resumes camera focus while input remains observable", () => {
      const { engine, clock } = create();
      engine.applySettings({ focusPresenceSource: "camera" });
      expect(engine.snapshot.status).toBe("idle");
      expect(engine.cameraSample("present").status).toBe("running");
      clock.advance(1_000);
      expect(engine.inputSample(40).status).toBe("running");
      expect(engine.inputSample(undefined, false).status).toBe("running");
      const paused = engine.cameraSample("away");
      expect(paused.status).toBe("auto-paused");
      expect(paused.automation.pauseReason).toBe("camera-away");
      clock.advance(10_000);
      expect(engine.inputSample(0).remainingMs).toBe(paused.remainingMs);
      expect(engine.cameraSample("present").status).toBe("running");
    });

    it("keeps touch-input focus idle until an explicit start in every cycle position", () => {
      const { engine } = create();
      expect(engine.inputSample(0).status).toBe("idle");
      engine.command("next");
      engine.command("next");
      expect(engine.snapshot.round.focusRoundNumber).toBe(2);
      expect(engine.inputSample(0).status).toBe("idle");
      expect(engine.command("start").status).toBe("running");
    });

    it("uses camera absence for active breaks and presence for the next focus", () => {
      const { engine, clock, store } = create();
      engine.applySettings({ focusPresenceSource: "camera" });
      engine.cameraSample("present");
      clock.advance(defaultSettings.focusDurationSeconds * 1000);
      const waiting = structuredClone(engine.snapshot);
      expect(waiting.round.kind).toBe("short-break");
      expect(waiting.automation.activePresenceSource).toBe("camera");
      expect(engine.inputSample(600).status).toBe("auto-paused");
      expect(engine.cameraSample("present").status).toBe("auto-paused");
      expect(engine.cameraSample("away").status).toBe("running");
      clock.advance(1_000);
      expect(engine.inputSample(0).status).toBe("running");
      const interrupted = engine.cameraSample("present");
      expect(interrupted.status).toBe("auto-paused");
      expect(interrupted.automation.pauseReason).toBe("break-condition");
      clock.advance(5_000);
      expect(engine.inputSample(600).remainingMs).toBe(interrupted.remainingMs);
      engine.cameraSample("away");
      clock.advance(interrupted.remainingMs);
      const nextFocus = engine.snapshot;
      expect(nextFocus.round.kind).toBe("focus");
      expect(nextFocus.status).toBe("idle");
      expect(engine.cameraSample("present").status).toBe("running");
      expect(store.sessions).toHaveLength(1);
    });

    it("keeps desk breaks on system input in camera mode", () => {
      const { engine } = create();
      engine.applySettings({ focusPresenceSource: "camera", defaultBreakMode: "desk" });
      engine.command("next");
      expect(engine.snapshot.automation.activePresenceSource).toBe("input");
      expect(engine.cameraSample("away").status).toBe("auto-paused");
      expect(engine.inputSample(40).status).toBe("running");
      expect(engine.cameraSample("unknown").status).toBe("running");
      expect(engine.inputSample(0).status).toBe("auto-paused");
    });

    it.each(["focus", "active-break"] as const)("safely pauses %s on unknown camera presence without a manual camera fallback", (kind) => {
      const { engine, clock } = create();
      engine.applySettings({ focusPresenceSource: "camera" });
      if (kind === "active-break") engine.command("next");
      expect(() => engine.command("start")).toThrow("摄像头");
      const expectedPresence = kind === "focus" ? "present" : "away";
      engine.cameraSample(expectedPresence);
      clock.advance(1_000);
      const unavailable = engine.cameraSample("unknown");
      expect(unavailable.status).toBe("auto-paused");
      expect(unavailable.automation.pauseReason).toBe("source-unavailable");
      expect(unavailable.automation.cameraMonitoringAvailable).toBe(false);
      expect(() => engine.command("resume")).toThrow("摄像头");
      clock.advance(5_000);
      expect(engine.inputSample(0).remainingMs).toBe(unavailable.remainingMs);
      expect(engine.cameraSample(expectedPresence).status).toBe("running");
    });

    it.each(["focus", "active-break"] as const)("waits for a fresh source sample when switching a running %s", (kind) => {
      const { engine } = create();
      if (kind === "active-break") {
        engine.command("next");
        engine.inputSample(40);
      } else engine.command("start");
      engine.applySettings({ focusPresenceSource: "camera" });
      const waiting = engine.snapshot;
      expect(waiting.status).toBe("auto-paused");
      expect(waiting.automation.activePresenceSource).toBe("camera");
      expect(waiting.automation.cameraPresence).toBe("unknown");
      expect(engine.inputSample(kind === "focus" ? 0 : 40).status).toBe("auto-paused");
      expect(engine.cameraSample(kind === "focus" ? "present" : "away").status).toBe("running");
      engine.applySettings({ focusPresenceSource: "input" });
      expect(engine.snapshot.status).toBe("auto-paused");
      expect(engine.cameraSample("present").status).toBe("auto-paused");
      expect(engine.inputSample(kind === "focus" ? 0 : 40).status).toBe("running");
    });

    it("preserves a manually running desk break when changing the focus source", () => {
      const { engine } = create();
      engine.applySettings({ defaultBreakMode: "desk" });
      engine.command("next");
      engine.inputSample(undefined, false);
      engine.command("resume");
      engine.applySettings({ focusPresenceSource: "camera" });
      expect(engine.snapshot.automation.activePresenceSource).toBe("input");
      expect(engine.inputSample(undefined, false).status).toBe("running");
    });

    it("keeps a manually paused focus locked across presence, source changes and restart", () => {
      const { engine, store, clock } = create();
      engine.applySettings({ focusPresenceSource: "camera" });
      engine.cameraSample("present");
      engine.command("pause");
      expect(engine.cameraSample("present").status).toBe("manual-paused");
      const restored = new TimerEngine(store, clock);
      expect(restored.cameraSample("present").status).toBe("manual-paused");
      restored.applySettings({ focusPresenceSource: "input" });
      expect(restored.inputSample(0).status).toBe("manual-paused");
      expect(restored.command("resume").status).toBe("running");
    });

    it("does not lock camera active-break automation after the user pauses", () => {
      const { engine, clock } = create();
      engine.applySettings({ focusPresenceSource: "camera" });
      engine.command("next");
      engine.cameraSample("away");
      clock.advance(1_000);
      const paused = engine.command("pause");
      expect(paused.status).toBe("auto-paused");
      expect(paused.automation.manualPauseLocked).toBe(false);
      clock.advance(5_000);
      expect(engine.cameraSample("present").remainingMs).toBe(paused.remainingMs);
      expect(engine.cameraSample("away").status).toBe("running");
    });

    it.each(["suspend", "lock", "restart"] as const)("discards camera presence after %s", (interruption) => {
      const first = create();
      let engine = first.engine;
      engine.applySettings({ focusPresenceSource: "camera" });
      engine.cameraSample("present");
      if (interruption === "suspend") engine.systemSuspend();
      else if (interruption === "lock") {
        engine.systemLock();
        expect(engine.cameraSample("present").status).toBe("auto-paused");
        engine.systemUnlock();
      } else engine = new TimerEngine(first.store, first.clock);
      expect(engine.snapshot.automation.cameraPresence).toBe("unknown");
      expect(() => engine.command("resume")).toThrow("摄像头");
      expect(engine.inputSample(0).status).toBe("auto-paused");
      expect(engine.cameraSample("present").status).toBe("running");
    });
  });

  it("locks automatic recovery after a manual pause, including restart", () => {
    const first = create();
    first.engine.command("start");
    first.engine.command("pause");

    const restored = new TimerEngine(first.store, first.clock);
    expect(restored.snapshot.status).toBe("manual-paused");
    expect(restored.snapshot.automation.manualPauseLocked).toBe(true);
    expect(restored.inputSample(0, true).status).toBe("manual-paused");
    expect(restored.command("resume").status).toBe("running");
  });

  it("pauses and resumes focus from system input without consuming away time", () => {
    const { engine, clock } = create();
    engine.command("start");
    clock.advance(1_000);
    engine.inputSample(40, true);
    const paused = engine.snapshot;

    expect(paused.status).toBe("auto-paused");
    clock.advance(20_000);
    expect(engine.snapshot.remainingMs).toBe(paused.remainingMs);
    expect(engine.inputSample(0, true).status).toBe("running");
  });

  it("moves an unavailable input source into a visible safe pause", () => {
    const { engine, clock } = create();
    engine.command("start");
    clock.advance(1_000);

    const snapshot = engine.inputSample(undefined, false);

    expect(snapshot.status).toBe("auto-paused");
    expect(snapshot.automation.inputMonitoringAvailable).toBe(false);
    expect(snapshot.automation.inputPresence).toBe("unknown");
    expect(snapshot.automation.pauseReason).toBe("source-unavailable");
    const remaining = snapshot.remainingMs;
    clock.advance(20_000);
    expect(engine.snapshot.remainingMs).toBe(remaining);
  });

  describe("manual timing while input is unavailable", () => {
    it.each(["start", "resume"] as const)("keeps an explicit %s running through repeated failed samples", (command) => {
      const { engine, clock } = create();
      if (command === "resume") engine.command("start");
      const unavailable = engine.inputSample(undefined, false);
      engine.command(command);

      for (let sample = 0; sample < 3; sample += 1) {
        clock.advance(1_000);
        const snapshot = engine.inputSample(undefined, false);
        expect(snapshot.status).toBe("running");
        expect(snapshot.automation.inputMonitoringAvailable).toBe(false);
        expect(snapshot.automation.inputPresence).toBe("unknown");
        expect(snapshot.remainingMs).toBe(unavailable.remainingMs - (sample + 1) * 1_000);
      }
    });

    it("restores normal automation on the first valid sample and the next failure pauses again", () => {
      const { engine } = create();
      engine.inputSample(undefined, false);
      engine.command("start");
      expect(engine.inputSample(40, true).status).toBe("auto-paused");
      expect(engine.inputSample(0, true).status).toBe("running");
      expect(engine.inputSample(undefined, false).status).toBe("auto-paused");
    });

    it.each(["suspend", "restart", "lock"] as const)("discards the manual fallback after %s", (interruption) => {
      const { engine: original, clock, store } = create();
      let engine = original;
      engine.inputSample(undefined, false);
      engine.command("start");
      if (interruption === "suspend") engine.systemSuspend();
      else if (interruption === "lock") {
        engine.systemLock();
        engine.systemUnlock();
      } else engine = new TimerEngine(store, clock);

      const remaining = engine.snapshot.remainingMs;
      clock.advance(5_000);
      expect(engine.inputSample(undefined, false).status).toBe("auto-paused");
      expect(engine.snapshot.remainingMs).toBe(remaining);
      engine.command("resume");
      expect(engine.inputSample(undefined, false).status).toBe("running");
    });

    it("preserves a manual pause even after the fallback was explicitly enabled", () => {
      const { engine, clock } = create();
      engine.inputSample(undefined, false);
      engine.command("start");
      const paused = engine.command("pause");
      clock.advance(1_000);
      const failed = engine.inputSample(undefined, false);
      expect(failed.status).toBe("manual-paused");
      expect(failed.automation.manualPauseLocked).toBe(true);
      expect(failed.remainingMs).toBe(paused.remainingMs);
    });

    it("does not carry a manual fallback into the next break", () => {
      const { engine } = create();
      engine.inputSample(undefined, false);
      engine.command("start");
      expect(engine.command("next").status).toBe("auto-paused");
      expect(engine.inputSample(undefined, false).status).toBe("auto-paused");
    });
  });

  describe("screen locking", () => {
    it("freezes focus until unlock and a subsequent valid sample", () => {
      const { engine, clock } = create();
      engine.command("start");
      clock.advance(1_000);
      const locked = engine.systemLock();
      expect(locked.status).toBe("auto-paused");
      expect(locked.automation.pauseReason).toBe("system-lock");

      clock.advance(5_000);
      expect(engine.inputSample(0, true).status).toBe("auto-paused");
      expect(engine.inputSample(undefined, false).automation.pauseReason).toBe("system-lock");
      expect(engine.snapshot.remainingMs).toBe(locked.remainingMs);
      expect(() => engine.command("resume")).toThrow("锁屏");
      expect(engine.systemUnlock().status).toBe("auto-paused");
      expect(engine.inputSample(undefined, false).status).toBe("auto-paused");
      expect(engine.inputSample(0, true).status).toBe("running");
    });

    it.each(["focus", "break"] as const)("clears the locked indicator for a %s round even when its run condition remains unmet", (kind) => {
      const { engine } = create();
      if (kind === "break") engine.command("next");
      else engine.command("start");
      engine.systemLock();
      const idleSeconds = kind === "focus" ? 40 : 0;
      engine.inputSample(idleSeconds, true);

      const unlocked = engine.systemUnlock();
      expect(unlocked.status).toBe("auto-paused");
      expect(unlocked.automation.pauseReason).toBe(kind === "focus" ? "input-away" : "break-condition");
      const waiting = engine.inputSample(idleSeconds, true);
      expect(waiting.status).toBe("auto-paused");
      expect(waiting.automation.pauseReason).not.toBe("system-lock");
      expect(engine.command("resume").status).toBe("running");
    });

    it("shows an unavailable source after unlock and permits an explicit manual fallback", () => {
      const { engine } = create();
      engine.command("start");
      engine.systemLock();
      engine.inputSample(undefined, false);
      expect(engine.systemUnlock().automation.pauseReason).toBe("source-unavailable");
      engine.command("resume");
      expect(engine.inputSample(undefined, false).status).toBe("running");
    });

    it("does not restore a stale screen-lock indicator after a process restart", () => {
      const { engine, clock, store } = create();
      engine.command("start");
      engine.systemLock();
      engine.inputSample(40, true);

      const restored = new TimerEngine(store, clock);
      expect(restored.snapshot.status).toBe("auto-paused");
      expect(restored.snapshot.automation.pauseReason).toBe("core-recovery");
      expect(restored.inputSample(40, true).automation.pauseReason).not.toBe("system-lock");
      expect(restored.command("resume").status).toBe("running");
    });

    it("preserves idle and manual pause locks across screen locking", () => {
      const idle = create();
      expect(idle.engine.systemLock().status).toBe("idle");
      expect(() => idle.engine.command("start")).toThrow("锁屏");
      idle.engine.inputSample(0, true);
      idle.engine.systemUnlock();
      expect(idle.engine.inputSample(0, true).status).toBe("idle");

      const manual = create();
      manual.engine.command("start");
      manual.engine.command("pause");
      expect(manual.engine.systemLock().status).toBe("manual-paused");
      manual.engine.inputSample(0, true);
      manual.engine.systemUnlock();
      const stillPaused = manual.engine.inputSample(0, true);
      expect(stillPaused.status).toBe("manual-paused");
      expect(stillPaused.automation.manualPauseLocked).toBe(true);
    });

    it("clears break preparation and cannot start a waiting break while locked", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      engine.systemLock();
      clock.advance(20_000);
      expect(engine.inputSample(55, true).status).toBe("auto-paused");
      engine.systemUnlock();
      const started = engine.inputSample(55, true);
      expect(started.status).toBe("running");
      expect(started.remainingMs).toBe(waiting.remainingMs);
    });
  });

  describe("storage failure", () => {
    it("freezes safely without another storage access and blocks further mutations", () => {
      const { engine, clock, store } = create();
      engine.command("start");
      clock.advance(1_000);
      store.failSnapshot = true;
      expect(() => engine.inputSample(0, true)).toThrow("snapshot failed");
      const writes = store.snapshotWrites;
      const failed = engine.storageFailure();
      expect(failed.status).toBe("auto-paused");
      expect(failed.automation.pauseReason).toBe("storage-unavailable");
      expect(store.snapshotWrites).toBe(writes);

      clock.advance(20_000);
      expect(engine.snapshot.remainingMs).toBe(failed.remainingMs);
      expect(engine.inputSample(0, true).status).toBe("auto-paused");
      for (const command of ["start", "pause", "resume", "next", "reset"] as const) {
        expect(() => engine.command(command)).toThrow("存储");
      }
      expect(() => engine.applySettings({ theme: "dark" })).toThrow("存储");
      engine.systemSuspend();
      engine.systemLock();
      engine.systemUnlock();
      expect(store.snapshotWrites).toBe(writes);
    });

    it.each(["idle", "manual-paused"] as const)("keeps a %s round unchanged", (status) => {
      const { engine, store } = create();
      if (status === "manual-paused") {
        engine.command("start");
        engine.command("pause");
      }
      const writes = store.snapshotWrites;
      const failed = engine.storageFailure();
      expect(failed.status).toBe(status);
      expect(failed.automation.manualPauseLocked).toBe(status === "manual-paused");
      expect(store.snapshotWrites).toBe(writes);
    });

    it("does not try to commit a round when entering the failure state", () => {
      const { engine, clock, store } = create();
      engine.command("start");
      clock.advance(defaultSettings.focusDurationSeconds * 1000);
      store.failCommit = true;
      expect(engine.storageFailure().status).toBe("auto-paused");
      expect(store.sessions).toHaveLength(0);
    });
  });

  describe("snapshot checkpoints", () => {
    it("shows fresh input changes in idle and manually paused rounds without writing checkpoints", () => {
      const { engine, clock, store } = create();
      const present = engine.inputSample(0, true);
      let writes = store.snapshotWrites;
      for (let sample = 0; sample < 3; sample += 1) {
        clock.advance(1_000);
        expect(engine.inputSample(0, true).revision).toBe(present.revision);
      }
      expect(store.snapshotWrites).toBe(writes);
      const away = engine.inputSample(40, true);
      expect(away.automation.inputPresence).toBe("away");
      expect(away.revision).toBeGreaterThan(present.revision);
      expect(store.snapshotWrites).toBe(writes);
      engine.command("start");
      engine.command("pause");
      writes = store.snapshotWrites;
      clock.advance(1_000);
      const paused = engine.inputSample(40, true);
      expect(store.snapshotWrites).toBe(writes);
      const failed = engine.inputSample(undefined, false);
      expect(failed.automation.inputMonitoringAvailable).toBe(false);
      expect(failed.revision).toBeGreaterThan(paused.revision);
      expect(store.snapshotWrites).toBe(writes);
      expect(engine.inputSample(undefined, false).revision).toBe(failed.revision);
      expect(store.snapshotWrites).toBe(writes);
    });

    it("starts with unknown presence on restart and waits for a fresh sample to explain an automatic pause", () => {
      const { engine, store, clock } = create();
      engine.command("start");
      const paused = engine.inputSample(40);
      expect(paused.automation.pauseReason).toBe("input-away");
      expect(store.snapshot).not.toHaveProperty("automation");

      clock.advance(20_000);
      const restored = new TimerEngine(store, clock);
      expect(restored.snapshot.remainingMs).toBe(paused.remainingMs);
      expect(restored.snapshot.status).toBe("auto-paused");
      expect(restored.snapshot.automation).toMatchObject({ inputPresence: "unknown", pauseReason: "core-recovery" });
      const pauseRevision = restored.snapshot.revision;
      const fresh = restored.inputSample(40);
      expect(fresh.automation.pauseReason).toBe("input-away");
      expect(fresh.revision).toBeGreaterThan(pauseRevision);
      expect(restored.inputSample(0).status).toBe("running");
    });

    it("keeps a system suspension reason after restart without replaying the last observed presence", () => {
      const { engine, store, clock } = create();
      engine.inputSample(0);
      engine.command("start");
      engine.systemSuspend();
      const restored = new TimerEngine(store, clock);
      expect(restored.snapshot.status).toBe("auto-paused");
      expect(restored.snapshot.automation).toMatchObject({ inputPresence: "unknown", pauseReason: "system-suspend" });
    });

    it("continues saving running time every input sample", () => {
      const { engine, clock, store } = create();
      engine.inputSample(0, true);
      engine.command("start");
      const writes = store.snapshotWrites;
      for (let sample = 0; sample < 3; sample += 1) {
        clock.advance(1_000);
        engine.inputSample(0, true);
        expect(store.snapshotWrites).toBe(writes + sample + 1);
        expect(store.snapshot?.remainingMs).toBe(defaultSettings.focusDurationSeconds * 1000 - (sample + 1) * 1_000);
      }
    });
  });

  it("does not turn an idle round or manual pause into an automatic run on suspend", () => {
    const idle = create();
    expect(idle.engine.systemSuspend().status).toBe("idle");
    expect(idle.engine.inputSample(0, true).status).toBe("idle");

    const paused = create();
    paused.engine.command("start");
    paused.engine.command("pause");
    expect(paused.engine.systemSuspend().status).toBe("manual-paused");
    expect(paused.engine.inputSample(0, true).status).toBe("manual-paused");
  });

  it("uses the default six-round sequence and never records skipped focus", () => {
    const { engine, store } = create();
    expect(engine.command("next").round.kind).toBe("short-break");
    const secondFocus = engine.command("next");

    expect(secondFocus.round.kind).toBe("focus");
    expect(secondFocus.round.focusRoundNumber).toBe(2);
    expect(store.sessions).toHaveLength(0);
  });

  it("records exactly one completed focus round and advances to a break", () => {
    const { engine, clock, store } = create();
    engine.command("start");
    clock.advance(defaultSettings.focusDurationSeconds * 1000 + 1);

    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]?.plannedDurationSeconds).toBe(1800);
    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(store.sessions).toHaveLength(1);
  });

  it("counts committed natural completions without counting skipped rounds", () => {
    const { engine, clock } = create();
    expect(engine.completedRoundsRevision).toBe(0);
    engine.command("next");
    expect(engine.completedRoundsRevision).toBe(0);
    engine.command("start");
    clock.advance(defaultSettings.shortBreakDurationSeconds * 1000);
    expect(engine.snapshot.round.kind).toBe("focus");
    expect(engine.completedRoundsRevision).toBe(1);
    engine.command("start");
    clock.advance(defaultSettings.focusDurationSeconds * 1000);
    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(engine.completedRoundsRevision).toBe(2);
  });

  describe("committed completion metadata", () => {
    it.each([
      { completedKind: "focus", skippedRounds: 0, nextKind: "short-break" },
      { completedKind: "short-break", skippedRounds: 1, nextKind: "focus" },
      { completedKind: "focus", skippedRounds: 4, nextKind: "long-break" },
      { completedKind: "long-break", skippedRounds: 5, nextKind: "focus" },
    ] as const)("publishes $completedKind → $nextKind only after natural completion", ({ completedKind, skippedRounds, nextKind }) => {
      const { engine, clock, store } = create();
      for (let round = 0; round < skippedRounds; round += 1) engine.command("next");
      const duration = engine.snapshot.remainingMs;
      engine.command("start");
      clock.advance(duration);

      expect(engine.completedRound).toBeUndefined();
      expect(engine.completedRoundsRevision).toBe(0);
      expect(store.sessions).toHaveLength(0);
      expect(engine.snapshot.round.kind).toBe(nextKind);
      expect(engine.completedRound).toEqual({
        revision: 1,
        completedKind,
        nextKind,
        completedAt: clock.date.toISOString(),
      });
      if (completedKind === "focus") expect(engine.completedRound?.completedAt).toBe(store.sessions[0]?.completedAt);
      expect(engine.completedRound).not.toBe(engine.completedRound);
      expect(store.snapshot).not.toHaveProperty("completedRound");
    });

    it("keeps the latest committed metadata through skip and reset without creating new completions", () => {
      const { engine, clock } = create();
      engine.command("next");
      engine.command("reset");
      expect(engine.completedRound).toBeUndefined();
      expect(engine.completedRoundsRevision).toBe(0);

      engine.command("start");
      clock.advance(defaultSettings.shortBreakDurationSeconds * 1000);
      expect(engine.snapshot.round.kind).toBe("focus");
      const completion = engine.completedRound;
      expect(completion).toBeDefined();
      engine.command("next");
      engine.command("reset");
      expect(engine.completedRound).toEqual(completion);
      expect(engine.completedRoundsRevision).toBe(1);
    });

    it("does not recover completion metadata or count offline time after restart", () => {
      const { engine, clock, store } = create();
      engine.command("start");
      clock.advance(defaultSettings.focusDurationSeconds * 1000);
      expect(engine.snapshot.round.kind).toBe("short-break");
      expect(engine.completedRound?.revision).toBe(1);
      engine.command("start");
      clock.advance(defaultSettings.shortBreakDurationSeconds * 1000);

      const restored = new TimerEngine(store, clock);
      expect(restored.snapshot.round.kind).toBe("short-break");
      expect(restored.snapshot.status).toBe("auto-paused");
      expect(restored.completedRound).toBeUndefined();
      expect(restored.completedRoundsRevision).toBe(0);
    });

    it.each([
      { completedKind: "focus", skippedRounds: 0, failure: "failCommit", message: "commit failed" },
      { completedKind: "short-break", skippedRounds: 1, failure: "failSnapshot", message: "snapshot failed" },
      { completedKind: "long-break", skippedRounds: 5, failure: "failSnapshot", message: "snapshot failed" },
    ] as const)("publishes a failed $completedKind completion exactly once after a successful retry", ({ completedKind, skippedRounds, failure, message }) => {
      const { engine, clock, store } = create();
      for (let round = 0; round < skippedRounds; round += 1) engine.command("next");
      const duration = engine.snapshot.remainingMs;
      engine.command("start");
      store[failure] = true;
      clock.advance(duration);

      expect(() => engine.snapshot).toThrow(message);
      expect(engine.completedRound).toBeUndefined();
      expect(engine.completedRoundsRevision).toBe(0);
      expect(store.sessions).toHaveLength(0);
      expect(store.snapshot?.round.kind).toBe(completedKind);

      store[failure] = false;
      const nextKind = engine.snapshot.round.kind;
      const completion = { revision: 1, completedKind, nextKind, completedAt: clock.date.toISOString() };
      expect(engine.completedRound).toEqual(completion);
      expect(engine.completedRoundsRevision).toBe(1);
      expect(engine.snapshot.round.kind).toBe(nextKind);
      expect(engine.completedRound).toEqual(completion);
      expect(engine.completedRoundsRevision).toBe(1);
      expect(store.sessions).toHaveLength(completedKind === "focus" ? 1 : 0);
    });

    it("retains the previous completion while the next completion cannot be persisted", () => {
      const { engine, clock, store } = create();
      engine.command("start");
      clock.advance(defaultSettings.focusDurationSeconds * 1000);
      expect(engine.snapshot.round.kind).toBe("short-break");
      const firstCompletion = engine.completedRound;
      engine.command("start");
      clock.advance(defaultSettings.shortBreakDurationSeconds * 1000);
      store.failSnapshot = true;

      expect(() => engine.snapshot).toThrow("snapshot failed");
      expect(engine.completedRound).toEqual(firstCompletion);
      expect(engine.completedRoundsRevision).toBe(1);
      store.failSnapshot = false;
      expect(engine.snapshot.round.kind).toBe("focus");
      expect(engine.completedRound).toMatchObject({ revision: 2, completedKind: "short-break", nextKind: "focus" });
      expect(engine.completedRoundsRevision).toBe(2);
    });
  });

  it("finishes focus into a full automatically paused break without counting waiting time", () => {
    const { engine, clock } = create();
    engine.command("start");
    clock.advance(defaultSettings.focusDurationSeconds * 1000);

    const waiting = structuredClone(engine.snapshot);
    expect(waiting.round.kind).toBe("short-break");
    expect(waiting.status).toBe("auto-paused");
    expect(waiting.automation.pauseReason).toBe("break-condition");
    expect(waiting.remainingMs).toBe(defaultSettings.shortBreakDurationSeconds * 1000);

    clock.advance(20_000);
    expect(engine.snapshot.remainingMs).toBe(waiting.remainingMs);
    expect(engine.inputSample(0, true).status).toBe("auto-paused");
  });

  it("starts a waiting break only when the configured system-idle threshold is reached", () => {
    const { engine, clock } = create();
    engine.applySettings({ inputIdleThresholdSeconds: 75 });
    engine.command("start");
    clock.advance(defaultSettings.focusDurationSeconds * 1000);
    expect(engine.snapshot.status).toBe("auto-paused");

    expect(engine.inputSample(74, true).status).toBe("auto-paused");
    const started = engine.inputSample(75, true);
    expect(started.status).toBe("running");
    expect(started.automation.pauseReason).toBe("none");
    expect(started.remainingMs).toBe(defaultSettings.shortBreakDurationSeconds * 1000);

    clock.advance(1_000);
    expect(engine.snapshot.remainingMs).toBe(defaultSettings.shortBreakDurationSeconds * 1000 - 1_000);
  });

  describe("visible input break preparation", () => {
    it.each(["active", "desk"] as const)("shows ten to one without consuming any %s break time", (breakMode) => {
      const { engine, clock } = create();
      engine.applySettings({ defaultBreakMode: breakMode });
      const waiting = engine.command("next");
      expect(waiting.automation.breakPreparation).toBeNull();
      expect(engine.inputSample(0).automation.breakPreparation).toEqual({ remainingSeconds: 40, countdown: false });
      expect(engine.inputSample(29).automation.breakPreparation).toEqual({ remainingSeconds: 11, countdown: false });
      for (let idleSeconds = 30; idleSeconds < 40; idleSeconds += 1) {
        clock.advance(1_000);
        const preparing = engine.inputSample(idleSeconds);
        expect(preparing.status).toBe("auto-paused");
        expect(preparing.remainingMs).toBe(waiting.remainingMs);
        expect(preparing.automation.breakPreparation).toEqual({ remainingSeconds: 40 - idleSeconds, countdown: true });
      }
      const started = observeIdle(engine, clock, 40, 40);
      expect(started.status).toBe("running");
      expect(started.remainingMs).toBe(waiting.remainingMs);
      expect(started.automation.breakPreparation).toBeNull();
      expect(observeIdle(engine, clock, 41, 41).remainingMs).toBe(waiting.remainingMs - 1_000);
    });

    it("restarts the full preparation window on input without deducting preparation time", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      const reset = engine.inputSample(0);
      expect(reset.automation.breakPreparation).toEqual({ remainingSeconds: 40, countdown: false });
      expect(reset.remainingMs).toBe(waiting.remainingMs);
      const started = observeIdle(engine, clock, 1, 40);
      expect(started.remainingMs).toBe(waiting.remainingMs);
      expect(started.status).toBe("running");
    });

    it("allows automatic input-based rest after a user pause instead of retaining a manual lock", () => {
      const { engine, clock } = create();
      engine.command("next");
      engine.inputSample(40);
      clock.advance(5_000);
      const paused = engine.command("pause");
      expect(paused.status).toBe("auto-paused");
      expect(paused.automation.manualPauseLocked).toBe(false);
      clock.advance(20_000);
      expect(engine.inputSample(0).remainingMs).toBe(paused.remainingMs);
      expect(engine.inputSample(0).automation.breakPreparation?.remainingSeconds).toBe(40);
      const resumed = engine.inputSample(40);
      expect(resumed.status).toBe("running");
      expect(resumed.remainingMs).toBe(paused.remainingMs);
    });

    it.each(["input", "camera"] as const)("accepts pause while a %s break is already waiting without locking automation", (focusPresenceSource) => {
      const { engine } = create();
      engine.applySettings({ focusPresenceSource });
      const waiting = engine.command("next");
      const paused = engine.command("pause");
      expect(paused.status).toBe("auto-paused");
      expect(paused.automation.manualPauseLocked).toBe(false);
      expect(paused.remainingMs).toBe(waiting.remainingMs);
      const resumed = focusPresenceSource === "camera" ? engine.cameraSample("away") : engine.inputSample(40);
      expect(resumed.status).toBe("running");
    });

    it("does not reject or lock a break when pause races with the preceding focus completion", () => {
      const { engine, clock, store } = create();
      engine.command("start");
      clock.advance(defaultSettings.focusDurationSeconds * 1000 - 1);
      expect(engine.snapshot.remainingMs).toBe(1);
      clock.advance(1);
      const afterPause = engine.command("pause");
      expect(afterPause.round.kind).toBe("short-break");
      expect(afterPause.remainingMs).toBe(defaultSettings.shortBreakDurationSeconds * 1000);
      expect(afterPause.status).toBe("auto-paused");
      expect(afterPause.automation.manualPauseLocked).toBe(false);
      expect(store.sessions).toHaveLength(1);
      expect(engine.inputSample(40).status).toBe("running");
    });

    it("normalizes a legacy manually paused break on restart", () => {
      const { engine, clock, store } = create();
      engine.command("next");
      store.snapshot = { ...store.snapshot!, status: "manual-paused", remainingMs: 120_000 };
      const restored = new TimerEngine(store, clock);
      expect(restored.snapshot.status).toBe("auto-paused");
      expect(restored.snapshot.automation.manualPauseLocked).toBe(false);
      expect(restored.inputSample(40).status).toBe("running");
      expect(restored.snapshot.remainingMs).toBe(120_000);
    });

    it("exposes preparation changes without persisting sample fields or writing unchanged checkpoints", () => {
      const { engine, store } = create();
      engine.command("next");
      const writes = store.snapshotWrites;
      const first = engine.inputSample(30);
      const next = engine.inputSample(31);
      expect(next.revision).toBeGreaterThan(first.revision);
      expect(next.automation.breakPreparation).toEqual({ remainingSeconds: 9, countdown: true });
      expect(engine.inputSample(31).revision).toBe(next.revision);
      expect(store.snapshotWrites).toBe(writes);
      expect(store.snapshot).not.toHaveProperty("automation");
      expect(store.snapshot).not.toHaveProperty("breakPreparation");
    });

    it.each([10, 75, 600])("uses the configured %s-second idle threshold and begins from full break duration", (threshold) => {
      const { engine, clock } = create();
      engine.applySettings({ inputIdleThresholdSeconds: threshold });
      const waiting = engine.command("next");
      if (threshold > 10) expect(engine.inputSample(threshold - 11).automation.breakPreparation).toEqual({ remainingSeconds: 11, countdown: false });
      expect(observeIdle(engine, clock, threshold - 10, threshold - 1).automation.breakPreparation).toEqual({ remainingSeconds: 1, countdown: true });
      expect(observeIdle(engine, clock, threshold, threshold).remainingMs).toBe(waiting.remainingMs);
    });

    it("does not show preparation during focus, camera active breaks or running breaks", () => {
      const { engine } = create();
      expect(engine.inputSample(30).automation.breakPreparation).toBeNull();
      engine.applySettings({ focusPresenceSource: "camera" });
      engine.command("next");
      expect(engine.inputSample(30).automation.breakPreparation).toBeNull();
      expect(engine.cameraSample("away").automation.breakPreparation).toBeNull();
    });

    it.each(["input failure", "suspend", "lock", "restart", "threshold change", "source change"] as const)("clears preparation after %s until a valid sample", (interruption) => {
      const initial = create();
      let engine = initial.engine;
      engine.command("next");
      expect(engine.inputSample(35).automation.breakPreparation?.remainingSeconds).toBe(5);
      if (interruption === "input failure") engine.inputSample(undefined, false);
      else if (interruption === "suspend") engine.systemSuspend();
      else if (interruption === "lock") engine.systemLock();
      else if (interruption === "restart") engine = new TimerEngine(initial.store, initial.clock);
      else if (interruption === "threshold change") engine.applySettings({ inputIdleThresholdSeconds: 75 });
      else engine.applySettings({ focusPresenceSource: "camera" });
      expect(engine.snapshot.automation.breakPreparation).toBeNull();
      if (interruption === "lock") {
        expect(engine.inputSample(35).automation.breakPreparation).toBeNull();
        engine.systemUnlock();
      }
      if (interruption === "source change") expect(engine.cameraSample("away").status).toBe("running");
      else expect(engine.inputSample(interruption === "threshold change" ? 75 : 40).status).toBe("running");
    });

    it("does not deduct idle preparation even if samples are delayed for a minute", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      engine.inputSample(30);
      clock.advance(60_000);
      expect(engine.inputSample(90).remainingMs).toBe(waiting.remainingMs);
    });

    it("rejoins automatic break preparation after resetting a break", () => {
      const { engine } = create();
      engine.command("next");
      engine.inputSample(35);
      const reset = engine.command("reset");
      expect(reset.remainingMs).toBe(defaultSettings.shortBreakDurationSeconds * 1000);
      expect(reset.automation.breakPreparation).toBeNull();
      expect(engine.inputSample(39).automation.breakPreparation).toEqual({ remainingSeconds: 1, countdown: true });
      expect(engine.inputSample(40).status).toBe("running");
    });

    it("preserves a preparation indication across unrelated appearance changes", () => {
      const { engine } = create();
      engine.command("next");
      engine.inputSample(35);
      engine.applySettings({ theme: "dark" });
      expect(engine.snapshot.automation.breakPreparation).toEqual({ remainingSeconds: 5, countdown: true });
    });

    it("resumes only the remaining break time after the preparation window", () => {
      const { engine, clock, store } = create();
      engine.command("next");
      engine.inputSample(40);
      clock.advance(defaultSettings.shortBreakDurationSeconds * 1000 - 5_000);
      expect(engine.inputSample(0).remainingMs).toBe(5_000);
      const resumed = observeIdle(engine, clock, 30, 40);
      expect(resumed.round.kind).toBe("short-break");
      expect(resumed.status).toBe("running");
      expect(resumed.remainingMs).toBe(5_000);
      clock.advance(5_000);
      expect(engine.snapshot.round.kind).toBe("focus");
      expect(engine.snapshot.status).toBe("idle");
      expect(store.sessions).toHaveLength(0);
    });
  });

  it("keeps a changed cycle length for the next cycle across restart", () => {
    const first = create();
    first.engine.command("start");
    first.clock.advance(defaultSettings.focusDurationSeconds * 1000 + 1);
    expect(first.engine.snapshot.round.kind).toBe("short-break");
    first.engine.applySettings({ focusRoundsPerCycle: 1 });

    const restored = new TimerEngine(first.store, first.clock);
    expect(restored.snapshot.activeCycleRounds).toBe(3);
    restored.command("next");
    restored.command("next");
    restored.command("next");
    restored.command("next");
    expect(restored.snapshot.round.kind).toBe("long-break");
    restored.command("next");
    expect(restored.snapshot.round.kind).toBe("focus");
    expect(restored.snapshot.round.focusRoundNumber).toBe(1);
    expect(restored.snapshot.activeCycleRounds).toBe(1);
  });

  it("applies a one-minute focus to the next round and completes once after sixty active seconds", () => {
    const { engine, clock, store } = create();
    engine.command("start");
    clock.advance(5_000);
    engine.applySettings({ focusDurationSeconds: 60 });
    expect(engine.snapshot.round.totalDurationMs).toBe(defaultSettings.focusDurationSeconds * 1000);
    expect(engine.snapshot.remainingMs).toBe(defaultSettings.focusDurationSeconds * 1000 - 5_000);

    engine.command("next");
    const nextFocus = engine.command("next");
    expect(nextFocus.round.kind).toBe("focus");
    expect(nextFocus.remainingMs).toBe(60_000);
    expect(nextFocus.round.totalDurationMs).toBe(60_000);
    engine.command("start");
    clock.advance(20_000);
    expect(engine.command("pause").remainingMs).toBe(40_000);
    clock.advance(60_000);
    expect(engine.inputSample(0).remainingMs).toBe(40_000);
    expect(engine.snapshot.status).toBe("manual-paused");
    engine.command("resume");
    clock.advance(39_999);
    expect(engine.snapshot.remainingMs).toBe(1);
    expect(store.sessions).toHaveLength(0);
    clock.advance(1);
    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({ plannedDurationSeconds: 60, activeDurationSeconds: 60 });
    expect(engine.completedRoundsRevision).toBe(1);
    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(store.sessions).toHaveLength(1);
    expect(engine.completedRoundsRevision).toBe(1);
  });

  it("restores a running snapshot as a safe automatic pause", () => {
    const first = create();
    first.engine.command("start");
    const restored = new TimerEngine(first.store, first.clock);

    expect(restored.snapshot.status).toBe("auto-paused");
    expect(restored.snapshot.automation.pauseReason).toBe("core-recovery");
  });

  it("commits a completion and the next snapshot as one operation", () => {
    const { engine, clock, store } = create();
    engine.command("start");
    store.failCommit = true;
    clock.advance(defaultSettings.focusDurationSeconds * 1000 + 1);

    expect(() => engine.snapshot).toThrow("commit failed");
    expect(engine.completedRoundsRevision).toBe(0);
    expect(store.sessions).toHaveLength(0);
    expect(store.snapshot?.round.kind).toBe("focus");
    store.failCommit = false;
    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(store.sessions).toHaveLength(1);
    expect(engine.completedRoundsRevision).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
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
  snapshot?: TimerSnapshot;
  settings = defaultSettings;
  sessions: CompletedSession[] = [];
  failCommit = false;
  failSnapshot = false;
  snapshotWrites = 0;

  loadSnapshot(): TimerSnapshot | undefined {
    return this.snapshot;
  }

  loadSettings() {
    return this.settings;
  }

  saveSnapshot(snapshot: TimerSnapshot): void {
    this.snapshotWrites += 1;
    if (this.failSnapshot) throw new Error("snapshot failed");
    this.snapshot = structuredClone(snapshot);
  }

  saveSettings(settings: typeof defaultSettings): void {
    this.settings = structuredClone(settings);
  }

  commitCompletedSessionAndSnapshot(session: CompletedSession, snapshot: TimerSnapshot): void {
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

    it("discards break pre-counting and cannot start a waiting break while locked", () => {
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
    it("skips unchanged idle and manually paused samples but saves presence and availability changes", () => {
      const { engine, clock, store } = create();
      engine.inputSample(0, true);
      let writes = store.snapshotWrites;
      for (let sample = 0; sample < 3; sample += 1) {
        clock.advance(1_000);
        engine.inputSample(0, true);
      }
      expect(store.snapshotWrites).toBe(writes);
      engine.inputSample(40, true);
      expect(store.snapshotWrites).toBe(writes + 1);
      engine.command("start");
      engine.command("pause");
      writes = store.snapshotWrites;
      clock.advance(1_000);
      engine.inputSample(40, true);
      expect(store.snapshotWrites).toBe(writes);
      engine.inputSample(undefined, false);
      expect(store.snapshotWrites).toBe(writes + 1);
      engine.inputSample(undefined, false);
      expect(store.snapshotWrites).toBe(writes + 1);
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

  it("keeps a manually paused break locked when system input meets the automatic condition", () => {
    const { engine, clock } = create();
    engine.command("next");
    expect(engine.inputSample(defaultSettings.inputIdleThresholdSeconds, true).status).toBe("running");
    const paused = engine.command("pause");

    clock.advance(20_000);
    const stillPaused = engine.inputSample(defaultSettings.inputIdleThresholdSeconds + 100, true);
    expect(stillPaused.status).toBe("manual-paused");
    expect(stillPaused.automation.manualPauseLocked).toBe(true);
    expect(stillPaused.remainingMs).toBe(paused.remainingMs);
    expect(engine.command("resume").status).toBe("running");
  });

  describe("confirmed break countdown", () => {
    it.each(["active", "desk"] as const)("confirms the preceding ten seconds once for a %s break", (breakMode) => {
      const { engine, clock } = create();
      engine.applySettings({ defaultBreakMode: breakMode });
      const waiting = engine.command("next");
      expect(waiting.round.breakMode).toBe(breakMode);
      expect(engine.inputSample(29, true).remainingMs).toBe(waiting.remainingMs);

      for (let idleSeconds = 30; idleSeconds < 40; idleSeconds += 1) {
        clock.advance(1_000);
        const pending = engine.inputSample(idleSeconds, true);
        expect(pending.status).toBe("auto-paused");
        expect(pending.remainingMs).toBe(waiting.remainingMs);
      }

      const confirmed = observeIdle(engine, clock, 40, 40);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs - 10_000);
      expect(engine.inputSample(40, true).remainingMs).toBe(confirmed.remainingMs);
      expect(observeIdle(engine, clock, 41, 41).remainingMs).toBe(waiting.remainingMs - 11_000);
    });

    it("discards the unconfirmed countdown when input resumes at 35 seconds", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      expect(engine.inputSample(0, true).remainingMs).toBe(waiting.remainingMs);

      const confirmed = observeIdle(engine, clock, 1, 40);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs - 10_000);
    });

    it("does not carry a countdown across input hidden by a delayed sample", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);

      clock.advance(60_000);
      const confirmed = engine.inputSample(45, true);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs);
    });

    it("caps the confirmed countdown at ten seconds after delayed continuous inactivity", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      engine.inputSample(30, true);

      clock.advance(60_000);
      const confirmed = engine.inputSample(90, true);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs - 10_000);
    });

    it("only confirms time observed after entering the current break", () => {
      const { engine, clock } = create();
      engine.command("start");
      observeIdle(engine, clock, 30, 39);
      const waiting = engine.command("next");
      engine.inputSample(39, true);

      const confirmed = observeIdle(engine, clock, 40, 40);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs - 1_000);
    });

    it.each(["start", "resume"] as const)("discards the pending countdown on manual %s and preserves the pause lock", (command) => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      expect(engine.command(command).remainingMs).toBe(waiting.remainingMs);
      engine.command("pause");

      const paused = observeIdle(engine, clock, 36, 45);
      expect(paused.status).toBe("manual-paused");
      expect(paused.remainingMs).toBe(waiting.remainingMs);
      expect(engine.command("resume").remainingMs).toBe(waiting.remainingMs);
      expect(engine.inputSample(45, true).remainingMs).toBe(waiting.remainingMs);
    });

    it("discards the pending countdown on reset without automatically starting the idle round", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      expect(engine.command("reset").remainingMs).toBe(waiting.remainingMs);

      const idle = observeIdle(engine, clock, 36, 40);
      expect(idle.status).toBe("idle");
      expect(idle.remainingMs).toBe(waiting.remainingMs);
      expect(engine.command("start").remainingMs).toBe(waiting.remainingMs);
    });

    it("does not carry an unconfirmed countdown into a later break", () => {
      const { engine, clock } = create();
      engine.command("next");
      observeIdle(engine, clock, 30, 35);
      expect(engine.command("next").status).toBe("idle");
      const waiting = engine.command("next");

      const confirmed = engine.inputSample(40, true);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs);
    });

    it.each(["input failure", "suspend", "restart"] as const)("discards an unconfirmed countdown after %s", (interruption) => {
      const { engine: originalEngine, clock, store } = create();
      let engine = originalEngine;
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      if (interruption === "input failure") engine.inputSample(undefined, false);
      else if (interruption === "suspend") engine.systemSuspend();
      else engine = new TimerEngine(store, clock);

      clock.advance(20_000);
      const confirmed = engine.inputSample(55, true);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs);
    });

    it("uses a fresh pending interval after the idle threshold changes", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      engine.applySettings({ inputIdleThresholdSeconds: 75 });
      clock.advance(40_000);

      const confirmed = engine.inputSample(75, true);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs);
    });

    it.each([75, 600])("applies the pending interval relative to a configured threshold of %s seconds", (threshold) => {
      const { engine, clock } = create();
      engine.applySettings({ inputIdleThresholdSeconds: threshold });
      const waiting = engine.command("next");
      expect(observeIdle(engine, clock, threshold - 10, threshold - 1).remainingMs).toBe(waiting.remainingMs);
      expect(observeIdle(engine, clock, threshold, threshold).remainingMs).toBe(waiting.remainingMs - 10_000);
    });

    it("waits for ten continuous idle seconds at the minimum threshold despite repeated active input", () => {
      const { engine, clock } = create();
      engine.applySettings({ inputIdleThresholdSeconds: 10 });
      const waiting = engine.command("next");

      for (let sample = 0; sample < 20; sample += 1) {
        clock.advance(1_000);
        const activeInput = engine.inputSample(0, true);
        expect(activeInput.status).toBe("auto-paused");
        expect(activeInput.remainingMs).toBe(waiting.remainingMs);
      }

      const pending = observeIdle(engine, clock, 1, 9);
      expect(pending.status).toBe("auto-paused");
      expect(pending.remainingMs).toBe(waiting.remainingMs);
      const confirmed = observeIdle(engine, clock, 10, 10);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs - 10_000);
    });

    it("preserves the pending countdown while changing the theme", () => {
      const { engine, clock } = create();
      const waiting = engine.command("next");
      observeIdle(engine, clock, 30, 35);
      engine.applySettings({ theme: "dark" });

      const confirmed = observeIdle(engine, clock, 36, 40);
      expect(confirmed.status).toBe("running");
      expect(confirmed.remainingMs).toBe(waiting.remainingMs - 10_000);
    });

    it("finishes only the current break when the confirmed interval exceeds its remaining time", () => {
      const { engine, clock, store } = create();
      engine.command("next");
      engine.inputSample(40, true);
      clock.advance(defaultSettings.shortBreakDurationSeconds * 1000 - 5_000);
      const paused = engine.inputSample(0, true);
      expect(paused.remainingMs).toBe(5_000);

      const nextFocus = observeIdle(engine, clock, 30, 40);
      expect(nextFocus.round.kind).toBe("focus");
      expect(nextFocus.status).toBe("idle");
      expect(nextFocus.remainingMs).toBe(defaultSettings.focusDurationSeconds * 1000);
      expect(observeIdle(engine, clock, 41, 42).remainingMs).toBe(nextFocus.remainingMs);
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

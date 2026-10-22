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

  loadSnapshot(): TimerSnapshot | undefined {
    return this.snapshot;
  }

  loadSettings() {
    return this.settings;
  }

  saveSnapshot(snapshot: TimerSnapshot): void {
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
    expect(store.sessions).toHaveLength(0);
    expect(store.snapshot?.round.kind).toBe("focus");
    store.failCommit = false;
    expect(engine.snapshot.round.kind).toBe("short-break");
    expect(store.sessions).toHaveLength(1);
  });
});

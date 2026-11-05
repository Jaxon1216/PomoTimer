import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { timerSnapshotSchema } from "../shared/contracts.js";
import { checkpointOf } from "./checkpoint.js";
import { defaultSettings, TimerEngine, type CompletedSession } from "./timer.js";
import { rebuildSqliteStore, SqliteStore, StoreRecoveryError } from "./store.js";

const legacySchema = `
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_utc TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
  CREATE TABLE timer_snapshot (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, checkpointed_at_utc TEXT NOT NULL);
  CREATE TABLE completed_focus_sessions (id TEXT PRIMARY KEY, completed_at_utc TEXT NOT NULL, local_date TEXT NOT NULL, local_offset_minutes INTEGER NOT NULL, cycle_number INTEGER NOT NULL, focus_round_number INTEGER NOT NULL, planned_duration_seconds INTEGER NOT NULL, active_duration_seconds INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('seated','standing')));
`;

const initialSnapshot = () => timerSnapshotSchema.parse({
  revision: 0, emittedAt: "2026-10-22T00:00:00.000Z", activeCycleRounds: 3,
  status: "idle", remainingMs: 1_800_000,
  round: { kind: "focus", cycleNumber: 1, positionInCycle: 1, focusRoundNumber: 1, breakMode: null, totalDurationMs: 1_800_000 },
  automation: { activePresenceSource: "input", inputPresence: "unknown", cameraPresence: "unknown", inputMonitoringAvailable: true, cameraMonitoringAvailable: false, manualPauseLocked: false, pauseReason: "none" },
});

const session = (id: string): CompletedSession => ({
  id, completedAt: "2026-10-22T00:30:00.000Z", localDate: "2026-10-22", localOffsetMinutes: 480,
  cycleNumber: 1, focusRoundNumber: 1, plannedDurationSeconds: 1800, activeDurationSeconds: 1800, mode: "seated",
});

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pomodoro-store-test-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function captureRecovery(run: () => unknown): StoreRecoveryError {
  let failure: unknown;
  try { run(); } catch (error) { failure = error; }
  assert.ok(failure instanceof StoreRecoveryError);
  return failure;
}

function backupContents(directory: string): Record<string, Buffer> {
  return Object.fromEntries(readdirSync(directory).map((file) => [file, readFileSync(join(directory, file))]));
}

test("upgrades the original four-table schema without changing its checksum or existing records", () => withDirectory((directory) => {
  const legacy = new Database(join(directory, "pomodoro.sqlite"));
  legacy.exec(legacySchema);
  legacy.prepare("INSERT INTO schema_migrations VALUES(1,?,?)").run("phase0-initial-schema-v1", "2025-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO settings VALUES('settings',?,?)").run(JSON.stringify({ ...defaultSettings, theme: "dark" }), "2025-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO completed_focus_sessions VALUES(?,?,?,?,?,?,?,?,?)").run("legacy-go-session", "2026-10-22T00:30:00.000Z", "2026-10-22", 480, 1, 1, 1800, 1800, "seated");
  const previous = initialSnapshot();
  delete previous.activeCycleRounds; // Version 1 predates the per-cycle round count.
  previous.automation.inputPresence = "present";
  legacy.prepare("INSERT INTO timer_snapshot VALUES(1,1,0,?,?)").run(JSON.stringify(previous), "2025-01-01T00:00:00.000Z");
  legacy.close();
  const store = new SqliteStore(directory);
  try {
    assert.equal(store.loadSettings().theme, "dark");
    assert.deepEqual(new TimerEngine(store, { now: () => 0, wallDate: () => new Date(0) }).snapshot, initialSnapshot());
    assert.deepEqual(store.dailyTotals("2026-10-22", "2026-10-22"), [{ localDate: "2026-10-22", completedFocusMinutes: 30, completedFocusRounds: 1 }]);
  } finally { store.close(); }
  const migrated = new Database(join(directory, "pomodoro.sqlite"));
  try {
    assert.deepEqual(migrated.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all(), [
      { version: 1, checksum: "phase0-initial-schema-v1" },
      { version: 2, checksum: "electron-sqlite-v2-compatible" },
      { version: 3, checksum: "electron-sqlite-v3-timer-state" },
      { version: 4, checksum: "electron-sqlite-v4-private-checkpoint" },
    ]);
    const row = migrated.prepare("SELECT schema_version, snapshot_json FROM timer_snapshot").get() as { schema_version: number; snapshot_json: string };
    assert.equal(row.schema_version, 4);
    assert.doesNotMatch(row.snapshot_json, /automation|inputPresence|cameraPresence|present/);
  } finally { migrated.close(); }
}));

test("new checkpoints, completion transactions, shutdown and recovery copies contain no presence samples", () => withDirectory((directory) => {
  const store = new SqliteStore(directory);
  let now = 0;
  try {
    const engine = new TimerEngine(store, { now: () => now, wallDate: () => new Date(0) });
    engine.command("start");
    assert.equal(engine.inputSample(40).automation.pauseReason, "input-away");
    assert.equal(engine.inputSample(0).automation.inputPresence, "present");
    now += engine.snapshot.remainingMs;
    assert.equal(engine.snapshot.round.kind, "short-break");
    assert.equal(engine.inputSample(40).status, "running");
    engine.systemSuspend(); // Same path as Main's before-quit hook.
    const backup = store.prepareRecovery(new Error("test recovery copy")).backupDirectory;
    assert.ok(backup);
    for (const [name, bytes] of Object.entries(backupContents(backup))) {
      assert.equal(/inputPresence|cameraPresence|inputMonitoringAvailable|input-away|break-condition|"present"|"away"/.test(bytes.toString("latin1")), false, name);
    }
    const recovered = new SqliteStore(directory);
    try {
      const restored = new TimerEngine(recovered, { now: () => now, wallDate: () => new Date(0) });
      assert.equal(restored.snapshot.status, "auto-paused");
      assert.equal(restored.snapshot.automation.inputPresence, "unknown");
      assert.equal(restored.snapshot.automation.pauseReason, "system-suspend");
      assert.equal(recovered.dailyTotals("1969-12-31", "1970-01-01")[0]?.completedFocusRounds, 1);
    } finally { recovered.close(); }
  } finally { store.close(); }
}));

test("retries WAL cleanup on reopening a migrated checkpoint after a reader releases the old pages", () => withDirectory((directory) => {
  const path = join(directory, "pomodoro.sqlite");
  const reader = new Database(path);
  let migrated: SqliteStore | undefined;
  try {
    reader.pragma("journal_mode = WAL");
    reader.exec(legacySchema);
    const oldSnapshot = initialSnapshot();
    oldSnapshot.status = "manual-paused";
    oldSnapshot.automation.manualPauseLocked = true;
    oldSnapshot.automation.inputPresence = "away";
    reader.prepare("INSERT INTO timer_snapshot VALUES(1,3,0,?,?)").run(JSON.stringify(oldSnapshot), oldSnapshot.emittedAt);
    reader.pragma("wal_checkpoint(TRUNCATE)");
    assert.ok(readFileSync(path).includes("inputPresence"));
    reader.exec("BEGIN");
    reader.prepare("SELECT snapshot_json FROM timer_snapshot").get();
    migrated = new SqliteStore(directory);
    assert.deepEqual(migrated.loadSnapshot(), checkpointOf(oldSnapshot));
    assert.ok(readFileSync(path).includes("inputPresence"), "a reader still holds the old page");
    reader.exec("COMMIT");

    // Leave a connection open, so SQLite's automatic last-close checkpoint cannot mask the retry.
    const reopened = new SqliteStore(directory);
    try {
      assert.ok(!readFileSync(path).includes("inputPresence"));
      assert.equal(readFileSync(path + "-wal").length, 0);
      const restored = new TimerEngine(reopened, { now: () => 0, wallDate: () => new Date(0) });
      assert.equal(restored.snapshot.automation.manualPauseLocked, true);
      assert.equal(restored.snapshot.automation.inputPresence, "unknown");
    } finally { reopened.close(); }
  } finally { reader.close(); migrated?.close(); }
}));

test("rolls back the entire migration and backs up originals when a released checksum differs", () => withDirectory((directory) => {
  const legacy = new Database(join(directory, "pomodoro.sqlite"));
  legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_utc TEXT NOT NULL)");
  legacy.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(1, "phase0-initial-schema-v1", "2025-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(3, "unexpected-released-checksum", "2025-01-01T00:00:00.000Z");
  legacy.close();
  const recovery = captureRecovery(() => new SqliteStore(directory));
  assert.match(recovery.message, /迁移校验失败/);
  assert.ok(recovery.backupDirectory);
  assert.ok(existsSync(join(recovery.backupDirectory, "pomodoro.sqlite")));
  const original = new Database(join(directory, "pomodoro.sqlite"));
  try {
    assert.deepEqual(original.prepare("SELECT version FROM schema_migrations ORDER BY version").all(), [{ version: 1 }, { version: 3 }]);
    assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get(), undefined);
  } finally { original.close(); }
}));

test("keeps an unreadable v3 checkpoint and rolls back v4 before offering recovery", () => withDirectory((directory) => {
  const path = join(directory, "pomodoro.sqlite");
  const previous = new Database(path);
  previous.exec(legacySchema);
  previous.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(3, "electron-sqlite-v3-timer-state", "2026-10-22T00:00:00.000Z");
  previous.prepare("INSERT INTO timer_snapshot VALUES(1,3,0,?,?)").run("{broken-json", "2026-10-22T00:00:00.000Z");
  previous.close();
  const recovery = captureRecovery(() => new SqliteStore(directory));
  assert.ok(recovery.backupDirectory);
  assert.match(recovery.message, /快照损坏/);
  const original = new Database(path);
  try {
    assert.deepEqual(original.prepare("SELECT version FROM schema_migrations").all(), [{ version: 3 }]);
    assert.deepEqual(original.prepare("SELECT snapshot_json FROM timer_snapshot").get(), { snapshot_json: "{broken-json" });
  } finally { original.close(); }
}));

test("commits focus and snapshot atomically, deduplicates completion and changes revision only on committed inserts", () => withDirectory((directory) => {
  const store = new SqliteStore(directory);
  try {
    const snapshot = checkpointOf(initialSnapshot());
    store.saveSnapshot(snapshot);
    store.commitCompletedSessionAndSnapshot(session("focus-1-1"), snapshot);
    assert.equal(store.completedSessionsRevision, 1);
    store.commitCompletedSessionAndSnapshot(session("focus-1-1"), snapshot);
    assert.equal(store.completedSessionsRevision, 1);
    const database = new Database(join(directory, "pomodoro.sqlite"));
    database.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON timer_snapshot BEGIN SELECT RAISE(ABORT, 'test snapshot failure'); END");
    database.close();
    assert.throws(() => store.commitCompletedSessionAndSnapshot(session("focus-1-2"), { ...snapshot, revision: 9 }), /test snapshot failure/);
    assert.equal(store.completedSessionsRevision, 1);
    assert.equal(store.dailyTotals("2026-10-22", "2026-10-22")[0]?.completedFocusRounds, 1);
    assert.deepEqual(store.loadSnapshot(), snapshot);
  } finally { store.close(); }
  const reopened = new SqliteStore(directory);
  try { assert.equal(reopened.completedSessionsRevision, 0); } finally { reopened.close(); }
}));

for (const [name, value] of [["invalid JSON", "{broken-json"], ["incompatible schema", "{\"status\":\"unexpected\"}"]] as const) {
  test(`preserves a snapshot with ${name}, closes its connection, and rebuilds only through explicit recovery`, () => withDirectory((directory) => {
    const store = new SqliteStore(directory);
    const database = new Database(join(directory, "pomodoro.sqlite"));
    database.prepare("INSERT INTO timer_snapshot VALUES(1,4,0,?,?)").run(value, "2026-10-22T00:00:00.000Z");
    database.close();
    const recovery = captureRecovery(() => store.loadSnapshot());
    assert.ok(recovery.backupDirectory);
    assert.throws(() => store.saveSnapshot(checkpointOf(initialSnapshot())), /连接已关闭/);
    const backup = backupContents(recovery.backupDirectory);
    assert.equal(readdirSync(directory).filter((file) => file.startsWith("database-archive-")).length, 0);
    const rebuilt = rebuildSqliteStore(recovery);
    try {
      assert.equal(rebuilt.loadSnapshot(), undefined);
      assert.deepEqual(rebuilt.loadSettings(), defaultSettings);
    } finally { rebuilt.close(); }
    const archives = readdirSync(directory).filter((file) => file.startsWith("database-archive-"));
    assert.equal(archives.length, 1);
    const original = new Database(join(directory, archives[0]!, "pomodoro.sqlite"));
    try { assert.deepEqual(original.prepare("SELECT snapshot_json FROM timer_snapshot").get(), { snapshot_json: value }); } finally { original.close(); }
    assert.deepEqual(backupContents(recovery.backupDirectory), backup);
    assert.throws(() => rebuildSqliteStore(recovery), /已经处理/);
  }));
}

test("backs up a corrupt SQLite file byte-for-byte and archives it before constructing a new database", () => withDirectory((directory) => {
  const corrupt = Buffer.from("not a sqlite database; preserve this original byte sequence\n");
  writeFileSync(join(directory, "pomodoro.sqlite"), corrupt);
  const recovery = captureRecovery(() => new SqliteStore(directory));
  assert.ok(recovery.backupDirectory);
  assert.deepEqual(readFileSync(join(recovery.backupDirectory, "pomodoro.sqlite")), corrupt);
  assert.deepEqual(readFileSync(join(directory, "pomodoro.sqlite")), corrupt);
  const rebuilt = rebuildSqliteStore(recovery);
  try { assert.deepEqual(rebuilt.loadSettings(), defaultSettings); } finally { rebuilt.close(); }
  const archive = readdirSync(directory).find((file) => file.startsWith("database-archive-"));
  assert.ok(archive);
  assert.deepEqual(readFileSync(join(directory, archive, "pomodoro.sqlite")), corrupt);
  assert.deepEqual(readFileSync(join(recovery.backupDirectory, "pomodoro.sqlite")), corrupt);
}));

test("copies committed WAL pages and SHM before closing a failed settings reader", () => withDirectory((directory) => {
  const store = new SqliteStore(directory);
  const writer = new Database(join(directory, "pomodoro.sqlite"));
  try {
    writer.pragma("wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO settings VALUES('settings',?,?)").run("{broken-settings", "2026-10-22T00:00:00.000Z");
    const recovery = captureRecovery(() => store.loadSettings());
    assert.ok(recovery.backupDirectory);
    const originals = backupContents(recovery.backupDirectory);
    for (const name of ["pomodoro.sqlite", "pomodoro.sqlite-wal", "pomodoro.sqlite-shm"]) assert.ok(originals[name]?.length);
    withDirectory((copyDirectory) => {
      for (const name of ["pomodoro.sqlite", "pomodoro.sqlite-wal", "pomodoro.sqlite-shm"]) copyFileSync(join(recovery.backupDirectory!, name), join(copyDirectory, name));
      const recovered = new Database(join(copyDirectory, "pomodoro.sqlite"));
      try { assert.deepEqual(recovered.prepare("SELECT value_json FROM settings WHERE key='settings'").get(), { value_json: "{broken-settings" }); } finally { recovered.close(); }
    });
    assert.deepEqual(backupContents(recovery.backupDirectory), originals);
  } finally { writer.close(); store.close(); }
}));

test("refuses rebuilding when the original data cannot be backed up", () => withDirectory((directory) => {
  const blockedDirectory = join(directory, "not-a-directory");
  writeFileSync(blockedDirectory, "preserve this file");
  const recovery = captureRecovery(() => new SqliteStore(blockedDirectory));
  assert.equal(recovery.backupDirectory, undefined);
  assert.match(recovery.message, /备份失败/);
  assert.throws(() => rebuildSqliteStore(recovery), /备份未完成/);
  assert.equal(readFileSync(blockedDirectory, "utf8"), "preserve this file");
}));

test("prepares a single closed recovery result for failures in Main's remaining initialization", () => withDirectory((directory) => {
  const store = new SqliteStore(directory);
  store.saveSnapshot(checkpointOf(initialSnapshot()));
  const failure = new Error("timer initialization failed");
  const recovery = store.prepareRecovery(failure);
  assert.equal(recovery.cause, failure);
  assert.ok(recovery.backupDirectory);
  assert.equal(store.prepareRecovery(new Error("later failure")), recovery);
  assert.equal(readdirSync(directory).filter((file) => file.startsWith("database-backup-")).length, 1);
  assert.throws(() => store.saveSnapshot(checkpointOf(initialSnapshot())), /连接已关闭/);
}));

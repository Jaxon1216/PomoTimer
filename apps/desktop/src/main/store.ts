import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings } from "./timer.js";
import { settingsSchema, timerSnapshotSchema, type Settings, type TimerSnapshot } from "../shared/contracts.js";
import type { CompletedSession, TimerStore } from "./timer.js";

const initialMigrationChecksum = "phase0-initial-schema-v1";
const compatibleMigrationChecksum = "electron-sqlite-v2-compatible";
const migrationChecksum = "electron-sqlite-v3-timer-state";
const snapshotSchemaVersion = 3;

export class SqliteStore implements TimerStore {
  private readonly db: Database.Database;
  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dataDirectory, "pomodoro.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }
  close(): void { this.db.close(); }
  loadSettings(): Settings {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get("settings") as { value_json?: string } | undefined;
    if (!row?.value_json) return defaultSettings;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value_json); } catch { return defaultSettings; }
    const result = settingsSchema.safeParse(parsed);
    return result.success ? result.data : defaultSettings;
  }
  saveSettings(settings: Settings): void {
    this.db.prepare("INSERT INTO settings(key,value_json,updated_at_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_utc=excluded.updated_at_utc").run("settings", JSON.stringify(settings), new Date().toISOString());
  }

  loadSnapshot(): TimerSnapshot | undefined {
    const row = this.db.prepare("SELECT snapshot_json FROM timer_snapshot WHERE singleton = 1").get() as { snapshot_json?: string } | undefined;
    if (!row?.snapshot_json) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(row.snapshot_json); } catch { throw new Error("计时快照损坏"); }
    const result = timerSnapshotSchema.safeParse(parsed);
    if (!result.success) throw new Error("计时快照格式不兼容");
    return result.data;
  }

  saveSnapshot(snapshot: TimerSnapshot): void {
    this.upsertSnapshot(snapshot);
  }

  commitCompletedSessionAndSnapshot(session: CompletedSession, snapshot: TimerSnapshot): void {
    this.db.transaction(() => {
      this.insertCompletedSession(session);
      this.upsertSnapshot(snapshot);
    })();
  }

  dailyTotals(startDate: string, endDate: string): Array<{ localDate: string; completedFocusMinutes: number; completedFocusRounds: number }> { return this.db.prepare("SELECT local_date AS localDate, CAST(SUM(active_duration_seconds) / 60 AS INTEGER) AS completedFocusMinutes, COUNT(*) AS completedFocusRounds FROM completed_focus_sessions WHERE local_date >= ? AND local_date <= ? GROUP BY local_date ORDER BY local_date").all(startDate, endDate) as Array<{ localDate: string; completedFocusMinutes: number; completedFocusRounds: number }>; }
  private migrate(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_utc TEXT NOT NULL)");
      const row = this.db.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum?: string } | undefined;
      if (!row) this.db.prepare("INSERT INTO schema_migrations(version,checksum,applied_at_utc) VALUES(1,?,?)").run(initialMigrationChecksum, new Date().toISOString());
      else if (row.checksum !== initialMigrationChecksum) throw new Error("数据库迁移校验失败");
      this.db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_utc TEXT NOT NULL); CREATE TABLE IF NOT EXISTS timer_snapshot (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, checkpointed_at_utc TEXT NOT NULL); CREATE TABLE IF NOT EXISTS completed_focus_sessions (id TEXT PRIMARY KEY, completed_at_utc TEXT NOT NULL, local_date TEXT NOT NULL, local_offset_minutes INTEGER NOT NULL, cycle_number INTEGER NOT NULL, focus_round_number INTEGER NOT NULL, planned_duration_seconds INTEGER NOT NULL, active_duration_seconds INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('seated','standing'))); CREATE INDEX IF NOT EXISTS completed_focus_sessions_local_date_idx ON completed_focus_sessions(local_date)");
      const current = this.db.prepare("SELECT checksum FROM schema_migrations WHERE version = 2").get() as { checksum?: string } | undefined;
      if (!current) this.db.prepare("INSERT INTO schema_migrations(version,checksum,applied_at_utc) VALUES(2,?,?)").run(compatibleMigrationChecksum, new Date().toISOString());
      else if (current.checksum !== compatibleMigrationChecksum) throw new Error("数据库迁移校验失败");
      const stateMigration = this.db.prepare("SELECT checksum FROM schema_migrations WHERE version = 3").get() as { checksum?: string } | undefined;
      if (!stateMigration) this.db.prepare("INSERT INTO schema_migrations(version,checksum,applied_at_utc) VALUES(3,?,?)").run(migrationChecksum, new Date().toISOString());
      else if (stateMigration.checksum !== migrationChecksum) throw new Error("数据库迁移校验失败");
    });
    migrate();
  }

  private insertCompletedSession(session: CompletedSession): void {
    this.db.prepare("INSERT OR IGNORE INTO completed_focus_sessions(id,completed_at_utc,local_date,local_offset_minutes,cycle_number,focus_round_number,planned_duration_seconds,active_duration_seconds,mode) VALUES(@id,@completedAt,@localDate,@localOffsetMinutes,@cycleNumber,@focusRoundNumber,@plannedDurationSeconds,@activeDurationSeconds,@mode)").run(session);
  }

  private upsertSnapshot(snapshot: TimerSnapshot): void {
    this.db.prepare("INSERT INTO timer_snapshot(singleton,schema_version,revision,snapshot_json,checkpointed_at_utc) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version,revision=excluded.revision,snapshot_json=excluded.snapshot_json,checkpointed_at_utc=excluded.checkpointed_at_utc").run(snapshotSchemaVersion, snapshot.revision, JSON.stringify(snapshot), new Date().toISOString());
  }
}

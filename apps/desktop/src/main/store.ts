import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings } from "./timer.js";
import { settingsSchema, timerSnapshotSchema, type Settings, type TimerSnapshot } from "../shared/contracts.js";
import type { CompletedSession, TimerStore } from "./timer.js";
import { archiveDatabaseForRebuild, backupDatabaseFiles, StoreRecoveryError } from "./store-recovery.js";

export { StoreRecoveryError } from "./store-recovery.js";

const initialMigrationChecksum = "phase0-initial-schema-v1";
const compatibleMigrationChecksum = "electron-sqlite-v2-compatible";
const migrationChecksum = "electron-sqlite-v3-timer-state";
const snapshotSchemaVersion = 3;

// SqliteStore 是 Main 独占的数据库边界，初始化失败时先保留恢复材料。
//
// 领域：SQLite / 持久化与启动恢复
// 顺序：启动链第 2 站，Main -> SqliteStore -> 迁移和 TimerEngine 状态加载。
// 作用：独占读写本地数据，并在不可用时关闭连接和保留原始文件备份。
// 原因：损坏或不兼容的数据不能静默回落到默认值后被新状态覆盖。
// 边界：不访问 Renderer 或 IPC，重建必须由 Main 取得用户明确选择。
export class SqliteStore implements TimerStore {
  private db: Database.Database | undefined;
  private recoveryFailure: StoreRecoveryError | undefined;
  private completedSessionsRevisionValue = 0;

  constructor(private readonly dataDirectory: string) {
    try {
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      this.db = new Database(join(dataDirectory, "pomodoro.sqlite"));
      this.database.pragma("journal_mode = WAL");
      this.migrate();
    } catch (error) {
      this.failInitialization(error);
    }
  }

  get completedSessionsRevision(): number { return this.completedSessionsRevisionValue; }

  private get database(): Database.Database {
    if (!this.db?.open) throw new Error("本地数据库连接已关闭");
    return this.db;
  }

  close(): void { if (this.db?.open) this.db.close(); }

  private failInitialization(error: unknown): never {
    throw this.prepareRecovery(error);
  }

  // 领域：SQLite / 初始化失败
  // 顺序：初始化错误链，Store 读取或 Main 初始化捕获 -> 备份 -> 关闭 -> 恢复信息。
  // 作用：将初始化错误转成包含备份位置的恢复结果，重复调用保持首次结果。
  // 原因：TimerEngine 初始化持久化也可能失败，必须在退出前保留同一份证据。
  // 边界：仅准备恢复材料；备份或关闭失败时禁止重建，不能用于循环重试写入。
  prepareRecovery(error: unknown): StoreRecoveryError {
    if (this.recoveryFailure) return this.recoveryFailure;
    const messages = [error instanceof Error ? error.message : "无法读取本地数据"];
    let backupDirectory: string | undefined;
    try {
      backupDirectory = backupDatabaseFiles(this.dataDirectory);
    } catch (backupError) {
      messages.push(`备份失败，禁止重建：${backupError instanceof Error ? backupError.message : "无法复制数据库"}`);
    } finally {
      try { this.close(); } catch (closeError) {
        messages.push(`关闭数据库失败：${closeError instanceof Error ? closeError.message : "未知错误"}`);
        backupDirectory = undefined;
      }
    }
    this.recoveryFailure = new StoreRecoveryError(messages.join("\n"), this.dataDirectory, backupDirectory, error);
    return this.recoveryFailure;
  }
  loadSettings(): Settings {
    try {
      const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get("settings") as { value_json: string } | undefined;
      if (!row) return defaultSettings;
      return settingsSchema.parse(JSON.parse(row.value_json) as unknown);
    } catch (error) {
      this.failInitialization(error);
    }
  }
  saveSettings(settings: Settings): void {
    this.database.prepare("INSERT INTO settings(key,value_json,updated_at_utc) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at_utc=excluded.updated_at_utc").run("settings", JSON.stringify(settings), new Date().toISOString());
  }

  loadSnapshot(): TimerSnapshot | undefined {
    try {
      const row = this.database.prepare("SELECT snapshot_json FROM timer_snapshot WHERE singleton = 1").get() as { snapshot_json: string } | undefined;
      if (!row) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(row.snapshot_json); } catch { throw new Error("计时快照损坏"); }
      const result = timerSnapshotSchema.safeParse(parsed);
      if (!result.success) throw new Error("计时快照格式不兼容");
      return result.data;
    } catch (error) {
      this.failInitialization(error);
    }
  }

  saveSnapshot(snapshot: TimerSnapshot): void {
    this.upsertSnapshot(snapshot);
  }

  commitCompletedSessionAndSnapshot(session: CompletedSession, snapshot: TimerSnapshot): void {
    const inserted = this.database.transaction(() => {
      const changes = this.insertCompletedSession(session);
      this.upsertSnapshot(snapshot);
      return changes;
    })();
    if (inserted > 0) this.completedSessionsRevisionValue += 1;
  }

  dailyTotals(startDate: string, endDate: string): Array<{ localDate: string; completedFocusMinutes: number; completedFocusRounds: number }> { return this.database.prepare("SELECT local_date AS localDate, CAST(SUM(active_duration_seconds) / 60 AS INTEGER) AS completedFocusMinutes, COUNT(*) AS completedFocusRounds FROM completed_focus_sessions WHERE local_date >= ? AND local_date <= ? GROUP BY local_date ORDER BY local_date").all(startDate, endDate) as Array<{ localDate: string; completedFocusMinutes: number; completedFocusRounds: number }>; }
  private migrate(): void {
    const migrate = this.database.transaction(() => {
      this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_utc TEXT NOT NULL)");
      const row = this.database.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum?: string } | undefined;
      if (!row) this.database.prepare("INSERT INTO schema_migrations(version,checksum,applied_at_utc) VALUES(1,?,?)").run(initialMigrationChecksum, new Date().toISOString());
      else if (row.checksum !== initialMigrationChecksum) throw new Error("数据库迁移校验失败");
      this.database.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_utc TEXT NOT NULL); CREATE TABLE IF NOT EXISTS timer_snapshot (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, checkpointed_at_utc TEXT NOT NULL); CREATE TABLE IF NOT EXISTS completed_focus_sessions (id TEXT PRIMARY KEY, completed_at_utc TEXT NOT NULL, local_date TEXT NOT NULL, local_offset_minutes INTEGER NOT NULL, cycle_number INTEGER NOT NULL, focus_round_number INTEGER NOT NULL, planned_duration_seconds INTEGER NOT NULL, active_duration_seconds INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('seated','standing'))); CREATE INDEX IF NOT EXISTS completed_focus_sessions_local_date_idx ON completed_focus_sessions(local_date)");
      const current = this.database.prepare("SELECT checksum FROM schema_migrations WHERE version = 2").get() as { checksum?: string } | undefined;
      if (!current) this.database.prepare("INSERT INTO schema_migrations(version,checksum,applied_at_utc) VALUES(2,?,?)").run(compatibleMigrationChecksum, new Date().toISOString());
      else if (current.checksum !== compatibleMigrationChecksum) throw new Error("数据库迁移校验失败");
      const stateMigration = this.database.prepare("SELECT checksum FROM schema_migrations WHERE version = 3").get() as { checksum?: string } | undefined;
      if (!stateMigration) this.database.prepare("INSERT INTO schema_migrations(version,checksum,applied_at_utc) VALUES(3,?,?)").run(migrationChecksum, new Date().toISOString());
      else if (stateMigration.checksum !== migrationChecksum) throw new Error("数据库迁移校验失败");
    });
    migrate();
  }

  private insertCompletedSession(session: CompletedSession): number {
    return this.database.prepare("INSERT OR IGNORE INTO completed_focus_sessions(id,completed_at_utc,local_date,local_offset_minutes,cycle_number,focus_round_number,planned_duration_seconds,active_duration_seconds,mode) VALUES(@id,@completedAt,@localDate,@localOffsetMinutes,@cycleNumber,@focusRoundNumber,@plannedDurationSeconds,@activeDurationSeconds,@mode)").run(session).changes;
  }

  private upsertSnapshot(snapshot: TimerSnapshot): void {
    this.database.prepare("INSERT INTO timer_snapshot(singleton,schema_version,revision,snapshot_json,checkpointed_at_utc) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET schema_version=excluded.schema_version,revision=excluded.revision,snapshot_json=excluded.snapshot_json,checkpointed_at_utc=excluded.checkpointed_at_utc").run(snapshotSchemaVersion, snapshot.revision, JSON.stringify(snapshot), new Date().toISOString());
  }
}

// 领域：SQLite / 显式重建
// 顺序：Main 用户确认 -> rebuildSqliteStore -> 原文件归档 -> 新 SqliteStore。
// 作用：保留备份与原文件后创建空数据库，供 Main 重新初始化计时核心。
// 原因：用户选择重建也不能删除原始数据或覆盖首次故障备份。
// 边界：只接受已完成备份的恢复信息，不替代 Main 的用户确认。
export function rebuildSqliteStore(recovery: StoreRecoveryError): SqliteStore {
  archiveDatabaseForRebuild(recovery);
  return new SqliteStore(recovery.dataDirectory);
}

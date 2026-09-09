package store

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const schemaVersion = 1
const schemaChecksum = "phase0-initial-schema-v1"

type Store struct {
	db *sql.DB
}

// Open 在应用数据目录中打开 SQLite，并确保已应用所有已知迁移。
//
// 领域：Go / SQLite
// 顺序：启动链第 6 站：Server.initialize -> Store.Open -> migrate -> loadOrCreateSnapshot。
// 作用：创建私有数据目录、打开数据库、限制为一个连接，并执行迁移。
// 原因：Core 是 SQLite 的唯一所有者；单连接避免本地状态机出现多个并发写入者。
// 边界：只管理数据库连接和 schema，不决定计时状态何时需要保存。
func Open(dataDirectory string) (*Store, error) {
	if dataDirectory == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}

	databasePath := filepath.Join(dataDirectory, "pomodoro.sqlite")
	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)

	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// 领域：Go / SQLite 迁移
// 顺序：启动链内部：Store.Open -> migrate -> schema_migrations -> 可读取快照。
// 作用：在单个事务中创建初始 schema，并记录版本和不可变校验和。
// 原因：事务避免半完成的 schema；校验和防止已发布迁移被静默修改。
// 边界：发布后的 schema 只能新增版本迁移，不能修改这里已记录的初始定义。
func (s *Store) migrate() error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			checksum TEXT NOT NULL,
			applied_at_utc TEXT NOT NULL
		);
	`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	var checksum string
	err = tx.QueryRow(
		"SELECT checksum FROM schema_migrations WHERE version = ?",
		schemaVersion,
	).Scan(&checksum)
	if err == nil {
		if checksum != schemaChecksum {
			return errors.New("migration checksum does not match released schema")
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read migration state: %w", err)
	}

	if _, err := tx.Exec(`
		CREATE TABLE settings (
			key TEXT PRIMARY KEY,
			value_json TEXT NOT NULL,
			updated_at_utc TEXT NOT NULL
		);

		CREATE TABLE timer_snapshot (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			schema_version INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			snapshot_json TEXT NOT NULL,
			checkpointed_at_utc TEXT NOT NULL
		);

		CREATE TABLE completed_focus_sessions (
			id TEXT PRIMARY KEY,
			completed_at_utc TEXT NOT NULL,
			local_date TEXT NOT NULL,
			local_offset_minutes INTEGER NOT NULL,
			cycle_number INTEGER NOT NULL,
			focus_round_number INTEGER NOT NULL,
			planned_duration_seconds INTEGER NOT NULL,
			active_duration_seconds INTEGER NOT NULL,
			mode TEXT NOT NULL CHECK (mode IN ('seated', 'standing'))
		);

		CREATE INDEX completed_focus_sessions_local_date_idx
			ON completed_focus_sessions(local_date);
	`); err != nil {
		return fmt.Errorf("apply initial schema: %w", err)
	}
	if _, err := tx.Exec(
		"INSERT INTO schema_migrations (version, checksum, applied_at_utc) VALUES (?, ?, ?)",
		schemaVersion,
		schemaChecksum,
		time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		return fmt.Errorf("record migration: %w", err)
	}
	return tx.Commit()
}

// 领域：Go / SQLite 快照
// 顺序：启动链第 7 站：loadOrCreateSnapshot -> LoadSnapshot -> SQLite -> 初始化快照。
// 作用：读取唯一持久化快照，供 Core 在初始化时恢复。
// 原因：重启后的计时状态必须来自 Core 之前写入的耐久数据，而不是 Renderer 内存。
// 边界：只读取 JSON 字节；running 状态的恢复策略由 service 包决定。
func (s *Store) LoadSnapshot() ([]byte, bool, error) {
	var snapshot string
	err := s.db.QueryRow(
		"SELECT snapshot_json FROM timer_snapshot WHERE singleton = 1",
	).Scan(&snapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("load snapshot: %w", err)
	}
	return []byte(snapshot), true, nil
}

// SaveSnapshot 以 revision 为条件保存 Core 的唯一持久化计时快照。
//
// 领域：Go / SQLite 快照
// 顺序：命令链末尾：Server.command/currentSnapshot -> persist -> SaveSnapshot -> SQLite。
// 作用：插入首个快照或原子地覆盖 singleton=1 的已有快照。
// 原因：应用重启后只能从这一份 Core 写入的状态恢复，并将 running 状态转为自动暂停。
// 边界：不保存每秒 tick，也不写入 Renderer 的临时显示状态。
func (s *Store) SaveSnapshot(revision int64, snapshot []byte) error {
	_, err := s.db.Exec(`
		INSERT INTO timer_snapshot (
			singleton, schema_version, revision, snapshot_json, checkpointed_at_utc
		) VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(singleton) DO UPDATE SET
			schema_version = excluded.schema_version,
			revision = excluded.revision,
			snapshot_json = excluded.snapshot_json,
			checkpointed_at_utc = excluded.checkpointed_at_utc
	`,
		schemaVersion,
		revision,
		string(snapshot),
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("save snapshot: %w", err)
	}
	return nil
}

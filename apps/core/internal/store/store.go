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

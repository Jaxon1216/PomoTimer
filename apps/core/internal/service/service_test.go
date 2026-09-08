package service

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/easton/pomodoro-timer/core/internal/protocol"
)

func TestInitializeCreatesDefaultSnapshot(t *testing.T) {
	server := NewServer()
	t.Cleanup(func() {
		_ = server.Close()
	})

	result, rpcError := server.Handle(initializeRequest(t.TempDir()))
	if rpcError != nil {
		t.Fatalf("initialize returned RPC error: %#v", rpcError)
	}

	initialized, ok := result.(initializeResult)
	if !ok {
		t.Fatalf("expected initializeResult, got %T", result)
	}
	if initialized.Snapshot.Status != "idle" {
		t.Fatalf("expected idle snapshot, got %q", initialized.Snapshot.Status)
	}
	if initialized.Snapshot.RemainingMs != 1_800_000 {
		t.Fatalf("expected default 30 minute duration, got %d", initialized.Snapshot.RemainingMs)
	}
	if !initialized.Capabilities.InputMonitoring || initialized.Capabilities.CameraPresence {
		t.Fatalf("unexpected capabilities: %#v", initialized.Capabilities)
	}
}

func TestInitializeRejectsUnknownFields(t *testing.T) {
	server := NewServer()
	t.Cleanup(func() {
		_ = server.Close()
	})

	raw := json.RawMessage(`{
		"protocolVersion": 1,
		"instanceId": "test-instance",
		"dataDirectory": "` + t.TempDir() + `",
		"locale": "zh-CN",
		"timeZone": "Asia/Shanghai",
		"unexpected": true
	}`)
	_, rpcError := server.Handle(protocol.Request{
		JSONRPC: "2.0",
		ID:      integerPointer64(1),
		Method:  "core.initialize",
		Params:  raw,
	})
	if rpcError == nil || rpcError.Code != -32602 {
		t.Fatalf("expected INVALID_PARAMS, got %#v", rpcError)
	}
}

func TestRecoveredRunningSnapshotIsPaused(t *testing.T) {
	dataDirectory := t.TempDir()
	server := NewServer()
	result, rpcError := server.Handle(initializeRequest(dataDirectory))
	if rpcError != nil {
		t.Fatalf("first initialize returned error: %#v", rpcError)
	}
	initialized := result.(initializeResult)
	running := initialized.Snapshot
	running.Status = "running"
	running.Revision = 9
	raw, err := json.Marshal(running)
	if err != nil {
		t.Fatalf("marshal running snapshot: %v", err)
	}
	if err := server.store.SaveSnapshot(running.Revision, raw); err != nil {
		t.Fatalf("save running snapshot: %v", err)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("close first server: %v", err)
	}

	recovered := NewServer()
	t.Cleanup(func() {
		_ = recovered.Close()
	})
	result, rpcError = recovered.Handle(initializeRequest(dataDirectory))
	if rpcError != nil {
		t.Fatalf("recovery initialize returned error: %#v", rpcError)
	}
	snapshot := result.(initializeResult).Snapshot
	if snapshot.Status != "auto-paused" {
		t.Fatalf("expected auto-paused recovery, got %q", snapshot.Status)
	}
	if snapshot.Automation.PauseReason != "core-recovery" {
		t.Fatalf("expected core-recovery reason, got %q", snapshot.Automation.PauseReason)
	}
}

func TestTimerCommandsUseCoreTimeAndPreserveManualPause(t *testing.T) {
	clock := newTestClock()
	server := newServer(clock.Now)
	t.Cleanup(func() {
		_ = server.Close()
	})

	if _, rpcError := server.Handle(initializeRequest(t.TempDir())); rpcError != nil {
		t.Fatalf("initialize returned RPC error: %#v", rpcError)
	}

	started := commandSnapshot(t, server, "timer.start")
	if started.Status != "running" || started.Automation.ManualPauseLocked {
		t.Fatalf("expected running timer without manual lock, got %#v", started)
	}

	clock.Advance(1250 * time.Millisecond)
	running := currentSnapshot(t, server)
	if running.RemainingMs != 1_798_750 {
		t.Fatalf("expected core-derived remaining time, got %d", running.RemainingMs)
	}

	paused := commandSnapshot(t, server, "timer.pause")
	if paused.Status != "manual-paused" || !paused.Automation.ManualPauseLocked {
		t.Fatalf("expected manual pause lock, got %#v", paused)
	}

	clock.Advance(5 * time.Second)
	frozen := currentSnapshot(t, server)
	if frozen.RemainingMs != paused.RemainingMs {
		t.Fatalf("expected paused timer to remain frozen at %d, got %d", paused.RemainingMs, frozen.RemainingMs)
	}

	resumed := commandSnapshot(t, server, "timer.resume")
	if resumed.Status != "running" || resumed.Automation.ManualPauseLocked {
		t.Fatalf("expected resumed timer without lock, got %#v", resumed)
	}
}

func TestNextBuildsDefaultCycleAndResetRestoresRound(t *testing.T) {
	server := NewServer()
	t.Cleanup(func() {
		_ = server.Close()
	})
	if _, rpcError := server.Handle(initializeRequest(t.TempDir())); rpcError != nil {
		t.Fatalf("initialize returned RPC error: %#v", rpcError)
	}

	shortBreak := commandSnapshot(t, server, "timer.next")
	if shortBreak.Round.Kind != "short-break" ||
		shortBreak.Status != "auto-paused" ||
		shortBreak.Automation.PauseReason != "break-condition" {
		t.Fatalf("expected waiting short break, got %#v", shortBreak)
	}

	secondFocus := commandSnapshot(t, server, "timer.next")
	if secondFocus.Round.Kind != "focus" ||
		secondFocus.Round.FocusRoundNumber == nil ||
		*secondFocus.Round.FocusRoundNumber != 2 ||
		secondFocus.Status != "idle" {
		t.Fatalf("expected second focus round, got %#v", secondFocus)
	}

	if _, rpcError := server.Handle(commandRequest("timer.pause")); rpcError == nil || rpcError.Code != -32010 {
		t.Fatalf("expected idle pause to be rejected, got %#v", rpcError)
	}

	started := commandSnapshot(t, server, "timer.start")
	if started.Status != "running" {
		t.Fatalf("expected running focus round, got %#v", started)
	}
	reset := commandSnapshot(t, server, "timer.reset")
	if reset.Status != "idle" || reset.RemainingMs != reset.Round.TotalDurationMs {
		t.Fatalf("expected reset focus round, got %#v", reset)
	}
}

func initializeRequest(dataDirectory string) protocol.Request {
	params, _ := json.Marshal(initializeParams{
		ProtocolVersion: protocol.Version,
		InstanceID:      "test-instance",
		DataDirectory:   dataDirectory,
		Locale:          "zh-CN",
		TimeZone:        time.Local.String(),
	})
	return protocol.Request{
		JSONRPC: "2.0",
		ID:      integerPointer64(1),
		Method:  "core.initialize",
		Params:  params,
	}
}

func commandRequest(method string) protocol.Request {
	return protocol.Request{
		JSONRPC: "2.0",
		ID:      integerPointer64(2),
		Method:  method,
		Params:  json.RawMessage(`{}`),
	}
}

func commandSnapshot(t *testing.T, server *Server, method string) Snapshot {
	t.Helper()
	result, rpcError := server.Handle(commandRequest(method))
	if rpcError != nil {
		t.Fatalf("%s returned RPC error: %#v", method, rpcError)
	}
	return result.(map[string]Snapshot)["snapshot"]
}

func currentSnapshot(t *testing.T, server *Server) Snapshot {
	t.Helper()
	result, rpcError := server.Handle(commandRequest("timer.getSnapshot"))
	if rpcError != nil {
		t.Fatalf("timer.getSnapshot returned RPC error: %#v", rpcError)
	}
	return result.(map[string]Snapshot)["snapshot"]
}

type testClock struct {
	value time.Time
}

func newTestClock() *testClock {
	return &testClock{
		value: time.Date(2026, time.September, 8, 9, 0, 0, 0, time.UTC),
	}
}

func (clock *testClock) Now() time.Time {
	return clock.value
}

func (clock *testClock) Advance(duration time.Duration) {
	clock.value = clock.value.Add(duration)
}

func integerPointer64(value int64) *int64 {
	return &value
}

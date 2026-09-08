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

func integerPointer64(value int64) *int64 {
	return &value
}

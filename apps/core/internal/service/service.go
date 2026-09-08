package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/easton/pomodoro-timer/core/internal/protocol"
	"github.com/easton/pomodoro-timer/core/internal/store"
)

type Round struct {
	Kind             string  `json:"kind"`
	CycleNumber      int     `json:"cycleNumber"`
	PositionInCycle  int     `json:"positionInCycle"`
	FocusRoundNumber *int    `json:"focusRoundNumber"`
	BreakMode        *string `json:"breakMode"`
	TotalDurationMs  int64   `json:"totalDurationMs"`
}

type AutomationState struct {
	ActivePresenceSource      string `json:"activePresenceSource"`
	InputPresence             string `json:"inputPresence"`
	CameraPresence            string `json:"cameraPresence"`
	InputMonitoringAvailable  bool   `json:"inputMonitoringAvailable"`
	CameraMonitoringAvailable bool   `json:"cameraMonitoringAvailable"`
	ManualPauseLocked         bool   `json:"manualPauseLocked"`
	PauseReason               string `json:"pauseReason"`
}

type Snapshot struct {
	Revision    int64           `json:"revision"`
	EmittedAt   string          `json:"emittedAt"`
	Round       Round           `json:"round"`
	Status      string          `json:"status"`
	RemainingMs int64           `json:"remainingMs"`
	Automation  AutomationState `json:"automation"`
}

type Settings struct {
	Version                   int    `json:"version"`
	FocusDurationSeconds      int    `json:"focusDurationSeconds"`
	ShortBreakDurationSeconds int    `json:"shortBreakDurationSeconds"`
	LongBreakDurationSeconds  int    `json:"longBreakDurationSeconds"`
	FocusRoundsPerCycle       int    `json:"focusRoundsPerCycle"`
	InputIdleThresholdSeconds int    `json:"inputIdleThresholdSeconds"`
	FocusPresenceSource       string `json:"focusPresenceSource"`
	DefaultBreakMode          string `json:"defaultBreakMode"`
	Theme                     string `json:"theme"`
	AlwaysOnTop               bool   `json:"alwaysOnTop"`
	NotificationsEnabled      bool   `json:"notificationsEnabled"`
}

type Capabilities struct {
	InputMonitoring bool `json:"inputMonitoring"`
	CameraPresence  bool `json:"cameraPresence"`
	StandingFocus   bool `json:"standingFocus"`
}

type DailyFocusTotal struct {
	LocalDate             string `json:"localDate"`
	CompletedFocusMinutes int    `json:"completedFocusMinutes"`
	CompletedFocusRounds  int    `json:"completedFocusRounds"`
}

type Statistics struct {
	GeneratedAt string            `json:"generatedAt"`
	Today       DailyFocusTotal   `json:"today"`
	Week        []DailyFocusTotal `json:"week"`
	Heatmap     []DailyFocusTotal `json:"heatmap"`
}

type initializeParams struct {
	ProtocolVersion int    `json:"protocolVersion"`
	InstanceID      string `json:"instanceId"`
	DataDirectory   string `json:"dataDirectory"`
	Locale          string `json:"locale"`
	TimeZone        string `json:"timeZone"`
}

type initializeResult struct {
	ProtocolVersion int          `json:"protocolVersion"`
	Capabilities    Capabilities `json:"capabilities"`
	Settings        Settings     `json:"settings"`
	Snapshot        Snapshot     `json:"snapshot"`
	Statistics      Statistics   `json:"statistics"`
}

type Server struct {
	store       *store.Store
	initialized bool
	snapshot    Snapshot
	settings    Settings
}

func NewServer() *Server {
	return &Server{
		settings: defaultSettings(),
	}
}

func (s *Server) Close() error {
	if s.store == nil {
		return nil
	}
	return s.store.Close()
}

func (s *Server) Handle(request protocol.Request) (interface{}, *protocol.RPCError) {
	switch request.Method {
	case "core.initialize":
		return s.initialize(request.Params)
	case "timer.getSnapshot":
		if !s.initialized {
			return nil, coreNotInitialized()
		}
		if len(request.Params) != 0 && string(request.Params) != "{}" {
			return nil, invalidParams("timer.getSnapshot does not accept parameters")
		}
		return map[string]Snapshot{"snapshot": s.snapshot}, nil
	default:
		return nil, &protocol.RPCError{
			Code:    -32601,
			Message: "method not found",
		}
	}
}

func (s *Server) initialize(raw json.RawMessage) (interface{}, *protocol.RPCError) {
	if s.initialized {
		return nil, invalidParams("core.initialize may only be called once")
	}

	var params initializeParams
	if err := decodeStrict(raw, &params); err != nil {
		return nil, invalidParams(err.Error())
	}
	if params.ProtocolVersion != protocol.Version {
		return nil, &protocol.RPCError{
			Code:    -32001,
			Message: "protocol version mismatch",
		}
	}
	if params.InstanceID == "" || params.Locale == "" || params.TimeZone == "" {
		return nil, invalidParams("instanceId, locale, and timeZone are required")
	}
	if _, err := time.LoadLocation(params.TimeZone); err != nil {
		return nil, invalidParams("timeZone must be an IANA time zone")
	}

	openedStore, err := store.Open(params.DataDirectory)
	if err != nil {
		return nil, &protocol.RPCError{
			Code:    -32020,
			Message: "local storage is unavailable",
		}
	}
	s.store = openedStore

	snapshot, err := s.loadOrCreateSnapshot()
	if err != nil {
		_ = s.store.Close()
		s.store = nil
		return nil, &protocol.RPCError{
			Code:    -32020,
			Message: "timer snapshot is unavailable",
		}
	}
	s.snapshot = snapshot
	s.initialized = true

	now := time.Now().UTC().Format(time.RFC3339Nano)
	return initializeResult{
		ProtocolVersion: protocol.Version,
		Capabilities: Capabilities{
			InputMonitoring: true,
			CameraPresence:  false,
			StandingFocus:   false,
		},
		Settings:   s.settings,
		Snapshot:   s.snapshot,
		Statistics: emptyStatistics(now, params.TimeZone),
	}, nil
}

func (s *Server) loadOrCreateSnapshot() (Snapshot, error) {
	raw, found, err := s.store.LoadSnapshot()
	if err != nil {
		return Snapshot{}, err
	}
	if !found {
		snapshot := initialSnapshot(s.settings)
		if err := s.persist(snapshot); err != nil {
			return Snapshot{}, err
		}
		return snapshot, nil
	}

	var snapshot Snapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return Snapshot{}, fmt.Errorf("decode persisted snapshot: %w", err)
	}
	if snapshot.Status == "running" {
		snapshot.Status = "auto-paused"
		snapshot.Automation.ManualPauseLocked = false
		snapshot.Automation.PauseReason = "core-recovery"
		snapshot.Revision++
		snapshot.EmittedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := s.persist(snapshot); err != nil {
			return Snapshot{}, err
		}
	}
	return snapshot, nil
}

func (s *Server) persist(snapshot Snapshot) error {
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("encode snapshot: %w", err)
	}
	return s.store.SaveSnapshot(snapshot.Revision, payload)
}

func defaultSettings() Settings {
	return Settings{
		Version:                   1,
		FocusDurationSeconds:      30 * 60,
		ShortBreakDurationSeconds: 5 * 60,
		LongBreakDurationSeconds:  10 * 60,
		FocusRoundsPerCycle:       3,
		InputIdleThresholdSeconds: 40,
		FocusPresenceSource:       "input",
		DefaultBreakMode:          "active",
		Theme:                     "system",
		AlwaysOnTop:               false,
		NotificationsEnabled:      true,
	}
}

func initialSnapshot(settings Settings) Snapshot {
	return Snapshot{
		Revision:  0,
		EmittedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Round: Round{
			Kind:             "focus",
			CycleNumber:      1,
			PositionInCycle:  1,
			FocusRoundNumber: integerPointer(1),
			BreakMode:        nil,
			TotalDurationMs:  int64(settings.FocusDurationSeconds) * 1000,
		},
		Status:      "idle",
		RemainingMs: int64(settings.FocusDurationSeconds) * 1000,
		Automation: AutomationState{
			ActivePresenceSource:      "input",
			InputPresence:             "unknown",
			CameraPresence:            "unknown",
			InputMonitoringAvailable:  true,
			CameraMonitoringAvailable: false,
			ManualPauseLocked:         false,
			PauseReason:               "none",
		},
	}
}

func emptyStatistics(now string, timeZone string) Statistics {
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		location = time.UTC
	}
	localDate := time.Now().In(location).Format("2006-01-02")
	return Statistics{
		GeneratedAt: now,
		Today: DailyFocusTotal{
			LocalDate: localDate,
		},
		Week:    []DailyFocusTotal{},
		Heatmap: []DailyFocusTotal{},
	}
}

func decodeStrict(raw json.RawMessage, target interface{}) error {
	if len(raw) == 0 {
		return errors.New("parameters are required")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("parameters contain trailing data")
	}
	return nil
}

func invalidParams(message string) *protocol.RPCError {
	return &protocol.RPCError{
		Code:    -32602,
		Message: message,
	}
}

func coreNotInitialized() *protocol.RPCError {
	return &protocol.RPCError{
		Code:    -32002,
		Message: "core is not initialized",
	}
}

func integerPointer(value int) *int {
	return &value
}

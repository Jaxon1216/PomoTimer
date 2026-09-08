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
	store        *store.Store
	initialized  bool
	snapshot     Snapshot
	settings     Settings
	now          func() time.Time
	runningSince time.Time
}

func NewServer() *Server {
	return newServer(time.Now)
}

func newServer(now func() time.Time) *Server {
	return &Server{
		settings: defaultSettings(),
		now:      now,
	}
}

func (s *Server) Close() error {
	if s.store == nil {
		return nil
	}
	return s.store.Close()
}

func (s *Server) Handle(request protocol.Request) (any, *protocol.RPCError) {
	switch request.Method {
	case "core.initialize":
		return s.initialize(request.Params)
	case "timer.getSnapshot":
		if !s.initialized {
			return nil, coreNotInitialized()
		}
		if err := requireEmptyParams(request.Params); err != nil {
			return nil, invalidParams(err.Error())
		}
		snapshot, err := s.currentSnapshot()
		if err != nil {
			return nil, storeUnavailable()
		}
		return map[string]Snapshot{"snapshot": snapshot}, nil
	case "timer.start", "timer.pause", "timer.resume", "timer.next", "timer.reset":
		if !s.initialized {
			return nil, coreNotInitialized()
		}
		if err := requireEmptyParams(request.Params); err != nil {
			return nil, invalidParams(err.Error())
		}
		return s.command(request.Method)
	default:
		return nil, &protocol.RPCError{
			Code:    -32601,
			Message: "method not found",
		}
	}
}

func (s *Server) initialize(raw json.RawMessage) (any, *protocol.RPCError) {
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
		return nil, storeUnavailable()
	}
	s.store = openedStore

	snapshot, err := s.loadOrCreateSnapshot()
	if err != nil {
		_ = s.store.Close()
		s.store = nil
		return nil, storeUnavailable()
	}
	s.snapshot = snapshot
	s.initialized = true

	now := s.now().UTC().Format(time.RFC3339Nano)
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
		snapshot := initialSnapshot(s.settings, s.now())
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
		snapshot.EmittedAt = s.now().UTC().Format(time.RFC3339Nano)
		if err := s.persist(snapshot); err != nil {
			return Snapshot{}, err
		}
	}
	return snapshot, nil
}

func (s *Server) command(method string) (any, *protocol.RPCError) {
	now := s.now()

	switch method {
	case "timer.start":
		if s.snapshot.Status != "idle" &&
			!(s.snapshot.Round.Kind != "focus" && s.snapshot.Status == "auto-paused") {
			return nil, invalidTransition()
		}
		s.enterRunning(now)
	case "timer.pause":
		if s.snapshot.Status != "running" {
			return nil, invalidTransition()
		}
		s.freezeRunning(now)
		s.snapshot.Status = "manual-paused"
		s.snapshot.Automation.ManualPauseLocked = true
		s.snapshot.Automation.PauseReason = "none"
	case "timer.resume":
		if s.snapshot.Status != "auto-paused" && s.snapshot.Status != "manual-paused" {
			return nil, invalidTransition()
		}
		s.enterRunning(now)
	case "timer.next":
		s.advanceRound()
	case "timer.reset":
		s.snapshot.Status = "idle"
		s.snapshot.RemainingMs = s.snapshot.Round.TotalDurationMs
		s.snapshot.Automation.ManualPauseLocked = false
		s.snapshot.Automation.PauseReason = "none"
		s.runningSince = time.Time{}
	default:
		return nil, &protocol.RPCError{
			Code:    -32601,
			Message: "method not found",
		}
	}

	s.snapshot.Revision++
	s.snapshot.EmittedAt = now.UTC().Format(time.RFC3339Nano)
	if err := s.persist(s.snapshot); err != nil {
		return nil, storeUnavailable()
	}
	return map[string]Snapshot{"snapshot": s.snapshot}, nil
}

func (s *Server) currentSnapshot() (Snapshot, error) {
	now := s.now()
	snapshot := s.snapshot

	if snapshot.Status != "running" {
		snapshot.EmittedAt = now.UTC().Format(time.RFC3339Nano)
		return snapshot, nil
	}

	snapshot.RemainingMs = s.remainingAt(now)
	if snapshot.RemainingMs > 0 {
		snapshot.EmittedAt = now.UTC().Format(time.RFC3339Nano)
		return snapshot, nil
	}

	s.snapshot.RemainingMs = 0
	s.advanceRound()
	s.snapshot.Revision++
	s.snapshot.EmittedAt = now.UTC().Format(time.RFC3339Nano)
	if err := s.persist(s.snapshot); err != nil {
		return Snapshot{}, err
	}
	return s.snapshot, nil
}

func (s *Server) enterRunning(now time.Time) {
	s.snapshot.Status = "running"
	s.snapshot.Automation.ManualPauseLocked = false
	s.snapshot.Automation.PauseReason = "none"
	s.runningSince = now
}

func (s *Server) freezeRunning(now time.Time) {
	s.snapshot.RemainingMs = s.remainingAt(now)
	s.runningSince = time.Time{}
}

func (s *Server) remainingAt(now time.Time) int64 {
	if s.snapshot.Status != "running" || s.runningSince.IsZero() {
		return s.snapshot.RemainingMs
	}
	elapsedMilliseconds := now.Sub(s.runningSince).Milliseconds()
	if elapsedMilliseconds <= 0 {
		return s.snapshot.RemainingMs
	}
	remaining := s.snapshot.RemainingMs - elapsedMilliseconds
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (s *Server) advanceRound() {
	nextRound := nextRound(s.snapshot.Round, s.settings)
	s.snapshot.Round = nextRound
	s.snapshot.RemainingMs = nextRound.TotalDurationMs
	s.snapshot.Automation.ManualPauseLocked = false
	s.runningSince = time.Time{}

	if nextRound.Kind == "focus" {
		s.snapshot.Status = "idle"
		s.snapshot.Automation.PauseReason = "none"
		return
	}
	s.snapshot.Status = "auto-paused"
	s.snapshot.Automation.PauseReason = "break-condition"
}

func nextRound(current Round, settings Settings) Round {
	switch current.Kind {
	case "focus":
		focusRoundNumber := valueOrZero(current.FocusRoundNumber)
		breakKind := "short-break"
		breakDuration := settings.ShortBreakDurationSeconds
		if focusRoundNumber >= settings.FocusRoundsPerCycle {
			breakKind = "long-break"
			breakDuration = settings.LongBreakDurationSeconds
		}
		return Round{
			Kind:             breakKind,
			CycleNumber:      current.CycleNumber,
			PositionInCycle:  current.PositionInCycle + 1,
			FocusRoundNumber: nil,
			BreakMode:        stringPointer(settings.DefaultBreakMode),
			TotalDurationMs:  int64(breakDuration) * 1000,
		}
	case "short-break":
		nextFocusRoundNumber := current.PositionInCycle/2 + 1
		return Round{
			Kind:             "focus",
			CycleNumber:      current.CycleNumber,
			PositionInCycle:  current.PositionInCycle + 1,
			FocusRoundNumber: integerPointer(nextFocusRoundNumber),
			BreakMode:        nil,
			TotalDurationMs:  int64(settings.FocusDurationSeconds) * 1000,
		}
	case "long-break":
		return Round{
			Kind:             "focus",
			CycleNumber:      current.CycleNumber + 1,
			PositionInCycle:  1,
			FocusRoundNumber: integerPointer(1),
			BreakMode:        nil,
			TotalDurationMs:  int64(settings.FocusDurationSeconds) * 1000,
		}
	default:
		return current
	}
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

func initialSnapshot(settings Settings, now time.Time) Snapshot {
	return Snapshot{
		Revision:  0,
		EmittedAt: now.UTC().Format(time.RFC3339Nano),
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

func requireEmptyParams(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "{}" {
		return nil
	}
	return errors.New("method does not accept parameters")
}

func decodeStrict(raw json.RawMessage, target any) error {
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

func invalidTransition() *protocol.RPCError {
	return &protocol.RPCError{
		Code:    -32010,
		Message: "invalid timer transition",
	}
}

func coreNotInitialized() *protocol.RPCError {
	return &protocol.RPCError{
		Code:    -32002,
		Message: "core is not initialized",
	}
}

func storeUnavailable() *protocol.RPCError {
	return &protocol.RPCError{
		Code:    -32020,
		Message: "local storage is unavailable",
	}
}

func integerPointer(value int) *int {
	return &value
}

func stringPointer(value string) *string {
	return &value
}

func valueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

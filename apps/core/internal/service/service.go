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

// Server 是 Core 的请求分发器和唯一计时状态机。
//
// 领域：Go / 状态机
// 顺序：命令链第 6 站：协议入口 -> Server.Handle -> 状态迁移或快照读取 -> Store。
// 作用：处理 JSON-RPC 方法、维护当前快照，并在状态迁移后保存它。
// 原因：计时状态不能依赖任意 Renderer 的内存，否则窗口关闭或重启会造成状态分叉。
// 边界：不调用 Electron API，也不读取原始输入或摄像头数据。
type Server struct {
	store        *store.Store
	initialized  bool
	snapshot     Snapshot
	settings     Settings
	now          func() time.Time
	runningSince time.Time
}

// NewServer 创建使用系统时钟的 Core Server。
//
// 领域：Go / 状态机
// 顺序：启动链：Go main -> NewServer -> 协议循环；core.initialize 后才打开 Store。
// 作用：提供正式运行时的 Server 构造入口。
// 原因：时钟通过内部构造函数注入，使状态机测试可使用可控时间。
// 边界：创建 Server 不会打开 SQLite；只有 core.initialize 才会初始化持久化。
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

// Handle 根据 JSON-RPC method 校验请求状态，并分派到对应的 Core 操作。
//
// 领域：Go / JSON-RPC 分派
// 顺序：请求链第 6 站：ReadRequest -> Handle -> initialize、currentSnapshot 或 command。
// 作用：限制允许的方法、检查初始化前置条件，并把结果包装为协议规定的错误。
// 原因：协议层只验证请求外壳；不同方法的参数和状态迁移约束必须在此统一执行。
// 边界：不负责 stdin/stdout 读写；调用方负责把返回值编码成 JSON-RPC 响应。
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

// 领域：Go / Core 初始化
// 顺序：启动链第 7 站：Handle(core.initialize) -> initialize -> Store.Open -> loadOrCreateSnapshot。
// 作用：校验启动参数、打开 SQLite，并加载或创建唯一的计时快照。
// 原因：Electron 与 Core 必须先确认协议和本地环境，随后才能执行任何计时命令。
// 边界：同一进程只能初始化一次；重复调用不会覆盖已加载的状态。
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

// 领域：Go / 崩溃恢复
// 顺序：启动链第 8 站：initialize -> loadOrCreateSnapshot -> LoadSnapshot 或 persist -> 初始化响应。
// 作用：从 SQLite 恢复快照；若上次处于 running，则改为 auto-paused 后再保存。
// 原因：Core 离线期间不能确认用户是否在专注，因此离线时间绝不能计入剩余时间。
// 边界：恢复只调整运行状态，不补写完成记录，也不尝试推断离线经过的时长。
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

// 领域：Go / 状态迁移
// 顺序：命令链第 7 站：Handle(timer.*) -> command -> enterRunning/freezeRunning/advanceRound -> persist。
// 作用：执行用户发出的 start、pause、resume、next 或 reset 命令，并持久化结果。
// 原因：所有显式命令经过同一个入口，才能让 revision、暂停锁和恢复规则保持一致。
// 边界：只接受已由 Handle 列入白名单的 method；自动监测信号不走这条路径。
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

// 领域：Go / 时间计算
// 顺序：读快照链第 7 站：Handle(timer.getSnapshot) -> currentSnapshot -> remainingAt 或 advanceRound。
// 作用：根据当前时间派生快照的剩余时间，并在归零时仅推进一次轮次。
// 原因：运行中不需要每秒写 SQLite；读取或发事件时才从基准时间计算剩余时间。
// 边界：返回值是副本，除非轮次归零，否则不会修改或持久化 Server 的快照。
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

// 领域：Go / 状态迁移
// 顺序：命令链内部：command(start/resume) -> enterRunning -> command.persist。
// 作用：把快照设为运行中，并记录本次运行开始的时间基准。
// 原因：后续读取快照时需要从该基准推导已流逝时间，不能让 Renderer 自行计时。
// 边界：只修改内存状态；revision 更新和 SQLite 保存由 command 统一处理。
func (s *Server) enterRunning(now time.Time) {
	s.snapshot.Status = "running"
	s.snapshot.Automation.ManualPauseLocked = false
	s.snapshot.Automation.PauseReason = "none"
	s.runningSince = now
}

// 领域：Go / 手动暂停
// 顺序：命令链内部：command(pause) -> freezeRunning -> 设置 manual-paused -> persist。
// 作用：把运行期间已经消耗的时间固化到 remainingMs，并清空运行基准时间。
// 原因：暂停后继续使用旧 runningSince 会让查询时把暂停时长错误计入专注时间。
// 边界：此函数只冻结时间；调用方决定暂停是手动还是自动以及相应的锁状态。
func (s *Server) freezeRunning(now time.Time) {
	s.snapshot.RemainingMs = s.remainingAt(now)
	s.runningSince = time.Time{}
}

// 领域：Go / 时间计算
// 顺序：读快照或暂停链内部：currentSnapshot/freezeRunning -> remainingAt -> 返回或保存快照。
// 作用：依据 runningSince 和当前时间计算当前轮还剩多少毫秒。
// 原因：Core 以这一处的结果为准，避免多窗口分别倒计时而产生差异。
// 边界：只计算数值，不修改快照、推进轮次或写 SQLite。
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

// 领域：Go / 轮次序列
// 顺序：命令或读快照链内部：command(next)/currentSnapshot(归零) -> advanceRound -> nextRound。
// 作用：生成下一轮并设置其初始状态、剩余时间和暂停原因。
// 原因：专注轮必须由用户显式开始，休息轮则等待自动化条件满足后才运行。
// 边界：仅移动轮次；完成专注记录和自动化策略将在后续阶段的专用逻辑中处理。
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

// 领域：Go / 轮次序列
// 顺序：轮次推进内部：advanceRound -> nextRound -> 新 Round 写回 Snapshot。
// 作用：按专注、短休、长休的顺序计算下一轮的类型、位置和时长。
// 原因：轮次编号是 Core 的状态，不由 UI 推算，避免多个窗口显示不同的循环位置。
// 边界：只构造 Round；调用方负责将其写回 Snapshot 并设置运行状态。
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

// 领域：Go / 持久化
// 顺序：命令和归零链末尾：状态迁移 -> persist -> Store.SaveSnapshot -> SQLite。
// 作用：把内存中的快照编码为 JSON 后交给 Store 保存。
// 原因：持久化格式集中在这里，恢复路径才能使用与运行时相同的 Snapshot 模型。
// 边界：Store 只处理数据库写入；调用方决定状态迁移和 revision 的时机。
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

// 领域：Go / 协议校验
// 顺序：初始化链内部：Handle(core.initialize) -> decodeStrict -> 字段校验 -> Store.Open。
// 作用：将请求参数严格解码为目标类型，并拒绝未知字段或尾随 JSON 数据。
// 原因：JSON 默认允许未知字段会让 Main 与 Core 的契约在无提示下逐渐偏离。
// 边界：只验证 JSON 形状；字段取值的业务规则由调用它的方法检查。
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

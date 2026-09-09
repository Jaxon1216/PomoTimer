# Pomodoro Timer Collaboration Guide

## Product Scope

Pomodoro Timer is a local-first desktop focus timer for macOS and Windows.

- Phase 1 delivers an Electron desktop app with React/TypeScript UI, a Go local core, configurable `30/5/30/5/30/10` cycles, system-input monitoring, two break modes, local statistics, a heatmap, tray controls, notifications, and light/dark themes.
- Phase 2 adds opt-in, on-device camera presence detection.
- Phase 3 adds manual standing-focus sessions and production hardening.
- Do not add accounts, cloud sync, telemetry, calendar scheduling, identity recognition, medical claims, Linux support, or strict camera anti-spoofing unless the product scope changes explicitly.

## Planned Repository Layout

```text
apps/
  desktop/       Electron main process, preload bridge, React renderer
  core/          Go sidecar: timer state, persistence, statistics, policy
docs/            Product, architecture, protocol, research, and roadmap docs
tests/           Cross-process and end-to-end tests
scripts/         Build, packaging, and local-development scripts
```

Create directories only when their phase requires them. Keep application code out of `docs/`.

## Ownership Boundaries

- The React renderer owns presentation, local UI state, and camera-frame processing in Phase 2. It is not the source of truth for the timer.
- The preload bridge exposes a narrow, typed `window.pomodoro` API. It does not expose `ipcRenderer`, Node modules, file paths, or arbitrary message channels.
- The Electron main process owns windows, tray state, notifications, platform idle-time APIs, power events, sidecar lifecycle, and validation for all renderer-originating IPC.
- The Go sidecar owns the timer state machine, automatic/manual pause precedence, persisted settings, SQLite migrations, completed-focus records, and statistics aggregation.
- SQLite is accessed by Go only. Electron and React must not read or write the database directly.

## Security and Privacy Requirements

- Configure Electron with `contextIsolation: true`, `nodeIntegration: false`, renderer sandboxing, and a restrictive content security policy.
- Validate every Electron IPC payload and every sidecar protocol message at runtime. Reject unknown commands and invalid fields.
- Never capture or persist key values, mouse coordinates, active-window metadata, screen contents, raw camera frames, face embeddings, or identity data.
- Input monitoring is limited to elapsed seconds since the last system-wide input event.
- Camera support is off by default, requires an explicit user action and OS permission, runs locally, and sends only a boolean presence signal to the main process.
- A missing permission, unavailable device, failed sidecar, or failed detection source must never silently count time as focused. Surface the degraded state and use the documented safe fallback.
- Do not claim that face presence proves movement, identity, attention, health, or liveness against photo/video spoofing.

## Timer and Automation Rules

- The Go core is the only authoritative timer state.
- Default sequence: focus 30 minutes, short break 5 minutes, focus 30 minutes, short break 5 minutes, focus 30 minutes, long break 10 minutes.
- Automatic pauses do not decrement remaining time.
- A manual pause locks automatic resume. The user must resume manually before automatic monitoring becomes active again.
- Focus uses the selected presence source. Phase 1 selects system input; Phase 2 permits switching to camera presence.
- Active breaks run only while the user is away. Desk breaks run only while there is no system input. See `docs/product-spec.md` for the complete matrix.
- App restart and system suspend transition an active timer to an automatic pause. Offline elapsed time never counts as focus.

## Engineering Practices

- Use strict TypeScript. Do not use `any` for IPC, sidecar, timer, or persistence contracts.
- Keep contracts explicit and versioned. Changes to sidecar messages require updates to `docs/contracts.md`, TypeScript types, Go types, and tests in the same change.
- Use monotonic time for timer elapsed calculations. Wall clock is only for displaying and grouping completed sessions by local date.
- Make asynchronous resource setup cancellable. A stale camera or sidecar initialization must not overwrite newer configuration.
- Add tests at the state-machine boundary first. Expand to IPC and end-to-end coverage when behavior crosses process or platform boundaries.
- Use SQLite migrations for every persisted schema change. Migrations are transactional and versioned; do not alter a released schema in place.
- Follow `docs/code-commenting.md` for substantive Electron, Go, protocol, and persistence comments.
- Favor small, scoped changes. Do not refactor platform or state-machine code while implementing unrelated UI work.

## Platform Requirements

- macOS system idle time must use a system-wide API, not DOM events.
- Windows system idle time must use `GetLastInputInfo` or a tested equivalent. It must not ship as an "always active" placeholder.
- macOS camera usage text and Windows camera permission behavior must be tested before Phase 2 is released.
- Package the matching Go sidecar binary inside each platform build. The Electron main process must verify the executable path and protocol version at startup.
- Exercise suspend/resume, tray behavior, notifications, compact window constraints, and sidecar restart on both supported platforms before release.

## Commands and Prerequisites

The project is intentionally documentation-only until Phase 0 initializes the application.

- Node.js and npm are already available in this environment.
- Go is currently not installed. Install Go `1.24+` before creating `apps/core`.
- Planned commands after initialization:

```sh
npm run dev
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run package
go test ./...
go vet ./...
```

Do not document a command as passing until it exists and has been run.

## Documentation Authority

- `docs/product-spec.md` is authoritative for user-visible behavior and acceptance criteria.
- `docs/architecture.md` is authoritative for process ownership, platform integration, and implementation structure.
- `docs/contracts.md` is authoritative for Electron/Go protocol and persistence contracts.
- `docs/research-and-decisions.md` records evidence and non-medical rationale behind defaults.
- `docs/roadmap.md` is authoritative for phase boundaries and release gates.

When documents disagree, update them in one change before implementation proceeds.

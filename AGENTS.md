# Pomodoro Timer Collaboration Guide

## Product scope

Pomodoro Timer is a local-first Electron desktop focus timer for macOS and Windows. Phase 1 includes React/TypeScript UI, a main-process timer core, system-input monitoring, configurable `30/5/30/5/30/10` cycles, active/desk breaks, local statistics, heatmap, tray controls, notifications, compact layout, and light/dark/system themes. Phase 2 may add opt-in local camera presence; Phase 3 may add manual standing sessions.

Do not add accounts, cloud sync, telemetry, calendar scheduling, identity recognition, medical claims, Linux support, strict camera anti-spoofing, HTTP/WebSocket services, or child-process cores without an explicit scope change.

## Repository and ownership

```text
apps/desktop/   Electron main, preload, React renderer, timer and SQLite modules
docs/           product, architecture, contract, research, and roadmap documents
tests/          Electron cross-process and end-to-end tests
```

- React owns presentation, navigation, and ephemeral UI state. It never owns authoritative time or persistence.
- Preload exposes only the typed `window.pomodoro` allowlist. It never exposes `ipcRenderer`, Node, paths, SQLite, or generic channels.
- Main owns windows, tray, notifications, `powerMonitor`, suspend/resume, IPC validation, and the only `TimerEngine` instance.
- `apps/desktop/src/main/timer.ts` is Electron-independent deterministic business logic and is the timer authority.
- `apps/desktop/src/main/store.ts` is the only SQLite access layer. Renderer and preload never open the database.

## Security, privacy, and behavior

- Keep `contextIsolation: true`, `nodeIntegration: false`, sandboxing, web security, and a restrictive CSP.
- Validate every IPC input and every event payload with Zod; reject unknown commands and fields.
- System input is represented only by seconds since the last system-wide input event. Never collect key values, mouse coordinates, active windows, screen contents, camera frames, embeddings, or identity data.
- Phase 1 input monitoring uses Electron `powerMonitor.getSystemIdleTime()` on macOS and Windows. Failure is visible, becomes `unknown`, and safely pauses an active round; idle/manual-paused rounds are not started or overridden.
- Automatic pause never decrements time. Manual pause locks automatic resume until the user presses continue.
- Sleep and restart turn an active round into `auto-paused`; offline time never counts.

## Engineering rules

- Strict TypeScript; do not use `any` in IPC, timer, or persistence contracts.
- Use monotonic `performance.now()` for elapsed time. Use wall time only for display and local-date grouping.
- SQLite migrations are transactional, versioned, checksum-protected, and compatible with the previous Go-created tables. Never delete the user database or edit a released migration.
- Add state-machine tests before changing UI behavior. Keep cross-process behavior covered by Playwright Electron tests.
- Keep comments useful and follow `docs/code-commenting.md`; do not describe removed Go or JSON-RPC flows as current.

## Commands

```sh
npm run dev
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run package
```

Windows idle, notification, tray, camera-permission, installer, and suspend behavior still require a real Windows verification pass. Do not claim an unrun command or platform check passed.

## Documentation authority

`docs/product-spec.md` defines user-visible behavior; `docs/architecture.md` defines process ownership; `docs/contracts.md` defines typed IPC and persistence; `docs/roadmap.md` defines phase boundaries. Update affected documents and tests together.

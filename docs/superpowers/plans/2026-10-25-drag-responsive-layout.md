# Drag-responsive layout implementation plan

**Goal:** Restore drag-to-resize responsive presentation down to 160×180 without manual window mode selection.

**Architecture:** Main manages one native window and its session placement. CSS owns responsive composition; React presents the authoritative TimerSnapshot. Window presentation has no timer or database commands.

**Tech stack:** Electron, React, strict TypeScript, CSS grid/container sizing, Vitest and Playwright Electron.

## Constraints

- Initial content size 360×478; minimum content size 160×180 with platform frame compensation.
- Remove mode selection UI, IPC methods, schemas and events.
- Keep complete status/monitor text, accessible actions and 32px timer buttons.
- Preserve native macOS traffic-light space and Windows title-bar compensation.
- No new dependencies, timer/persistence behavior changes or user database resets.

## Task 1: Single native window and contracts

- [x] Replace mode-controller tests with single-window minimum, placement restoration, display clamping and timer independence tests; observe failure.
- [x] Replace window-mode controller with window-layout controller, update Main and remove window-mode IPC from shared contracts and preload.
- [x] Run focused native window tests and inspect the diff.

## Task 2: Responsive renderer

- [x] Update renderer tests to expect no explicit mode controls/API and preserve timer snapshots through resize; observe failure.
- [x] Remove mode state/buttons and add a CSS-driven compact/micro/landscape layout plus micro progress line.
- [x] Keep small menus, settings save controls and statistics readable and reachable.
- [x] Run renderer tests and typecheck.

## Task 3: Cross-process layout verification and documentation

- [x] Update Electron tests for native 160×180 minimum and automatic layout transitions; verify frozen manual-pause baseline before resize.
- [x] Verify geometry, full status, native title-bar space, menus and settings/statistics at small sizes and breakpoint edges.
- [x] Align product, architecture, IPC, request-flow, roadmap and README documentation; fix layout script navigation.
- [x] Run lint, typecheck, unit tests, build and Electron E2E; visually inspect screenshots, review diff, restart development app.

## Progress

- Plan recorded before implementation. Existing baseline: 102 unit/component tests and 9 native store tests passed; E2E initially 12/14, two transient failures each passed two targeted reruns.
- Native window tests observed 7 expected failures before implementation, then all 10 passed; renderer removal test also failed before implementation and all 36 component tests passed afterward.
- Final build, lint, typecheck and 101 unit/component tests passed. Full Electron E2E passed 14/14 after correcting small-ring spacing and an empty-statistics test locator.
- Native/IPC review and whole-change review found no actionable issues. Screenshots inspected at 160×180, 220×240, 360×180 and 360×478, plus input failure and populated statistics at the minimum.
- Development startup smoke passed with isolated userData. Standalone browser layout script could not run because Playwright Chromium is not installed; it has syntax validation, and real Electron layout coverage passed. Windows hardware verification remains outstanding.
- Updated development app restarted via npm run dev; its actual native window and rendered interface were verified and left running.

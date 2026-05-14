# Hub Progress Screen Visual

## TL;DR
> **Summary**: Replace the unreadable all-room hub text overlay with an Overmind-inspired `RoomVisual` panel rendered only inside the hub room. The panel must show current production, production progress, and logistics summary/blockers with TDD coverage.
> **Deliverables**:
> - Hub-room-only structured visual panel in `src/runtime/hubProgress.ts`
> - Recording-capable `RoomVisual` test mock in `test/setup.ts`
> - TDD regression coverage in `src/runtime/hubProgress.test.ts`
> - Preserve existing JSON console helpers and snapshot/analytics behavior
> **Effort**: Short
> **Parallel**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

## Context
### Original Request
- “hub进度的渲染有问题, 应该学overmind, 在屏幕绘制”
- Follow-up: “目前的渲染可读性极差”
- Must show: “目前正在生产什么, 以及生产进度, 物流调度”

### Interview Summary
- Display scope: full hub panel only in the Hub room.
- Logistics detail: summary + blockers, not full task details by default.
- Test strategy: TDD.
- Overmind reference: in-room `RoomVisual` HUD/panel after game logic, with sections, headers, progress bars, fixed coordinates, vertical stacking.

### Metis Review (gaps addressed)
- **Panel anchor**: default to fixed top-left room coordinates `x=1`, `y=2`, not storage-relative, to avoid extra game-object dependencies.
- **Idle behavior**: render the same compact panel sections with `Production: idle` and `Progress: 0%`, not a header-only collapse, because the user wants consistent readability.
- **Progress semantics**: without changing `HubProgressSnapshot`, visual progress is `hubInventory[activeProduct] / 1000`, capped to `[0, 1]`; caption is `{amount}/1000 stock`. If no active product, display `0% idle`; if missing resources exist, show missing count/list in the progress section.
- **Guardrails**: keep `buildHubOverlayLines()` for console/debug text; do not touch hub planning, synthesis, transfer execution, memory schema, or map visuals.

## Work Objectives
### Core Objective
Make hub progress readable in-game by replacing the current repeated plain-text overlay with a structured Overmind-style RoomVisual panel in the hub room.

### Deliverables
- `src/runtime/hubProgress.ts`: visual helpers and hub-room-only renderer.
- `src/runtime/hubProgress.test.ts`: failing-first tests for visual model, draw calls, guards, and edge cases.
- `test/setup.ts`: reusable RoomVisual call recorder for deterministic render assertions.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` exits 0.
- `npm run test -- src/runtime/hubProgress.test.ts` exits 0.
- `npm run test` exits 0.
- `npm run build` exits 0.
- Tests assert concrete `RoomVisual` calls for section headers, production label, progress bar fill, logistics summary, blockers, and hub-room-only targeting.

### Must Have
- Render only with `new RoomVisual(snapshot.hubRoomName)`.
- Render only when `RoomVisual` exists, hub config is enabled, CPU bucket is at least 100, snapshot is enabled, and `Game.rooms[snapshot.hubRoomName]` exists.
- Panel sections in this order: `Hub Production`, `Progress`, `Logistics`.
- Production section shows current product (`snapshot.activeProduct ?? "idle"`), status, stage, and needs-plan indicator.
- Progress section uses a `rect` outline + translucent `rect` fill + centered text.
- Logistics section shows `import/reclaim/export` counts and up to two blockers.
- Preserve `buildHubOverlayLines()` behavior for console/debug output.
- Preserve `collectHubProgressSnapshot()` and `runHubProgressAnalytics()` behavior.

### Visual Style Contract
- Coordinates: `HUB_VISUAL_X = 1`, `HUB_VISUAL_Y = 2`, `HUB_VISUAL_WIDTH = 13.5`, `HUB_VISUAL_ROW = 0.7`, `HUB_PROGRESS_TARGET = 1000`.
- Palette: `TEXT = "#c9c9c9"`, `HEADER_FILL = "#1a1a2e"`, `PANEL_STROKE = "#c9c9c9"`, `OK = "#00ff88"`, `WARN = "#ffaa00"`, `ERROR = "#ff5555"`, `MUTED = "#888888"`.
- Section header style: `rect(x, y, width, 0.55, { fill: HEADER_FILL, opacity: 0.8, stroke: PANEL_STROKE, strokeWidth: 0.03 })` then title text at `x + 0.25`, `y + 0.42`, `{ align: "left", font: 0.45, color: TEXT }`.
- Progress bar style: outline `rect(barX, barY, barWidth, 0.45, { fill: "transparent", stroke: PANEL_STROKE, strokeWidth: 0.03, opacity: 0.8 })`; fill `rect(barX, barY, barWidth * percent, 0.45, { fill: OK/WARN/ERROR, opacity: 0.4, strokeWidth: 0 })`; centered label text at `barX + barWidth / 2`, `barY + 0.36`, `{ align: "center", font: 0.35, color: TEXT }`.
- Status colors: `blocked`/`lastError` = `ERROR`; `needsPlan`/missing resources/blockers = `WARN`; `synthesizing`/healthy progress = `OK`; idle/no active product = `MUTED`.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not modify `hubPlanner`, `synthesisControl`, `resourceControl`, logistics task execution, spawn behavior, or Memory schemas.
- Do not use `Game.map.visual`.
- Do not add Overmind as a dependency or copy Overmind code verbatim.
- Do not render in every owned room.
- Do not add minimaps, creep paths, room intel, clickable/interactive behavior, or persistent visual state.
- Do not make acceptance depend on manual in-game inspection.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest/ts-jest (`src/runtime/hubProgress.test.ts`)
- QA policy: Every task has agent-executed scenarios
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (test mock foundation)
Wave 2: Task 2 → Task 3 → Task 4 → Task 5 (sequential because each depends on the prior TDD/render surface)

### Dependency Matrix (full, all tasks)
| Task | Blocked By | Blocks |
|------|------------|--------|
| 1 | None | 2, 3, 4, 5 |
| 2 | 1 | 3, 4, 5 |
| 3 | 1, 2 | 4, 5 |
| 4 | 1, 2, 3 | 5 |
| 5 | 1, 2, 3, 4 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 4 | quick, visual-engineering, quick, unspecified-low |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Upgrade RoomVisual test mock into a recorder

  **What to do**: Extend `test/setup.ts:3-23` so the global `RoomVisualMock` records constructor room names and method calls for `text`, `rect`, `line`, `circle`, and `poly`. Expose test-only helpers on `global`, for example `__roomVisualCalls` and `__resetRoomVisualCalls`, and call the reset helper from `beforeEach` after `refreshGlobalMock`. Preserve chainable return behavior.
  **Must NOT do**: Do not remove existing mock methods. Do not depend on real Screeps visuals. Do not mutate source files outside `test/setup.ts` and tests that consume the recorder.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Small test infrastructure change with bounded file scope.
  - Skills: [] - No specialized skill required.
  - Omitted: [`frontend-ui-ux`] - This is not browser/UI work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3, 4, 5] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `test/setup.ts:3-23` - Existing global `RoomVisualMock` methods are no-op chainable stubs.
  - Pattern: `src/runtime/hubProgress.test.ts:352-379` - Current local mock captures only text calls; replace this pattern with shared recorder assertions.
  - Test: `src/runtime/hubProgress.test.ts:316-380` - Existing render tests are the target consumers.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- src/runtime/hubProgress.test.ts` passes after existing tests are updated to use the recorder.
  - [ ] A test can assert that `new RoomVisual("W1N1").rect(1, 2, 3, 4, { fill: "#000" })` records `{ roomName: "W1N1", method: "rect", args: [1, 2, 3, 4, { fill: "#000" }] }`.
  - [ ] `RoomVisualMock` methods still return `this` so chained calls remain possible.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Recorder captures draw calls
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/hubProgress.test.ts` after adding one focused recorder assertion in the test file.
    Expected: Jest exits 0 and the assertion proves roomName + method + args are captured.
    Evidence: .sisyphus/evidence/task-1-roomvisual-recorder.txt

  Scenario: Recorder reset prevents cross-test leakage
    Tool: Bash
    Steps: Run the same test file with two tests: first emits a call, second asserts the recorder starts empty before emitting its own call.
    Expected: Jest exits 0; no call from the first test appears in the second test.
    Evidence: .sisyphus/evidence/task-1-roomvisual-recorder-reset.txt
  ```

  **Commit**: YES | Message: `test(hub): record room visual draw calls` | Files: [`test/setup.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 2. Add TDD visual model and helper tests for the hub panel

  **What to do**: In `src/runtime/hubProgress.test.ts`, write failing tests before implementation for a visual model/helper layer in `src/runtime/hubProgress.ts`. The model must derive: product label, status label, stage label, needs-plan marker, progress amount, progress text, missing-resource summary, logistics counts, and blocker rows from `HubProgressSnapshot`. Implement only the helper code needed to pass these tests.
  **Must NOT do**: Do not change `HubProgressSnapshot` or `HubProgressInput`. Do not change `collectHubProgressSnapshot()` or `runHubProgressAnalytics()`. Do not remove `buildHubOverlayLines()`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Pure TypeScript derivation helpers and focused tests.
  - Skills: [] - Existing tests provide enough patterns.
  - Omitted: [`superpowers:test-driven-development`] - TDD is already mandated by this plan; loading the skill is optional, not required.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [3, 4, 5] | Blocked By: [1]

  **References** (executor has NO interview context - be exhaustive):
  - API/Type: `src/runtime/hubProgress.ts:47-78` - `HubProgressSnapshot` fields available to the visual model.
  - Pattern: `src/runtime/hubProgress.test.ts:270-314` - Existing `makeSnapshot` helper style for snapshot-based assertions.
  - Pattern: `src/runtime/hubProgress.ts:85-89` - Existing `formatEnergy()` helper for compact numbers.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Tests prove active product `XGH2O` renders as the production label when `snapshot.activeProduct === "XGH2O"`.
  - [ ] Tests prove idle state renders product label `idle` and progress text `0% idle` when `activeProduct` is null.
  - [ ] Tests prove progress percent is `min(hubInventory[activeProduct] / 1000, 1)` and progress text is `{formattedAmount}/1000 stock`.
  - [ ] Tests prove missing resources are truncated to at most four names plus `+N` suffix.
  - [ ] Tests prove blockers are truncated to at most two rows.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test -- src/runtime/hubProgress.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Active production visual model
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/hubProgress.test.ts` with a snapshot containing activeProduct=XGH2O and hubInventory.XGH2O=500.
    Expected: Test asserts product label `XGH2O`, progress percent `0.5`, and progress text containing `500/1000 stock`.
    Evidence: .sisyphus/evidence/task-2-active-production-model.txt

  Scenario: Idle/blocked edge model
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/hubProgress.test.ts` with idle and blocked snapshots, including missing resources and blockers.
    Expected: Tests assert idle progress is 0 and blocked snapshot shows truncated missing/blocker summaries without throwing.
    Evidence: .sisyphus/evidence/task-2-edge-model.txt
  ```

  **Commit**: NO | Message: `feat(hub): derive visual progress model` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 3. Render Overmind-style Production and Progress sections

  **What to do**: Add small visual helpers in `src/runtime/hubProgress.ts` for `drawSection`, `drawProgressBar`, and row text. Use the constants and palette from **Visual Style Contract**. Draw `Hub Production` and `Progress` sections with `rect` header/background, `rect` outline, `rect` progress fill at opacity `0.4`, and centered progress text. Tests must assert exact RoomVisual calls through the recorder.
  **Must NOT do**: Do not use `RoomVisual.prototype` monkey-patching. Do not add a general `src/visuals` framework. Do not copy Overmind code. Do not exceed two sections in this task.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` - Reason: Layout/readability work using Screeps visual primitives.
  - Skills: [] - No browser skill; this is Screeps RoomVisual rendering.
  - Omitted: [`frontend-ui-ux`] - Not a web frontend; visual design is constrained to RoomVisual calls.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [4, 5] | Blocked By: [1, 2]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: Overmind `Visualizer.section()` - Header background + border + title + returned content start.
  - Pattern: Overmind `Visualizer.barGraph()` - Outline + translucent filled rect + centered text; implement the outline as a stroked `rect` to reduce primitive count.
  - API/Type: Screeps `RoomVisual.rect`, `RoomVisual.line`, `RoomVisual.text` style properties.
  - Test: `test/setup.ts:3-23` after Task 1 - Use recorder, not local mocks.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Tests assert `Hub Production` header text is drawn at the configured panel coordinates.
  - [ ] Tests assert production rows include product, status, stage, and needs-plan marker when present.
  - [ ] Tests assert progress bar draws outline and a filled rect with width `progressPercent * barWidth`.
  - [ ] Tests assert progress text is centered over the bar.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test -- src/runtime/hubProgress.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Production section draw calls
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/hubProgress.test.ts` with a synthesizing snapshot.
    Expected: Recorder includes header rect/text, product/status/stage text, and no calls for non-hub rooms.
    Evidence: .sisyphus/evidence/task-3-production-section.txt

  Scenario: Progress bar geometry
    Tool: Bash
    Steps: Run tests with progress snapshots at 0%, 50%, and 100%.
    Expected: Filled rect widths equal 0, half bar width, and full bar width; text labels match each percent case.
    Evidence: .sisyphus/evidence/task-3-progress-bar.txt
  ```

  **Commit**: NO | Message: `feat(hub): draw production progress panel` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 4. Render Logistics summary and blockers with strict caps

  **What to do**: Add the `Logistics` section below `Progress`. Display one summary row: `imp {pendingImports} | recl {pendingReclaims} | exp {pendingExports}`. If blockers exist, display at most two blocker rows formatted as `{room}: term {energy} / reserve {reserve}, nonE {pendingNonEnergy}`. If there are more than two blockers, append `+N more` to the second row or add a third capped summary row only if total panel primitive budget stays within the cap.
  **Must NOT do**: Do not show full `pendingTasks` list. Do not add scrolling/pagination. Do not render more than two detailed blocker rows.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Bounded formatting/rendering extension on existing panel helpers.
  - Skills: [] - Existing visual helper patterns from Task 3 are sufficient.
  - Omitted: [`artistry`] - No unconventional design required.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [5] | Blocked By: [1, 2, 3]

  **References** (executor has NO interview context - be exhaustive):
  - API/Type: `src/runtime/hubProgress.ts:62-77` - Pending task counts and blocker fields in `HubProgressSnapshot`.
  - Pattern: `src/runtime/hubProgress.ts:376-382` - Existing logistics text content in old overlay.
  - User decision: logistics display is “摘要 + 阻塞”, not full details.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Tests assert logistics summary row contains import/reclaim/export counts.
  - [ ] Tests assert zero blockers produces no blocker detail rows and a clear `blockers: none` or equivalent row.
  - [ ] Tests assert one blocker row includes room name, terminal energy, reserve, and pending non-energy count.
  - [ ] Tests assert five blockers produce no more than two detailed blocker rows and a `+3 more` summary.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test -- src/runtime/hubProgress.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Logistics summary only
    Tool: Bash
    Steps: Run hubProgress tests with pendingImports=3, pendingReclaims=1, pendingExports=2, and no blockers.
    Expected: Recorder includes one logistics summary row and no blocker detail rows.
    Evidence: .sisyphus/evidence/task-4-logistics-summary.txt

  Scenario: Blocker cap
    Tool: Bash
    Steps: Run hubProgress tests with five roomTerminalBlockers.
    Expected: Recorder includes at most two detailed blocker room names and includes `+3 more`.
    Evidence: .sisyphus/evidence/task-4-blocker-cap.txt
  ```

  **Commit**: NO | Message: `feat(hub): show logistics blockers in visual panel` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 5. Replace overlay entrypoint and enforce render guards/budget

  **What to do**: Replace `renderHubProgressOverlays()` internals at `src/runtime/hubProgress.ts:388-409` so it collects a snapshot, exits unless rendering is safe, and draws exactly one panel in `snapshot.hubRoomName`. Preserve early exits for missing `RoomVisual`, disabled hub config, and `Game.cpu.bucket < 100`. Add exits for disabled snapshot, empty hub room name, and invisible/unavailable `Game.rooms[snapshot.hubRoomName]`. Define a primitive budget constant such as `MAX_HUB_VISUAL_CALLS = 40`; render helpers must stay under it in tests. Keep `buildHubOverlayLines()` unchanged.
  **Must NOT do**: Do not render in `Object.values(Game.rooms).filter(r => r.controller?.my)`. Do not remove JSON console support. Do not add `Game.map.visual` or new Memory flags.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Reason: Integration and guard cleanup across a small surface.
  - Skills: [] - No external skills required.
  - Omitted: [`deep`] - The architecture decisions are already fixed.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [Final Verification] | Blocked By: [1, 2, 3, 4]

  **References** (executor has NO interview context - be exhaustive):
  - Current code: `src/runtime/hubProgress.ts:388-409` - Existing all-owned-room overlay to replace.
  - Must preserve: `src/runtime/hubProgress.ts:344-386` - `buildHubOverlayLines()` for console/debug text.
  - Tick order: `src/main.ts:62-63` - Rendering already happens after hub logic; do not move this call.
  - Console: `src/runtime/consoleCommands.ts:136-137` - `hubProgress()`/`hubProgressRaw()` must keep working.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Tests assert rendering targets only `W1N1` when hubRoomName is `W1N1` and another owned room exists.
  - [ ] Tests assert no draw calls when `RoomVisual` is undefined.
  - [ ] Tests assert no draw calls when hub config is disabled.
  - [ ] Tests assert no draw calls when `Game.cpu.bucket < 100`.
  - [ ] Tests assert no draw calls when `Game.rooms[hubRoomName]` is missing.
  - [ ] Tests assert total recorded calls for a maximal panel are `<= MAX_HUB_VISUAL_CALLS`.
  - [ ] Existing `buildHubOverlayLines` tests still pass unchanged.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Hub-room-only rendering
    Tool: Bash
    Steps: Run tests with Game.rooms containing W1N1 and W2N1 as owned rooms while Memory.cfg.hub.hubRoomName is W1N1.
    Expected: Recorder contains calls only for roomName W1N1 and zero calls for W2N1.
    Evidence: .sisyphus/evidence/task-5-hub-room-only.txt

  Scenario: Guard and budget enforcement
    Tool: Bash
    Steps: Run tests covering disabled config, low CPU bucket, missing hub room, and maximal content snapshot.
    Expected: Guard cases record zero calls; maximal content records no more than MAX_HUB_VISUAL_CALLS; Jest exits 0.
    Evidence: .sisyphus/evidence/task-5-guards-budget.txt
  ```

  **Commit**: YES | Message: `feat(hub): render readable hub progress panel` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `test(hub): record room visual draw calls`
- Commit 2: `feat(hub): render screen visual progress panel`
- Commit 3: `test(hub): cover visual edge cases`

## Success Criteria
- Hub visual panel is readable and structured in the hub room only.
- Production/product/progress/logistics are visible without reading raw JSON.
- Existing console helpers remain available and unchanged.
- All tests/build commands pass.

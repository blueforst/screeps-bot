# Reusable RoomVisual Rendering Library

## TL;DR
> **Summary**: Add a minimal reusable TypeScript `Panel` rendering library for Screeps `RoomVisual` layouts, then migrate the hub progress visual panel to it to eliminate element offset bugs caused by manual cursor math and text-baseline mismatches.
> **Deliverables**:
> - `src/visual/panel.ts` with cursor-owned `Panel` class and minimal `VisualSurface` typing
> - `src/visual/palette.ts` with structural visual colors shared by hub rendering
> - `src/visual/panel.test.ts` with cursor, baseline, progress bar, and spacer tests
> - Hub visual panel migrated to the library without changing hub data/model/analytics behavior
> - Coordinate regression tests proving the hub panel no longer drifts after the progress bar
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5

## Context
### Original Request
- “规划实现一个渲染库以便复用渲染逻辑”
- Context from prior report: “hub可视化面板存在组件偏移的问题”
- User clarified the map-layer concern is excluded; only element/component offset remains.

### Interview Summary
- Scope confirmed: first version supports the hub panel only.
- API confirmed: ordinary `Panel` class with internal cursor state, not a fluent builder.
- Autoplanner visual migration is explicitly out of scope for this plan.
- The offset bug is an acceptance target for the library migration, not a separate one-off patch.

### Metis Review (gaps addressed)
- Metis identified the concrete offset bug: `drawProgressBar()` returns a next Y value, but `drawHubVisualPanel()` discards it and advances by `HUB_VISUAL_ROW`, creating a 0.1 unit Y drift.
- Metis identified text baseline mismatch: `RoomVisual.rect()` uses top-left origin, while `RoomVisual.text()` uses baseline Y, causing header/progress text to appear offset from their rects.
- Metis warned against over-abstracting. This plan limits the library to the hub panel’s current needs: panel cursor, section header, text row, progress bar, and spacer.
- Metis asked whether corrected coordinates should replace current coordinates. Default applied: corrected coordinates are required because the current coordinates encode the bug.
- Metis asked about `VisualSurface` breadth. Default applied: expose only methods used by first implementation (`rect` and `text`); expand later when a second consumer needs more primitives.
- Metis asked palette ownership. Default applied: structural panel colors move to `src/visual/palette.ts`; hub-specific status color selection remains in hub rendering code.

## Work Objectives
### Core Objective
Create a small reusable `RoomVisual` panel library that prevents Y-cursor drift and text/rect baseline offset, then migrate the hub progress panel to it while preserving the panel’s displayed information and all non-visual hub behavior.

### Deliverables
- New `src/visual/panel.ts` with:
  - `VisualSurface` interface exposing `rect()` and `text()` only
  - `Panel` class with void-returning `sectionHeader()`, `textRow()`, `progressBar()`, `spacer()`, plus `cursorY` and `callsUsed` getters
  - internal baseline compensation helper used by section, row, and progress text
  - no `any` in public API signatures
- New `src/visual/palette.ts` with structural defaults:
  - `VIS_TEXT`, `VIS_HEADER_FILL`, `VIS_PANEL_FILL`, `VIS_PANEL_STROKE`, `VIS_MUTED`
  - Do not move hub status colors if their meaning depends on `HubVisualModel`.
- New `src/visual/panel.test.ts` with deterministic call-recording assertions.
- Updated `src/runtime/hubProgress.ts` visual rendering section to use `Panel`.
- Updated `src/runtime/hubProgress.test.ts` to assert corrected coordinates and unchanged content.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- `npm run build` exits 0.
- `ast-grep` or equivalent search finds no `Game.map.visual` usage introduced in `src/`.
- `grep` or AST search finds no `rv: any` in new visual library or migrated hub visual rendering.
- Hub visual tests prove Logistics Y is based on `Panel.progressBar()` cursor advancement, not manual `HUB_VISUAL_ROW` advancement.

### Must Have
- Cursor state is owned by `Panel`; call sites must not manually maintain Y for normal rows/sections/progress bars.
- `Panel.progressBar()` advances by `barHeight + barPad`, not by the text row height.
- `Panel.sectionHeader()` and `Panel.progressBar()` place text using a baseline compensation helper so text visually sits inside its associated rect.
- Hub panel still renders sections in order: `Hub Production`, `Progress`, `Logistics`.
- Hub panel still shows current production, status/stage/needs-plan rows when present, progress text/bar, logistics counts, up to two blockers, and overflow count.
- `renderHubProgressOverlays()` remains the public entry point called by `src/main.ts`.
- Existing console/debug helpers `buildHubOverlayLines()`, `collectHubProgressSnapshot()`, and `runHubProgressAnalytics()` keep their behavior.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not modify `src/modules/autoplanner/RoomVisual.js`, `src/modules/autoplanner/planner.js`, or `src/modules/autoplanner/MinCut.js`.
- Do not add `Game.map.visual` or map-layer rendering.
- Do not change hub production, synthesis, resource scheduling, terminal, or market logic.
- Do not add grid/table/chart/multi-column abstractions in this first version.
- Do not introduce screenshots or manual in-game inspection as required verification.
- Do not add comments/docstrings unless they explain non-obvious Screeps text baseline math; prefer self-documenting names.
- Do not create a theming framework. `palette.ts` is constants only.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest; write failing panel and hub-coordinate regression tests before implementation.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (Panel API TDD), Task 2 (palette/constants TDD)
Wave 2: Task 3 (Panel implementation), Task 4 (hub migration)
Wave 3: Task 5 (coordinate regressions), Task 6 (cleanup/search/build verification)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | none | 3 |
| 2 | none | 3, 4 |
| 3 | 1, 2 | 4, 5 |
| 4 | 3 | 5, 6 |
| 5 | 4 | 6 |
| 6 | 5 | final verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Tasks | Recommended Categories |
|------|-------|------------------------|
| 1 | 2 | quick, quick |
| 2 | 2 | unspecified-high, unspecified-high |
| 3 | 2 | quick, unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add failing tests for the minimal Panel API

  **What to do**: Create `src/visual/panel.test.ts` before implementation. Use the existing `RoomVisualMock` recorder from `test/setup.ts`. Add tests that instantiate a planned `Panel` API and initially fail because `src/visual/panel.ts` does not exist yet. Tests must cover `sectionHeader()`, `textRow()`, `progressBar()`, `spacer()`, `cursorY`, and `callsUsed`.
  **Must NOT do**: Do not implement `Panel` in this task. Do not modify hub rendering yet. Do not modify `test/setup.ts` unless a test cannot access recorded calls at all; raw `__roomVisualCalls` should be enough.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Small test-first task with a clear target API.
  - Skills: [`superpowers:test-driven-development`] - Required because this defines RED tests first.
  - Omitted: [`frontend-ui-ux`] - No browser UI or styling implementation.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [3] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/hubProgress.test.ts` - existing visual call recorder usage and `findCalls()` style assertions.
  - Pattern: `test/setup.ts` - `RoomVisualMock` records `{ roomName, method, args }` to `global.__roomVisualCalls` and resets between tests.
  - External: `https://github.com/screeps/docs/blob/master/api/source/RoomVisual.md` - `RoomVisual.text()` uses baseline Y; `RoomVisual.rect()` uses top-left origin.
  - External: `https://github.com/glitchassassin/screeps-viz/blob/377f688a99319294c8cc46302d437ed3a4f220ef/src/widgets/Label.ts` - baseline compensation precedent.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- src/visual/panel.test.ts` fails before implementation because `Panel`/`palette` module is missing or methods are unimplemented.
  - [ ] Tests assert `sectionHeader("Title")` emits exactly one `rect` and one `text` call, advances `cursorY` by the configured header stride, and places the title baseline within the header rect vertical bounds.
  - [ ] Tests assert `textRow("hello")` emits one `text` call and advances by row height.
  - [ ] Tests assert `progressBar(0.5, "#00ff88", "500/1000")` emits outline rect, fill rect, and centered text, and advances by `barHeight + barPad`.
  - [ ] Tests assert `progressBar(0, ...)` emits no fill rect but advances by the same progress stride.
  - [ ] Tests assert `spacer(0.5)` advances cursor without emitting any visual calls.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: RED Panel API tests
    Tool: Bash
    Steps: Run `npm run test -- src/visual/panel.test.ts` immediately after adding tests.
    Expected: Command fails for missing/unimplemented `Panel` API, proving tests are red.
    Evidence: .sisyphus/evidence/task-1-panel-red.log

  Scenario: Recorder integrity check
    Tool: Bash
    Steps: Run the same test and inspect failure output for recorded `rect`/`text` assertions rather than unrelated Jest setup failures.
    Expected: Failure reason is missing API or expected call mismatch; no global RoomVisual setup crash.
    Evidence: .sisyphus/evidence/task-1-recorder-red.log
  ```

  **Commit**: NO | Message: `test(visual): add panel renderer contract tests` | Files: [`src/visual/panel.test.ts`]

- [x] 2. Add failing palette extraction tests and import contract

  **What to do**: Create `src/visual/palette.test.ts` with minimal expectations that import structural color constants from `@/visual/palette`. The contract must include `VIS_TEXT`, `VIS_HEADER_FILL`, `VIS_PANEL_FILL`, `VIS_PANEL_STROKE`, and `VIS_MUTED`. These tests should be red until `palette.ts` exists.
  **Must NOT do**: Do not move hub-specific status decision functions (`getStatusColor`, `getProgressColor`) into palette. Do not create theme objects, classes, or runtime config.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Small import/constant contract.
  - Skills: [`superpowers:test-driven-development`] - RED constants test before implementation.
  - Omitted: [`ai-slop-remover`] - Not useful until implementation exists.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [3, 4] | Blocked By: []

  **References**:
  - Pattern: `src/runtime/hubProgress.ts` - existing structural visual constants near the top of the file: text, header fill, stroke, muted.
  - Constraint: Hub-specific OK/WARN/ERROR status colors may stay in `hubProgress.ts` if they depend on `HubVisualModel` semantics.

  **Acceptance Criteria**:
  - [ ] Palette import test fails before `src/visual/palette.ts` exists.
  - [ ] Contract names are exact: `VIS_TEXT`, `VIS_HEADER_FILL`, `VIS_PANEL_FILL`, `VIS_PANEL_STROKE`, `VIS_MUTED`.
  - [ ] No test requires a theme object or runtime configuration.

  **QA Scenarios**:
  ```
  Scenario: RED palette import
    Tool: Bash
    Steps: Run `npm run test -- src/visual/palette.test.ts`.
    Expected: Command fails due to missing `@/visual/palette` or missing constants only.
    Evidence: .sisyphus/evidence/task-2-palette-red.log

  Scenario: Scope check for palette
    Tool: Grep
    Steps: Search added test file(s) for `theme`, `Theme`, `statusColor`, and `progressColor`.
    Expected: No theme framework or hub-specific status selector is required by palette tests.
    Evidence: .sisyphus/evidence/task-2-palette-scope.txt
  ```

  **Commit**: NO | Message: `test(visual): define palette constant contract` | Files: [`src/visual/palette.test.ts`]

- [x] 3. Implement the minimal visual Panel library

  **What to do**: Create `src/visual/palette.ts` and `src/visual/panel.ts`. Implement `VisualSurface` with `rect()` and `text()` signatures only. Implement a `Panel` class with constructor options `{ rv, x, y, width, rowHeight?, headerHeight?, headerStride?, barHeight?, barPad?, paddingX? }`. Implement void-returning methods `sectionHeader(title)`, `textRow(text, style?)`, `progressBar(percent, fillColor, label)`, and `spacer(height?)`, plus readonly getters `cursorY` and `callsUsed`. Methods must mutate internal cursor state; callers must not depend on return values for cursor correctness.
  **Must NOT do**: Do not add grid/table/chart/multi-column APIs. Do not expose `any`. Do not import hub runtime types into `src/visual/`. Do not use `backgroundColor` for text baseline alignment because it changes vertical semantics; use explicit baseline compensation.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: New reusable module with exact geometry requirements.
  - Skills: [`superpowers:test-driven-development`] - Must turn RED tests green without widening scope.
  - Omitted: [`frontend-ui-ux`] - This is deterministic RoomVisual geometry, not browser UI design.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [4, 5, 6] | Blocked By: [1, 2]

  **References**:
  - Pattern: `src/runtime/hubProgress.ts` - existing row height `0.7`, header height `0.55`, bar height `0.45`, bar pad `0.15`, padding `0.25`.
  - External: `https://github.com/screeps/docs/blob/master/api/source/RoomVisual.md` - `text()` baseline and `rect()` top-left behavior.
  - External: `https://github.com/glitchassassin/screeps-viz/blob/377f688a99319294c8cc46302d437ed3a4f220ef/src/widgets/Label.ts` - use as precedent for internal baseline compensation, not as a dependency.

  **Acceptance Criteria**:
  - [ ] `npm run test -- src/visual/panel.test.ts` passes.
  - [ ] `npx tsc --noEmit` passes for the new visual module.
  - [ ] `src/visual/panel.ts` exports `Panel` and `VisualSurface`.
  - [ ] `VisualSurface` has typed `rect` and `text` methods and no `any` in its public signatures.
  - [ ] `Panel.progressBar(0, ...)` does not emit a fill rect and still advances by `barHeight + barPad`.
  - [ ] `Panel.callsUsed` increments by actual emitted `RoomVisual` primitive calls.

  **QA Scenarios**:
  ```
  Scenario: Panel tests turn green
    Tool: Bash
    Steps: Run `npm run test -- src/visual/panel.test.ts`.
    Expected: All Panel and palette contract tests pass.
    Evidence: .sisyphus/evidence/task-3-panel-green.log

  Scenario: Type-safety check
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: TypeScript exits 0; no `any`-based signature errors or missing module aliases.
    Evidence: .sisyphus/evidence/task-3-tsc.log
  ```

  **Commit**: YES | Message: `feat(visual): add reusable RoomVisual panel renderer` | Files: [`src/visual/panel.ts`, `src/visual/palette.ts`, `src/visual/panel.test.ts`, `src/visual/palette.test.ts`]

- [x] 4. Migrate hub visual rendering to Panel without changing hub data logic

  **What to do**: Update `src/runtime/hubProgress.ts` so `drawHubVisualPanel(rv, model)` delegates layout to `Panel`. Replace `drawSection()` and `drawProgressBar()` internals or remove them if no references remain. Keep `buildHubVisualModel()`, snapshot collection, analytics, overlay-line helper, and `renderHubProgressOverlays()` signature unchanged. Preserve the same visible sections and rows.
  **Must NOT do**: Do not modify `src/main.ts`, `src/runtime/consoleCommands.ts`, hub planner, synthesis, resource control, market, or autoplanner files. Do not add new hub visual rows or sections. Do not add `Game.map.visual`.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Refactor with behavior preservation and integration tests.
  - Skills: [`superpowers:test-driven-development`] - Existing tests plus new regressions must guide migration.
  - Omitted: [`git-master`] - Committing happens after final verification, not during implementation task dispatch.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [5, 6] | Blocked By: [3]

  **References**:
  - Pattern: `src/runtime/hubProgress.ts:buildHubVisualModel` - data model must remain the source of display rows.
  - Pattern: `src/runtime/hubProgress.ts:renderHubProgressOverlays` - guard logic and `new RoomVisual(snapshot.hubRoomName)` must remain.
  - Pattern: `src/visual/panel.ts` - use `Panel.sectionHeader`, `Panel.textRow`, `Panel.progressBar`, `Panel.spacer` instead of manual `let y` and `y +=`.

  **Acceptance Criteria**:
  - [ ] `drawHubVisualPanel()` uses `Panel` for all section, row, progress-bar, and spacer cursor advancement.
  - [ ] No manual `y += HUB_VISUAL_ROW` remains in `drawHubVisualPanel()`.
  - [ ] Hub sections still render in order: Hub Production → Progress → Logistics.
  - [ ] Existing hub visual content tests still pass after updating only intentional coordinate expectations.
  - [ ] `renderHubProgressOverlays()` still constructs `new RoomVisual(snapshot.hubRoomName)` and calls `drawHubVisualPanel(rv, model)` or an equivalent Panel-backed renderer.

  **QA Scenarios**:
  ```
  Scenario: Hub panel content preserved
    Tool: Bash
    Steps: Run `npm run test -- src/runtime/hubProgress.test.ts`.
    Expected: Hub visual tests pass and still find Product, Progress, Logistics, logistics counts, blockers, and overflow rows.
    Evidence: .sisyphus/evidence/task-4-hub-tests.log

  Scenario: No manual cursor drift remains
    Tool: Grep
    Steps: Search `src/runtime/hubProgress.ts` for `y += HUB_VISUAL_ROW`, `drawProgressBar(`, and `drawSection(`.
    Expected: No manual row cursor increments in `drawHubVisualPanel`; old helpers removed or converted to Panel usage.
    Evidence: .sisyphus/evidence/task-4-no-manual-cursor.txt
  ```

  **Commit**: YES | Message: `refactor(hub): render progress panel with visual library` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 5. Add hub coordinate regression coverage for the offset bug

  **What to do**: Strengthen `src/runtime/hubProgress.test.ts` with exact coordinate assertions for minimal and full hub visual models. Tests must prove the Logistics header Y is based on the progress bar stride (`barHeight + barPad`) and not a text row stride. Add assertions for panel/section/text vertical relationships that would have failed with the old manual cursor bug.
  **Must NOT do**: Do not require screenshot comparison or manual in-game inspection. Do not assert brittle call order unless matching by text/style is insufficient.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Focused regression tests after migration.
  - Skills: [`superpowers:test-driven-development`] - Regression tests must fail on old bug and pass on new implementation.
  - Omitted: [`librarian`] - API research is already captured in this plan.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [6] | Blocked By: [4]

  **References**:
  - Bug source: old `src/runtime/hubProgress.ts` ignored `drawProgressBar()` return and advanced by `HUB_VISUAL_ROW`, causing a 0.1 Y drift.
  - Pattern: `src/runtime/hubProgress.test.ts` `findCalls()` helper and `global.__roomVisualCalls` usage.
  - Pattern: `src/visual/panel.test.ts` coordinate and cursor assertions.

  **Acceptance Criteria**:
  - [ ] Minimal model test asserts exact Y for Hub Production header, Progress header, progress bar outline, Logistics header, logistics summary, and `blockers: none` row.
  - [ ] Full model test asserts exact Y for status row, stage row, needs-plan row, Progress header, progress bar, Logistics header, first blocker row, second blocker row, and overflow row.
  - [ ] Test explicitly documents in assertion names that Logistics follows progress bar stride, not row height.
  - [ ] `npm run test -- src/runtime/hubProgress.test.ts src/visual/panel.test.ts` passes.

  **QA Scenarios**:
  ```
  Scenario: Minimal layout regression
    Tool: Bash
    Steps: Run targeted tests for minimal/idle hub model coordinate assertions.
    Expected: Logistics Y equals Progress-header-nextY + progress bar stride; no 0.1-unit old drift.
    Evidence: .sisyphus/evidence/task-5-minimal-layout.log

  Scenario: Full layout regression
    Tool: Bash
    Steps: Run targeted tests for full hub model with status, stage, needsPlan, two blockers, and overflow.
    Expected: All optional rows advance deterministically and remain below their previous row with expected stride.
    Evidence: .sisyphus/evidence/task-5-full-layout.log
  ```

  **Commit**: NO | Message: `test(hub): cover visual panel coordinate regressions` | Files: [`src/runtime/hubProgress.test.ts`]

- [x] 6. Run scope, type, test, build, and visual API verification

  **What to do**: Run the full verification suite and static searches. Fix only issues directly caused by the visual library migration. Verify no scope creep and no accidental map/autoplanner changes.
  **Must NOT do**: Do not deploy, commit, or push from this task unless the user explicitly runs the work-session commit/deploy flow. Do not make unrelated cleanup changes.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Cross-file verification and cleanup.
  - Skills: [`superpowers:verification-before-completion`] - Evidence before completion claims.
  - Omitted: [`frontend-ui-ux`] - No visual design iteration; deterministic tests only.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [final verification] | Blocked By: [5]

  **References**:
  - Commands from `AGENTS.md`: `npx tsc --noEmit`, `npm run test`, `npm run build`.
  - Scope guard: only expected source paths are `src/visual/*`, `src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`, and possibly `test/setup.ts` if recorder helpers are truly needed.

  **Acceptance Criteria**:
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] Search for `Game.map.visual` in `src/` returns no new references.
  - [ ] Search confirms no changes to `src/modules/autoplanner/RoomVisual.js`, `planner.js`, or `MinCut.js`.
  - [ ] Search confirms no `rv: any` in `src/visual/` or hub visual rendering.
  - [ ] Visual call budget remains at or below `MAX_HUB_VISUAL_CALLS`.

  **QA Scenarios**:
  ```
  Scenario: Full automated verification
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-6-full-verification.log

  Scenario: Scope and forbidden API verification
    Tool: Grep / AST-grep
    Steps: Search for `Game.map.visual`, changed autoplanner files, and `rv: any` in visual rendering code.
    Expected: No forbidden API or scope creep; no `rv: any` remains in migrated rendering code.
    Evidence: .sisyphus/evidence/task-6-scope-search.txt
  ```

  **Commit**: NO | Message: `chore(visual): verify panel renderer migration` | Files: [verification evidence only]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `feat(visual): add reusable RoomVisual panel renderer` — `src/visual/panel.ts`, `src/visual/palette.ts`, `src/visual/panel.test.ts`.
- Commit 2: `refactor(hub): render progress panel with visual library` — `src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`.
- If test/setup changes become necessary, include them in Commit 1 with the visual library tests; otherwise leave `test/setup.ts` unchanged.

## Success Criteria
- Hub panel visual output uses `Panel`, not manual Y cursor tracking.
- Element offset regression is covered by exact coordinate tests.
- Visual library is minimal and reusable without touching autoplanner legacy visuals.
- All verification commands pass.

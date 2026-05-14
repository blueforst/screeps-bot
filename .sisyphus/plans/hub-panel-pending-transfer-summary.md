# Hub Panel Pending Transfer Summary

## TL;DR
> **Summary**: Replace the hub panel's reserve/blocker display with compact inbound transfer totals grouped by source room. Keep existing hub transfer counting and analytics snapshot compatibility; only rendering/model presentation changes.
> **Deliverables**:
> - Hub visual model exposes `inboundRows` / `inboundOverflow` derived from `snapshot.pendingTasks`.
> - RoomVisual panel shows inbound transfer totals by source room instead of `reserve` rows.
> - Text overlay line shows inbound summary instead of `blocker`/`reserve`.
> - Jest regressions cover aggregation, filtering, rendering, overflow, and no-inbound states.
> **Effort**: Short
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Final Verification

## Context
### Original Request
- “hub面板的reserve没必要显示, 意义不大. 可以在hub面板显示其他房间内待转运的资源数量.”

### Interview Summary
- Display grouping: by source room.
- Transfer scope: inbound-to-hub tasks only, from non-hub rooms into the hub.
- Test strategy: TDD.

### Metis Review (gaps addressed)
- Guardrail: update all display surfaces that show reserve/blocker data: RoomVisual panel, visual model, and text overlay.
- Guardrail: use `snapshot.pendingTasks`; do not change `countPendingHubTasks()` because it already captures hub-related pending task details.
- Guardrail: do not change logistics count display (`imp X | recl Y | exp Z`), because counts and inbound quantity rows answer different questions.
- Guardrail: do not change `HubProgressSnapshot.roomTerminalBlockers` shape or `runHubProgressAnalytics()` persistence; external monitor consumers may read raw analytics snapshots.
- Auto-resolved ambiguity: mixed resources from a room are summed as generic Screeps resource units and displayed with the existing compact numeric format. The row includes task count when count > 1 to reduce ambiguity.

## Work Objectives
### Core Objective
Remove reserve information from the hub panel/overlay and replace it with per-source-room inbound transfer totals using existing pending hub transfer task data.

### Deliverables
- `src/runtime/hubProgress.ts` derives inbound rows by grouping `snapshot.pendingTasks` where `task.to === snapshot.hubRoomName` and `task.from !== snapshot.hubRoomName`.
- The visual panel Logistics section keeps `imp/recl/exp` counts and below it displays up to 2 inbound rows.
- The overlay line uses an inbound summary and never emits `reserve=` or `blocker:` for the hub panel summary.
- `src/runtime/hubProgress.test.ts` contains RED-first regressions for model aggregation, panel rendering, overlay output, export exclusion, and overflow.

### Definition of Done (verifiable conditions with commands)
- `npm run test -- hubProgress.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- Repository search for rendered panel/overlay text in `src/runtime/hubProgress.ts` finds no `reserve` emission in `drawHubVisualPanel()` or `buildHubOverlayLines()`.
- Existing `HubProgressSnapshot.roomTerminalBlockers` remains present for analytics compatibility.

### Must Have
- TDD: add/update failing tests before implementation in each task.
- Inbound filter: include only tasks with `to === snapshot.hubRoomName` and `from !== snapshot.hubRoomName`.
- Source-room grouping: one row per source room.
- Amount aggregation: sum `remaining` across all included tasks for a source room.
- Ordering: sort rows by total remaining descending, then source room name ascending for deterministic output.
- Row cap: display first 2 inbound rows and show overflow count for additional rooms.
- Empty state: show `inbound: none` when there are no inbound tasks.
- Export exclusion: tasks where `from === snapshot.hubRoomName` must not contribute to inbound rows.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must NOT modify hub planner, resource control, terminal send behavior, transfer task creation, or task execution.
- Must NOT change `countPendingHubTasks()` classification behavior.
- Must NOT remove or rename `HubProgressSnapshot.roomTerminalBlockers`.
- Must NOT change the `imp X | recl Y | exp Z` logistics count line.
- Must NOT add new Memory fields or config knobs.
- Must NOT require human visual confirmation for acceptance.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest (`ts-jest`) using existing `src/runtime/hubProgress.test.ts` and `test/setup.ts` RoomVisual mock patterns.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (aggregation/model foundation)
Wave 2: Task 2 (RoomVisual panel rendering)
Wave 3: Task 3 (text overlay rendering)
Wave 4: Task 4 (compatibility sweep and verification)

### Dependency Matrix (full, all tasks)
| Task | Blocked By | Blocks |
|------|------------|--------|
| 1. Inbound model foundation | None | 2, 3, 4 |
| 2. RoomVisual panel rendering | 1 | 4 |
| 3. Text overlay rendering | 1 | 4 |
| 4. Compatibility sweep | 1, 2, 3 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Count | Categories |
|------|-------|------------|
| 1 | 1 | quick |
| 2 | 1 | quick |
| 3 | 1 | quick |
| 4 | 1 | quick |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add inbound-by-source visual model data

  **What to do**:
  - In `src/runtime/hubProgress.test.ts`, first add/update tests for `buildHubVisualModel()` that expect inbound rows derived from `snapshot.pendingTasks`.
  - In `src/runtime/hubProgress.ts`, add a local helper near `buildHubVisualModel()` such as `buildInboundTransferRows(snapshot)`.
  - Helper behavior must be exact:
    - Include tasks where `task.to === snapshot.hubRoomName`.
    - Exclude tasks where `task.from === snapshot.hubRoomName`.
    - Sum `task.remaining` by `task.from`.
    - Count included tasks per source room.
    - Sort by `amount` descending, then `room` ascending.
  - Change `HubVisualModel` from `blockerRows/blockerOverflow` to `inboundRows/inboundOverflow` only for the visual model layer.
  - Keep `HubProgressSnapshot.roomTerminalBlockers` and `buildRoomTerminalBlockers()` unchanged for analytics compatibility.

  **Must NOT do**:
  - Do not modify `ResourceTransferTask`, `countPendingHubTasks()`, `HubProgressSnapshot`, or `collectHubProgressSnapshot()`.
  - Do not include hub exports or non-hub-to-non-hub tasks.

  **Recommended Agent Profile**:
  - Category: `quick` - Small, localized TypeScript/test change in one runtime module.
  - Skills: [] - No special skill needed; use existing Jest and TypeScript patterns.
  - Omitted: [`frontend-ui-ux`, `playwright`] - This is Screeps RoomVisual model code, not browser UI.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3, 4] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/hubProgress.ts:48-79` - `HubProgressSnapshot` includes `hubRoomName`, `pendingTasks`, and compatibility-only `roomTerminalBlockers`.
  - Pattern: `src/runtime/hubProgress.ts:110-121` - Current `HubVisualModel` fields to replace at the model layer.
  - Pattern: `src/runtime/hubProgress.ts:123-172` - `buildHubVisualModel()` derives current display model and caps row count at 2.
  - Pattern: `src/runtime/hubProgress.ts:281-320` - Existing pending hub task collection; do not change classification.
  - Pattern: `src/runtime/hubProgress.ts:322-354` - Existing reserve/blocker builder; keep unchanged for analytics compatibility.
  - Test: `src/runtime/hubProgress.test.ts` - Existing `buildHubVisualModel()` tests and snapshot factory patterns.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- hubProgress.test.ts` fails before implementation due to new inbound model expectations.
  - [ ] After implementation, `npm run test -- hubProgress.test.ts` passes for model tests.
  - [ ] A test with two inbound tasks from `W2N1` to hub `W1N1` with `remaining` 3000 and 5000 produces one row `{ room: "W2N1", amount: 8000, taskCount: 2 }`.
  - [ ] A task from hub `W1N1` to `W2N1` is excluded.
  - [ ] Three source rooms produce 2 visible rows and `inboundOverflow === 1`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Inbound rows aggregate by source room
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts --runInBand` after adding model tests and implementation.
    Expected: Test asserting W2N1 3000+5000 => 8000 passes; model exposes exactly one W2N1 inbound row.
    Evidence: .sisyphus/evidence/task-1-inbound-model.txt

  Scenario: Hub exports are excluded
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts --runInBand` with a fixture containing W1N1->W2N1 export and W3N1->W1N1 inbound.
    Expected: Model contains W3N1 only; W2N1 export destination is absent from inbound rows.
    Evidence: .sisyphus/evidence/task-1-export-excluded.txt
  ```

  **Commit**: NO | Message: N/A | Files: [src/runtime/hubProgress.ts, src/runtime/hubProgress.test.ts]

- [x] 2. Render inbound rows in the RoomVisual panel

  **What to do**:
  - In `src/runtime/hubProgress.test.ts`, first update `drawHubVisualPanel()` tests so the Logistics section expects inbound row text instead of reserve/blocker row text.
  - In `src/runtime/hubProgress.ts:184-225`, replace the `model.blockerRows` rendering block with `model.inboundRows` rendering.
  - Required display format:
    - Single task row: `${room}: ${formatEnergy(amount)} inbound`
    - Multiple task row: `${room}: ${formatEnergy(amount)} inbound (${taskCount} tasks)`
    - Overflow row: `+${inboundOverflow} more inbound`
    - Empty state: `inbound: none`
  - Use `VIS_WARN` for inbound rows and `VIS_MUTED` for overflow/empty rows, matching current visual hierarchy.

  **Must NOT do**:
  - Do not remove the `imp ${imports} | recl ${reclaims} | exp ${exports}` line.
  - Do not render `reserve`, `term`, or `nonE` in the hub panel inbound section.

  **Recommended Agent Profile**:
  - Category: `quick` - Local rendering/test update with existing visual mock coverage.
  - Skills: [] - RoomVisual is tested through project mocks.
  - Omitted: [`playwright`] - No browser surface exists.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [4] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/hubProgress.ts:184-225` - Current panel render flow and blocker row styling.
  - Pattern: `src/runtime/hubProgress.ts:104-108` - Compact numeric formatting helper to reuse for generic resource units.
  - Pattern: `test/setup.ts` - `RoomVisualMock` records calls in `global.__roomVisualCalls`.
  - Test: `src/runtime/hubProgress.test.ts` - Existing `drawHubVisualPanel()` assertions for text rows and layout.
  - Test: `src/visual/panel.test.ts` - Generic Panel/RoomVisual assertion style.

  **Acceptance Criteria**:
  - [ ] `npm run test -- hubProgress.test.ts` includes a panel test where W2N1 row renders `W2N1: 8.0K inbound (2 tasks)`.
  - [ ] Empty model renders `inbound: none`.
  - [ ] Overflow renders `+1 more inbound` when three source rooms exist.
  - [ ] No RoomVisual text call in the panel test contains `reserve`, `blocker`, `term`, or `nonE` for the inbound section.

  **QA Scenarios**:
  ```
  Scenario: Panel renders inbound row
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts --runInBand` and inspect the saved Jest output.
    Expected: RoomVisual mock assertion finds `W2N1: 8.0K inbound (2 tasks)` and the test passes.
    Evidence: .sisyphus/evidence/task-2-panel-inbound.txt

  Scenario: Panel no longer renders reserve/blocker text
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts --runInBand`; include a test that filters `global.__roomVisualCalls` text arguments for `reserve`, `blocker`, `term`, and `nonE`.
    Expected: No matching calls are found in the inbound section; `inbound: none` appears for empty inbound rows.
    Evidence: .sisyphus/evidence/task-2-panel-no-reserve.txt
  ```

  **Commit**: NO | Message: N/A | Files: [src/runtime/hubProgress.ts, src/runtime/hubProgress.test.ts]

- [x] 3. Replace overlay blocker/reserve line with inbound summary

  **What to do**:
  - In `src/runtime/hubProgress.test.ts`, first update `buildHubOverlayLines()` tests so overlay line 8 expects inbound summary output.
  - In `src/runtime/hubProgress.ts:480-521`, replace the `blocker:` line with inbound summary derived from the same helper/model logic as the panel.
  - Required overlay behavior:
    - If inbound rows exist, add `inbound: W2N1 8.0K (2 tasks)` using the highest-priority row after sorting.
    - If there are more inbound source rooms, append `, +N more` to the same line while respecting `MAX_OVERLAY_LINES`.
    - If no inbound rows exist, omit the inbound line; do not add `blocker:` fallback.
  - Keep previous overlay status/stage/plan/missing/error/energy/tasks lines unchanged.

  **Must NOT do**:
  - Do not change the `tasks: X imp, Y recl, Z exp` line.
  - Do not emit `reserve=` or `blocker:` in overlay output.

  **Recommended Agent Profile**:
  - Category: `quick` - Local overlay string/test update.
  - Skills: [] - Existing Jest tests are sufficient.
  - Omitted: [`frontend-ui-ux`] - This is text overlay formatting, not design work.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [4] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/hubProgress.ts:480-521` - Current overlay line construction and max line cap.
  - Pattern: `src/runtime/hubProgress.ts:123-172` - Reuse same inbound aggregation semantics as the visual model.
  - Test: `src/runtime/hubProgress.test.ts` - Existing `buildHubOverlayLines()` expectations and snapshot factory.

  **Acceptance Criteria**:
  - [ ] Overlay test with W2N1 inbound 8000 across 2 tasks includes `inbound: W2N1 8.0K (2 tasks)`.
  - [ ] Overlay test with no inbound tasks contains no line starting with `blocker:` and no string containing `reserve=`.
  - [ ] Overlay still returns at most 8 lines.

  **QA Scenarios**:
  ```
  Scenario: Overlay shows top inbound source room
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts --runInBand` with overlay fixture containing W2N1=8000 and W3N1=4000 inbound.
    Expected: Output lines include `inbound: W2N1 8.0K (2 tasks), +1 more`.
    Evidence: .sisyphus/evidence/task-3-overlay-inbound.txt

  Scenario: Overlay omits reserve/blocker when no inbound transfers exist
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts --runInBand` with overlay fixture containing no inbound pending tasks.
    Expected: No output line starts with `blocker:`; no output line contains `reserve=`; all existing status/task lines still pass.
    Evidence: .sisyphus/evidence/task-3-overlay-no-reserve.txt
  ```

  **Commit**: NO | Message: N/A | Files: [src/runtime/hubProgress.ts, src/runtime/hubProgress.test.ts]

- [x] 4. Compatibility sweep and full local verification

  **What to do**:
  - Search `src/runtime/hubProgress.ts` for rendered reserve/blocker strings after Tasks 1-3.
  - Confirm `HubProgressSnapshot.roomTerminalBlockers` still exists at the snapshot/analytics layer.
  - Confirm `buildRoomTerminalBlockers()` remains unchanged unless TypeScript requires only formatting-safe cleanup.
  - Run targeted and full verification commands.
  - Save command outputs to `.sisyphus/evidence/`.

  **Must NOT do**:
  - Do not run `npm run push` in this task; deploy only after final verification approval.
  - Do not introduce unrelated formatting changes outside `src/runtime/hubProgress.ts` and `src/runtime/hubProgress.test.ts`.

  **Recommended Agent Profile**:
  - Category: `quick` - Verification and small cleanup only.
  - Skills: [] - Standard local checks.
  - Omitted: [`git-master`] - Commit is deferred to commit strategy after final approval.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [Final Verification] | Blocked By: [1, 2, 3]

  **References**:
  - Pattern: `src/runtime/hubProgress.ts:48-79` - Snapshot compatibility contract.
  - Pattern: `src/runtime/hubProgress.ts:464-478` - `runHubProgressAnalytics()` persists the snapshot unchanged.
  - Command: `npm run test -- hubProgress.test.ts`
  - Command: `npm run test`
  - Command: `npx tsc --noEmit`
  - Command: `npm run build`

  **Acceptance Criteria**:
  - [ ] `npm run test -- hubProgress.test.ts` passes.
  - [ ] `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run build` passes.
  - [ ] `src/runtime/hubProgress.ts` panel and overlay rendering no longer emit `reserve`.
  - [ ] `HubProgressSnapshot.roomTerminalBlockers` remains in the interface and snapshot return object.

  **QA Scenarios**:
  ```
  Scenario: Full regression commands pass
    Tool: Bash
    Steps: Run `npm run test -- hubProgress.test.ts`, `npm run test`, `npx tsc --noEmit`, and `npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-4-verification.txt

  Scenario: Analytics compatibility is preserved
    Tool: Bash
    Steps: Run a static check/search confirming `HubProgressSnapshot` and `buildHubProgressSnapshot()` still include `roomTerminalBlockers`.
    Expected: Snapshot compatibility fields remain; reserve is not rendered in panel/overlay strings.
    Evidence: .sisyphus/evidence/task-4-compatibility.txt
  ```

  **Commit**: YES | Message: `feat(hub): show inbound transfers in hub panel` | Files: [src/runtime/hubProgress.ts, src/runtime/hubProgress.test.ts]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Make one atomic commit after Task 4 verification and final review approval: `feat(hub): show inbound transfers in hub panel`.
- Include only `src/runtime/hubProgress.ts` and `src/runtime/hubProgress.test.ts` unless verification reveals a strictly necessary adjacent test fixture update.
- After user approves final verification, deploy with `npm run push` per project workflow.

## Success Criteria
- Hub RoomVisual panel no longer displays reserve/blocker rows.
- Hub panel displays inbound pending transfer totals grouped by source room.
- Hub overlay no longer emits `blocker:` or `reserve=`.
- Inbound rows exclude hub exports and non-hub-to-non-hub transfer tasks.
- Existing hub analytics snapshot shape remains compatible.
- All Jest, TypeScript, and build verification commands pass.

# Survival Satellite Mineral Hub Imports

## TL;DR
> **Summary**: Fix `hubPlanner.planHubImports()` so survival-state satellite rooms can still send non-energy mineral surplus to the hub. Live data confirmed `E3N59` has `95,086 H` but is skipped only because `state="survival"`.
> **Deliverables**:
> - TDD regression coverage for H-rich survival satellites.
> - Remove the blanket survival skip in `planHubImports()`.
> - Verify no energy-export, distribution, market, or terminal execution behavior changes.
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3 → Final Verification

## Context
### Original Request
- “产H的房间不知为何没有将H发送到hub”
- “satellite房间的逻辑似乎也没生效”
- “并没有生成相关任务”
- “E3N59是产H的”

### Interview Summary
- Live Screeps data was fetched read-only through the existing monitor/API credentials.
- Relevant shard: `shard1`.
- Hub room: `E4N58`.
- `Memory.runtime.resourceTransfers` has `0` transfer tasks.
- `runtime.hub.missingResources` includes `H`.
- `E3N59` has `state="survival"`, `storageEnergy=77418`, `terminalEnergy=21819`, `energyFloor=120000`, `H=95086`.
- User chose the fix strategy: allow survival-state satellite rooms to export non-energy mineral surplus to the hub, while still protecting energy.

### Metis Review (gaps addressed)
- Metis identified the exact root cause as the unconditional survival skip in `src/runtime/hubPlanner.ts:271-273`.
- Metis recommended the smallest safe production change: remove the survival skip entirely from `planHubImports()` because this function only considers non-energy resources.
- Metis warned that the existing test `"does not create tasks from survival-economy rooms"` must be updated because it currently encodes the broken behavior.
- Metis advised against adding config, diagnostics, or resourceControl changes in this fix.

## Work Objectives
### Core Objective
Generate `hub:import:H` transfer tasks for H-rich survival-state satellite rooms such as `E3N59`, while preserving all existing non-energy safety floors, minimum transfer thresholds, hub-capacity gates, and duplicate-task guards.

### Deliverables
- Updated `src/runtime/hubPlanner.test.ts` regressions.
- Minimal `src/runtime/hubPlanner.ts` behavior change.
- Verification evidence for typecheck and hubPlanner tests.

### Definition of Done (verifiable conditions with commands)
- `npm run test -- --testPathPattern="hubPlanner"` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- `grep -R "if (roomState === \"survival\") continue" src/runtime/hubPlanner.ts` finds no match.
- `git diff -- src/runtime/hubPlanner.ts src/runtime/hubPlanner.test.ts` shows no changes outside those two files.

### Must Have
- Survival satellite with `95086 H` creates a `hub:import:H` task for `94586 H` (`95086 - 500` safety floor).
- Survival satellite with `1000 H` creates a `hub:import:H` task for `500 H`.
- Survival satellite with `500 H` still creates no task.
- Survival satellite with `599 H` still creates no task because sendable amount is `99 < MIN_HUB_IMPORT_AMOUNT`.
- Survival satellite with intermediate compound surplus still creates a `hub:import:<compound>` task.
- Survival satellite with target T3 surplus still creates a `hub:reclaim:<t3>` task.
- Existing hub storage capacity gate still blocks imports when hub storage free capacity is below `storagePauseFreeCapacity`.
- Existing duplicate pending task guard still blocks duplicate `hub:import:H` creation.

### Must NOT Have
- Do not modify `src/runtime/resourceControl.ts`.
- Do not modify terminal send execution, carrier task execution, market behavior, `planHubDistribution()`, hub visuals, or autoplanner files.
- Do not add config options or new Memory schema.
- Do not change `BASE_MINERAL_SAFETY_FLOOR`, `MIN_HUB_IMPORT_AMOUNT`, `reservePerRoom`, or `surplusThreshold`.
- Do not allow energy imports/exports from survival-state rooms through this change.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave is acceptable here because this is a tiny, sequential bugfix.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (TDD regression tests)
Wave 2: Task 2 (minimal implementation)
Wave 3: Task 3 (full verification and scope audit)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 2 |
| 2 | 1 | 3 |
| 3 | 2 | F1-F4 |
| F1-F4 | 3 | Completion |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 1 | quick |
| 3 | 1 | unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add RED regressions for survival satellite mineral imports

  **What to do**: Update `src/runtime/hubPlanner.test.ts` in the existing `describe("planHubImports")` block. Change the existing survival-room test at `src/runtime/hubPlanner.test.ts:672` from expecting zero tasks to expecting mineral import tasks. Add a new E3N59-sized regression using `H=95086` and `state="survival"`. Add threshold edge cases for `500 H` and `599 H` if not already explicitly covered under survival state. Add survival-state coverage for `RESOURCE_HYDROXIDE` intermediate import and configured T3 reclaim, because removing the blanket skip intentionally re-enables all non-energy satellite surplus loops.
  **Must NOT do**: Do not modify production code in this task. Do not add new test utilities outside `hubPlanner.test.ts`. Do not change fixtures unrelated to hub imports.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Focused Jest test changes in one file.
  - Skills: [] - No extra skills required; follow existing test patterns.
  - Omitted: [`librarian`] - No external library behavior needed.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2] | Blocked By: []

  **References**:
  - Pattern: `src/runtime/hubPlanner.test.ts:561-765` - existing `planHubImports` tests and fixtures.
  - Pattern: `src/runtime/hubPlanner.test.ts:672-698` - existing survival-economy test to rename/update.
  - Pattern: `src/runtime/hubPlanner.test.ts:586-599` - existing base mineral import assertion style.
  - Live data: `E3N59` on `shard1` has `state="survival"`, `H=95086`, hub `E4N58`, no transfer tasks.

  **Acceptance Criteria**:
  - [ ] New or updated test asserts survival satellite with `1000 H` creates `import:<sat>:H=500` and a `hub:import:H` transfer task.
  - [ ] New test asserts survival satellite with `95086 H` creates amount `94586`.
  - [ ] Test asserts survival satellite with `500 H` creates no `hub:import:H` task.
  - [ ] Test asserts survival satellite with `599 H` creates no `hub:import:H` task.
  - [ ] Test asserts survival satellite with `RESOURCE_HYDROXIDE=100` creates `hub:import:OH`.
  - [ ] Test asserts survival satellite with configured T3 `XGHO2=1501` creates `hub:reclaim:XGHO2` for `501`.
  - [ ] Running `npm run test -- --testPathPattern="hubPlanner"` fails before Task 2 because production code still skips survival rooms.

  **QA Scenarios**:
  ```
  Scenario: RED survival H import regression
    Tool: Bash
    Steps: Run `npm run test -- --testPathPattern="hubPlanner"` after adding tests but before production change.
    Expected: At least the new survival-H/import/reclaim expectations fail because `planHubImports()` still skips survival rooms.
    Evidence: .sisyphus/evidence/task-1-red-survival-h-import.log

  Scenario: Threshold safety preserved in RED tests
    Tool: Bash
    Steps: Inspect test output for survival `500 H` and `599 H` cases.
    Expected: Threshold tests are present and either pass independently or fail only because setup is blocked by the same survival skip; no expectation asks to drain below safety/minimum thresholds.
    Evidence: .sisyphus/evidence/task-1-threshold-tests.txt
  ```

  **Commit**: NO | Message: `test(hub): cover survival satellite mineral imports` | Files: [`src/runtime/hubPlanner.test.ts`]

- [x] 2. Remove blanket survival skip from hub import planning

  **What to do**: Update `src/runtime/hubPlanner.ts` only. In `planHubImports()`, remove the survival-state gate:
  ```ts
  const roomState = Memory.runtime?.resourceControl?.rooms?.[satellite.name]?.state;
  if (roomState === "survival") continue;
  ```
  Do not replace it with a new condition. The function already ignores `RESOURCE_ENERGY` when aggregating resources and already applies mineral safety floors/minimum send thresholds.
  **Must NOT do**: Do not modify `planHubDistribution()`, `resourceControl.ts`, transfer task execution, market code, or any config schema.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Minimal two-line production change plus test verification.
  - Skills: [] - No extra skills required.
  - Omitted: [`superpowers:brainstorming`] - Decision already made by user and plan.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [3] | Blocked By: [1]

  **References**:
  - Code: `src/runtime/hubPlanner.ts:240-331` - `planHubImports()`.
  - Bug line: `src/runtime/hubPlanner.ts:271-273` - current survival skip.
  - Guardrails: `src/runtime/hubPlanner.ts:275-287` - non-energy resource aggregation only.
  - Guardrails: `src/runtime/hubPlanner.ts:289-301` - base mineral safety floor and minimum import threshold.

  **Acceptance Criteria**:
  - [ ] `planHubImports()` no longer contains `roomState === "survival"` skip logic.
  - [ ] No `RESOURCE_ENERGY` import tasks are created by `planHubImports()`.
  - [ ] `npm run test -- --testPathPattern="hubPlanner"` exits 0.
  - [ ] New survival-H tests from Task 1 pass.
  - [ ] New survival intermediate and T3 reclaim tests from Task 1 pass.
  - [ ] Existing tests for hub storage pause, duplicate tasks, and below-threshold amounts still pass.

  **QA Scenarios**:
  ```
  Scenario: Survival satellite H import now planned
    Tool: Bash
    Steps: Run `npm run test -- --testPathPattern="hubPlanner"`.
    Expected: Tests pass, including survival `95086 H -> 94586` and `1000 H -> 500` import cases.
    Evidence: .sisyphus/evidence/task-2-hubplanner-green.log

  Scenario: No energy import scope creep
    Tool: Grep
    Steps: Search `src/runtime/hubPlanner.ts` for `RESOURCE_ENERGY` and inspect `planHubImports()` resource aggregation.
    Expected: `planHubImports()` continues to skip `RESOURCE_ENERGY` via `res !== RESOURCE_ENERGY`; no new energy task creation path exists.
    Evidence: .sisyphus/evidence/task-2-no-energy-import.txt
  ```

  **Commit**: YES | Message: `fix(hub): import mineral surplus from survival satellites` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 3. Run full verification and live-scenario scope audit

  **What to do**: Verify the tiny fix against project-wide commands and static scope checks. Capture evidence that only `hubPlanner.ts` and `hubPlanner.test.ts` changed. Optionally run a local scripted test fixture or Jest assertion proving the E3N59 live scenario maps to `hub:import:H` creation.
  **Must NOT do**: Do not deploy or commit from this task unless the work-session flow explicitly reaches commit/deploy after final verification. Do not edit additional source files.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Verification and scope audit across the repo.
  - Skills: [] - No extra skills required.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1-F4] | Blocked By: [2]

  **References**:
  - Commands from `AGENTS.md`: `npx tsc --noEmit`, `npm run test`, `npm run build`.
  - Scope guard: only `src/runtime/hubPlanner.ts` and `src/runtime/hubPlanner.test.ts` should change.
  - Live scenario: hub `E4N58`, satellite `E3N59`, `H=95086`, `state="survival"`.

  **Acceptance Criteria**:
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] `git diff --stat -- ':!node_modules' ':!.sisyphus'` lists only `src/runtime/hubPlanner.ts` and `src/runtime/hubPlanner.test.ts`.
  - [ ] Search confirms no changes to `src/runtime/resourceControl.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/hubProgress.ts`, `src/main.ts`, or `src/modules/autoplanner/`.

  **QA Scenarios**:
  ```
  Scenario: Full automated verification
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-3-full-verification.log

  Scenario: Scope audit
    Tool: Bash / Grep
    Steps: Run `git diff --stat -- ':!node_modules' ':!.sisyphus'` and search for unexpected diffs in resourceControl, transfer tasks, visuals, main loop, and autoplanner paths.
    Expected: Only hubPlanner source/test files changed.
    Evidence: .sisyphus/evidence/task-3-scope-audit.txt
  ```

  **Commit**: NO | Message: `chore(hub): verify survival satellite import fix` | Files: [verification evidence only]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Single atomic commit after implementation and verification:
  - `fix(hub): import mineral surplus from survival satellites`
  - Files: `src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`
- Do not commit `.sisyphus/` state or evidence unless repository policy requires it during `/start-work` orchestration.

## Success Criteria
- E3N59-like survival satellite fixtures create `hub:import:H` tasks.
- No energy export behavior is introduced.
- Existing hub planner gates remain intact: hub storage pause, duplicate-task prevention, mineral safety floor, and minimum transfer amount.
- Full TypeScript, Jest, and build verification pass.

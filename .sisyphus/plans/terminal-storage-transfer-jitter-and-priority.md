# Terminal Storage Transfer Jitter and Priority

## TL;DR
> **Summary**: Prevent carrier terminal cleanup from draining protected energy, reduce terminal/storage cleanup jitter, and prioritize mineral container cleanup before resourceControl terminal offload.
> **Deliverables**:
> - Terminal energy cleanup protects `max(25_000, terminalEnergyReserve + pending send fee reserve)` in both energy-offload paths.
> - Terminal overflow offload processes non-energy before energy.
> - Mineral container haul priority rises above resourceControl terminal offload.
> - Regression tests cover 25k energy boundaries, overflow ordering, pending fee protection, and carrier task priority.
> **Effort**: Short
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4

## Context
### Original Request
- “carrier从terminal转移资源到storage会寻路抖动”
- “还有carrier清terminal的时候还会清termianl中的能量储备”
- “还需要把carrier清mineral container的优先级提到清terminal前”
- “terminal中energy小于等于25k时不清energy, 大于25k时可以取”

### Interview Summary
- Terminal energy cleanup must not drain reserve. The effective cleanup floor is `max(25_000, configured terminalEnergyReserve + pending send fee reserve)`.
- `terminalEnergyReserve` remains default `20_000`; do not restore the incorrect `50_000` reserve.
- The existing `TERMINAL_TOTAL_STORAGE_CAP = 250_000` remains; energy counts in that total.
- Mineral container cleanup should outrank resourceControl terminal cleanup/offload.

### Metis Review (gaps addressed)
- Corrected priority fact: actual synthesis `lab_cleanup` priority is 200 and synthesis `lab_supply` priority is 100; `MINERAL_HAUL_PRIORITY = 91` remains valid because it is above resourceControl terminal_offload 90 and below synthesis lab_supply 100.
- Both terminal energy paths must be patched: standard energy offload in `createEnergyTerminalTask()` and terminal overflow offload in `syncTerminalFeedTasks()`.
- Overflow resource order must be deterministic: non-energy first, energy last.
- No hysteresis/control-loop redesign; use the 25k floor and existing batch behavior.

## Work Objectives
### Core Objective
Stop terminal cleanup from causing carrier jitter and reserve draining while keeping existing hub terminal capacity policy intact.

### Deliverables
- `src/runtime/resourceControl.ts` energy protection helper/floor used in both terminal energy offload paths.
- `src/runtime/resourceControl.test.ts` regression coverage for 25k floor, pending fee reserve, overflow ordering, and stability.
- `src/runtime/mineralExtraction.ts` mineral haul priority raised to 91.
- `src/runtime/mineralExtraction.test.ts` expected mineral haul priority updated.
- `src/roles/carrier.test.ts` carrier task selection proves mineral_haul beats resourceControl terminal_offload.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
- `npx jest --config jest.config.cjs src/runtime/mineralExtraction.test.ts src/roles/carrier.test.ts` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- `npm run build` exits 0.

### Must Have
- Energy cleanup/offload must not reduce terminal energy below `max(25_000, terminalEnergyReserve + getReservedTerminalEnergyForPendingSends(snapshot, snapshots))`.
- Existing `terminalEnergyReserve` default remains `20_000`.
- Existing `TERMINAL_TOTAL_STORAGE_CAP` remains `250_000`.
- Existing blocked incoming filter in `src/runtime/logistics/resourceTransferTasks.ts` remains untouched.
- Mineral haul priority becomes exactly `91`.

### Must NOT Have
- Do not change `RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY = 90` or `RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY = 80`.
- Do not modify carrier assignment logic in `src/roles/carrier.ts`; priority changes should be enough.
- Do not add a new config option for the 25k floor in this fix.
- Do not change hubPlanner, synthesisControl, market, spawn, visual, or main loop order.
- Do not create tiny sub-batch standard energy offload loops; preserve existing transfer-batch behavior outside overflow cap enforcement.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after on existing Jest framework.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.log`

## Execution Strategy
### Parallel Execution Waves
Wave 1: Task 1 (terminal energy floor and overflow ordering)
Wave 2: Task 2 (mineral haul priority)
Wave 3: Task 3 (carrier jitter/priority integration tests)
Wave 4: Task 4 (full verification)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1 | none | 3, 4 |
| 2 | none | 3, 4 |
| 3 | 1, 2 | 4 |
| 4 | 1, 2, 3 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 1 task → `unspecified-high`
- Wave 2 → 1 task → `quick`
- Wave 3 → 1 task → `unspecified-high`
- Wave 4 → 1 task → `unspecified-high`

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Protect terminal energy at 25k floor in all cleanup/offload paths

  **What to do**: In `src/runtime/resourceControl.ts`, introduce a small local helper such as `getProtectedTerminalEnergy(room, snapshots)` returning `Math.max(25_000, room.terminalEnergyReserve + getReservedTerminalEnergyForPendingSends(room, snapshots))`. Use it in `createEnergyTerminalTask()` where `protectedTerminalEnergy` is computed, and in the overflow offload block where `resource === RESOURCE_ENERGY` protection is computed. In the overflow block, iterate resources in deterministic order: all non-energy resources first, `RESOURCE_ENERGY` last. Keep non-energy protection as pending-send staging protection. Add/adjust tests in `src/runtime/resourceControl.test.ts`.
  **Must NOT do**: Do not change `terminalEnergyReserve` default `20_000`. Do not change `TERMINAL_TOTAL_STORAGE_CAP = 250_000`. Do not alter blocked incoming filters or hub planner behavior. Do not add new config.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Safety-sensitive terminal resource policy with boundary tests.
  - Skills: [] - Existing Jest patterns are sufficient; avoid optional skill dependency failures during execution.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [3, 4] | Blocked By: []

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:733` - `getPlannedEnergySendBatch()` sits near send-fee helper logic.
  - Pattern: `src/runtime/resourceControl.ts:810` - `getReservedTerminalEnergyForPendingSends(snapshot, snapshots)` computes pending send fee protection.
  - Pattern: `src/runtime/resourceControl.ts:827` - `createEnergyTerminalTask()` standard energy feed/offload path.
  - Pattern: `src/runtime/resourceControl.ts:898` - terminal overflow offload path.
  - Test: `src/runtime/resourceControl.test.ts:780` - `terminal overflow offload above 250k` coverage.
  - Test: `src/runtime/resourceControl.test.ts:1963` - `terminal energy jitter` coverage.
  - Test: `src/runtime/resourceControl.test.ts:2108` - `terminalEnergyReserve default 20000` coverage.

  **Acceptance Criteria**:
  - [ ] `createEnergyTerminalTask()` uses `max(25_000, terminalEnergyReserve + pending fee reserve)` as protected energy.
  - [ ] Overflow offload uses the same protected energy when `resource === RESOURCE_ENERGY`.
  - [ ] Overflow offload processes non-energy resources before energy.
  - [ ] Terminal energy exactly `25_000` creates no energy offload task.
  - [ ] Terminal energy above `25_000` is eligible only for surplus above the protection line.
  - [ ] Config override `terminalEnergyReserve: 30_000` protects 30k, not 25k.
  - [ ] Pending send fee reserve greater than 25k raises the protection line.

  **QA Scenarios**:
  ```
  Scenario: Energy threshold boundaries
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "terminal energy"`.
    Expected: Tests prove no energy cleanup at 25_000, surplus-only cleanup above 25_000, and no regression to 50k reserve.
    Evidence: .sisyphus/evidence/task-1-energy-threshold.log

  Scenario: Overflow prefers minerals before energy
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "terminal overflow offload above 250k"`.
    Expected: Mixed terminal overflow offloads non-energy before energy; energy never drops below protected line.
    Evidence: .sisyphus/evidence/task-1-overflow-order.log
  ```

  **Commit**: YES | Message: `fix(terminal): protect energy cleanup threshold` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 2. Raise mineral container haul priority above resourceControl terminal offload

  **What to do**: In `src/runtime/mineralExtraction.ts`, change `MINERAL_HAUL_PRIORITY` from `85` to `91`. Update expected priority assertions in `src/runtime/mineralExtraction.test.ts`. Update carrier fixture assertions in `src/roles/carrier.test.ts` that hardcode mineral haul priority `85`.
  **Must NOT do**: Do not change carrier task board sorting. Do not change resourceControl terminal feed/offload priority constants. Do not change synthesis or boost priorities.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Constant update plus focused test expectations.
  - Skills: [] - Simple targeted change.
  - Omitted: [`superpowers:test-driven-development`] - Existing tests can be updated directly; Task 3 adds behavioral regression.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [3, 4] | Blocked By: []

  **References**:
  - Pattern: `src/runtime/mineralExtraction.ts:12` - `MINERAL_HAUL_PRIORITY = 85`.
  - Pattern: `src/runtime/resourceControl.ts:97` - terminal_feed priority 80.
  - Pattern: `src/runtime/resourceControl.ts:98` - terminal_offload priority 90.
  - Pattern: `src/runtime/carrierTaskBoard.ts:75` - priority descending board sort.
  - Pattern: `src/roles/carrier.ts:431` - carrier assignment preserves existing task, else chooses by priority then distance.
  - Test: `src/runtime/mineralExtraction.test.ts` - expected mineral haul task priority.
  - Test: `src/roles/carrier.test.ts` - mineral haul board task fixtures.

  **Acceptance Criteria**:
  - [ ] `MINERAL_HAUL_PRIORITY` is exactly `91`.
  - [ ] `RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY` remains `90`.
  - [ ] `RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY` remains `80`.
  - [ ] Existing mineral extraction tests expect priority `91`.
  - [ ] No carrier assignment code changes are required.

  **QA Scenarios**:
  ```
  Scenario: Mineral extraction priority tests
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/mineralExtraction.test.ts`.
    Expected: Mineral haul tasks are generated with priority 91 and valid container->terminal/storage steps.
    Evidence: .sisyphus/evidence/task-2-mineral-extraction.log

  Scenario: Priority constants unchanged except mineral haul
    Tool: Grep
    Steps: Search `src/runtime/resourceControl.ts` for `RESOURCE_CONTROL_TERMINAL_(FEED|OFFLOAD)_PRIORITY` and `src/runtime/mineralExtraction.ts` for `MINERAL_HAUL_PRIORITY`.
    Expected: terminal_feed=80, terminal_offload=90, mineral_haul=91.
    Evidence: .sisyphus/evidence/task-2-priority-constants.txt
  ```

  **Commit**: YES | Message: `fix(carrier): prefer mineral containers before terminal cleanup` | Files: [`src/runtime/mineralExtraction.ts`, `src/runtime/mineralExtraction.test.ts`, `src/roles/carrier.test.ts`]

- [x] 3. Add carrier task-selection regression for terminal cleanup jitter and mineral priority

  **What to do**: Add focused tests in `src/roles/carrier.test.ts` proving that when both a `mineral_haul` task (priority 91) and resourceControl `terminal_offload` task (priority 90) are runnable, an empty carrier with no room energy demand chooses mineral_haul. Add or extend a test proving an already assigned still-runnable terminal/offload task is preserved across board refresh to avoid mid-task path flip. If existing preservation behavior is already covered, reference it and add only the missing mineral-vs-terminal case.
  **Must NOT do**: Do not modify `src/roles/carrier.ts` unless a regression test fails and shows assignment preservation is broken. Do not make mineral_haul outrank synthesis lab supply/cleanup or boost logistics.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Behavior-level regression across task board and carrier role.
  - Skills: [] - Existing carrier tests are sufficient; add regression tests before any role changes.
  - Omitted: [`librarian`] - No external library usage.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [4] | Blocked By: [1, 2]

  **References**:
  - Pattern: `src/roles/carrier.test.ts:643` - existing mineral-vs-terminal_feed selection pattern.
  - Pattern: `src/roles/carrier.test.ts:718` - terminal_offload pickup behavior.
  - Pattern: `src/roles/carrier.ts:431` - assigned task preservation and priority sorting.
  - Pattern: `src/runtime/carrierTaskBoard.ts:86` - `replaceCarrierTasksForProducerRoom()` preserves `createdAt` for same task id/producer.

  **Acceptance Criteria**:
  - [ ] Test proves mineral_haul priority 91 beats resourceControl terminal_offload priority 90.
  - [ ] Test proves terminal_offload priority 90 still beats terminal_feed priority 80 when no mineral_haul exists.
  - [ ] Test proves a still-runnable assigned task is retained rather than replaced solely due to a lower-distance task.
  - [ ] No production change in `src/roles/carrier.ts` unless required by failing test.

  **QA Scenarios**:
  ```
  Scenario: Carrier prefers mineral container over terminal cleanup
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts -t "mineral"`.
    Expected: Carrier selects mineral_haul task before resourceControl terminal_offload when both are runnable.
    Evidence: .sisyphus/evidence/task-3-carrier-mineral-priority.log

  Scenario: Assigned task stability
    Tool: Bash
    Steps: Run targeted carrier tests covering assigned board-task preservation.
    Expected: Carrier does not abandon a still-runnable assigned task just because board contents refresh.
    Evidence: .sisyphus/evidence/task-3-carrier-stability.log
  ```

  **Commit**: NO | Message: `test(carrier): cover terminal cleanup priority stability` | Files: [`src/roles/carrier.test.ts`]

- [x] 4. Full verification and scope audit

  **What to do**: Run targeted tests, full TypeScript, full Jest, and build. Verify scope is limited to `resourceControl.ts`, `resourceControl.test.ts`, `mineralExtraction.ts`, `mineralExtraction.test.ts`, and `carrier.test.ts` unless Task 3 found a role bug requiring a narrowly justified `carrier.ts` fix.
  **Must NOT do**: Do not deploy or commit from this task unless user explicitly asks during work execution. Do not alter generated `dist/` manually.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Cross-module regression verification.
  - Skills: [] - Run explicit verification commands listed below.
  - Omitted: [`frontend-ui-ux`] - No UI.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [Final Verification] | Blocked By: [1, 2, 3]

  **References**:
  - Commands from `AGENTS.md`: `npx tsc --noEmit`, `npm run test`, `npm run build`.
  - Scope guard: no changes to hubPlanner, synthesisControl, market, spawn, visual, or main loop.

  **Acceptance Criteria**:
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts src/runtime/mineralExtraction.test.ts src/roles/carrier.test.ts` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] `git diff --stat -- ':!node_modules' ':!.sisyphus'` shows only expected files.
  - [ ] Search confirms no `terminalEnergyReserve: 50_000` or `terminalEnergyReserve: 50000` exists.

  **QA Scenarios**:
  ```
  Scenario: Full automated verification
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-4-full-verification.log

  Scenario: Scope and forbidden regression audit
    Tool: Grep / Bash
    Steps: Run scope diff and grep for forbidden reserve regression and unintended module edits.
    Expected: Only expected files changed; no 50k reserve regression; no hubPlanner/synthesisControl/market/spawn/visual edits.
    Evidence: .sisyphus/evidence/task-4-scope-audit.txt
  ```

  **Commit**: NO | Message: `chore(carrier): verify terminal cleanup stability` | Files: [verification evidence only]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `fix(terminal): protect cleanup energy threshold` for `resourceControl.ts` and tests.
- Commit 2: `fix(carrier): prefer mineral containers before terminal cleanup` for mineral priority and carrier tests.
- If Task 3 requires production carrier role changes, include them in Commit 2 with the carrier regression tests.

## Success Criteria
- Terminal cleanup never drains energy to `<=25_000` and never drains below pending send fee protection.
- Terminal overflow still enforces the 250k cap but handles non-energy before energy.
- Mineral containers are cleaned before resourceControl terminal offload.
- Existing hub production fixes remain intact.

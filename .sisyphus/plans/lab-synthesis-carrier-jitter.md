# Lab Synthesis Carrier Jitter Fix

## TL;DR
> **Summary**: Fix lab synthesis carrier jitter by treating carried reagent as in-flight committed lab supply and by making reagent delivery independent of task-board survival after pickup.
> **Deliverables**:
> - TDD regression coverage for orphaned lab_supply delivery and in-flight scheduling stability
> - Carrier pending-delivery snapshot fields in assignment state
> - Synthesis lab_supply generation that accounts for in-flight reagent cargo by target lab/resource
> - Full Jest, TypeScript, build, and post-implementation review verification
> **Effort**: Short
> **Parallel**: NO - changes share carrier assignment state and regression fixtures
> **Critical Path**: Task 1 → Task 2 → Tasks 3/4 → Task 5 → Final Verification Wave

## Context
### Original Request
“现在lab合成carrier拿起资源会判定为资源不够, 放回去会认为资源足够, 从而产生抖动”

### Interview Summary
- Fix strategy selected: **计入在途资源（推荐）**.
- Test strategy selected: **TDD 回归测试（推荐）**.
- Scope is a targeted synthesis/carrier bugfix, not a general logistics redesign.

### Metis Review (gaps addressed)
- Metis identified two mandatory sub-problems: scheduler jitter and orphaned carrier delivery. The plan treats both as required.
- Metis flagged that generic carrier target delivery only handles energy; a synthesis carrier with mineral cargo and no task-board route can become permanently stuck. The plan adds a pickup-time delivery snapshot.
- Metis guardrail incorporated: in-flight cargo counts toward target lab effective supply, not source availability.

## Work Objectives
### Core Objective
Stop lab synthesis carriers from oscillating or becoming stuck when a carrier withdraws reagent before `runSynthesisControl()` refreshes the next tick’s carrier task board.

### Deliverables
- `src/runtime/creepAssignmentState.ts`: new synthesis pending-delivery snapshot fields.
- `src/roles/carrier.ts`: pickup stores snapshot; delivery uses snapshot when the task-board entry disappears.
- `src/runtime/synthesisControl.ts`: lab_supply deficit logic counts live in-flight reagent cargo for the target lab/resource.
- `src/roles/carrier.test.ts`: carrier delivery-continuity regression.
- `src/runtime/synthesisControlStateMachine.test.ts`: synthesis scheduling in-flight regression.

### Definition of Done (verifiable conditions with commands)
- `npm run test -- --runTestsByPath src/roles/carrier.test.ts src/runtime/synthesisControlStateMachine.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- Final verification agents F1-F4 approve and user gives explicit final approval.

### Must Have
- Count in-flight cargo by scanning live `Game.creeps` and `CreepAssignmentState` snapshot fields; dead creeps must not contribute.
- Count in-flight cargo toward target lab effective current amount for the matching reagent/lab.
- Preserve existing `lab_supply`, `lab_cleanup`, `lab_product_unload`, `terminal_feed`, `terminal_offload`, and generic carrier behavior except where explicitly targeted.
- Keep all verification agent-executed; no manual Screeps server inspection is required.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do **not** build a generic reservation system.
- Do **not** modify `src/runtime/energyPickupReservation.ts`.
- Do **not** redesign `src/runtime/carrierTaskBoard.ts` replacement semantics.
- Do **not** modify `src/runtime/resourceControl.ts`, terminal feed/offload logic, market behavior, or hub planning.
- Do **not** make generic carrier target delivery handle minerals; synthesis delivery must stay in synthesis-specific logic.
- Do **not** add human-observed QA requirements or require live Screeps deployment for tests.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest/ts-jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = acceptable here because this is a tightly coupled bugfix.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (`quick`) — carrier snapshot continuity foundation
Wave 2: Task 2 (`quick`) — synthesis in-flight accounting
Wave 3: Task 3 (`quick`) and Task 4 (`quick`) — integration regression and edge hardening, may run sequentially if same files conflict
Wave 4: Task 5 (`unspecified-high`) — verification and deploy-ready evidence

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 2, 3, 4 |
| 2 | 1 | 3, 4 |
| 3 | 1, 2 | 5 |
| 4 | 1, 2 | 5 |
| 5 | 1, 2, 3, 4 | Final Verification Wave |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 1 | quick |
| 3 | 2 | quick |
| 4 | 1 | unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Preserve lab_supply delivery route after task-board refresh

  **What to do**:
  1. In `src/roles/carrier.test.ts`, add a RED regression near the existing lab_supply tests (`src/roles/carrier.test.ts:1806-1873`). Scenario: carrier accepts a `lab_supply` withdraw, `replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [])` clears the board before target phase, and `carrierRole().target(creep)` still transfers the same reagent to the original lab.
  2. Extend `CreepAssignmentState` in `src/runtime/creepAssignmentState.ts:5-18` with exactly these optional fields:
     - `synthesisCarrierPendingFromId?: string`
     - `synthesisCarrierPendingToId?: string`
     - `synthesisCarrierPendingResource?: ResourceConstant`
  3. In `src/roles/carrier.ts:490-493`, after a successful `withdraw` intent, set the three snapshot fields from `assignment.step` in the same block that sets `synthesisCarrierPendingPickupTick` and `synthesisCarrierPendingStepId`.
  4. In `src/roles/carrier.ts:356-362`, clear the snapshot fields inside `clearSynthesisCarrierTaskPlan()`.
  5. In `src/roles/carrier.ts:579-612`, update pending-step delivery so it first tries the assigned task step, then falls back to `synthesisCarrierPendingToId` + `synthesisCarrierPendingResource` when the assigned board task or step is missing. If the target exists and the creep carries that resource, transfer to the target. If out of range, move to it. If transfer succeeds and store is empty, clear the plan.
  6. Keep the existing terminal_offload special case (`src/roles/carrier.ts:615-660`) unchanged.

  **Must NOT do**:
  - Do not change `src/runtime/carrierTaskBoard.ts` replacement semantics.
  - Do not route mineral cargo through generic carrier target delivery.
  - Do not clear pending snapshot fields before a successful delivery or unrecoverable invalid target/resource state.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: small, localized carrier state/test change.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`, `playwright`] - No UI/browser work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3, 4] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.test.ts:1806-1873` - existing lab_supply pickup/delivery mock style.
  - Pattern: `src/roles/carrier.ts:464-498` - pickup records accepted withdraw intent.
  - Pattern: `src/roles/carrier.ts:567-613` - pending delivery path that currently fails when `assigned` is null.
  - API/Type: `src/runtime/creepAssignmentState.ts:5-18` - assignment-state field naming convention.
  - API/Type: `src/runtime/carrierTaskBoard.ts:86-130` - board replacement can delete producer tasks when drafts are empty.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runTestsByPath src/roles/carrier.test.ts -t "lab_supply"` passes after the RED test is made GREEN.
  - [ ] New test fails before implementation and passes after implementation.
  - [ ] `npx tsc --noEmit` reports no new type errors for `CreepAssignmentState` fields.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Orphaned lab_supply carrier still delivers reagent
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/roles/carrier.test.ts -t "cleared lab_supply"
    Expected: Test passes; creep.transfer is called with the original lab and reagent after the synthesisControl task board is cleared.
    Evidence: .sisyphus/evidence/task-1-orphaned-lab-supply.txt

  Scenario: Existing terminal_offload regression remains stable
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/roles/carrier.test.ts -t "terminal_offload"
    Expected: Existing terminal_offload tests pass; no terminal offload behavior changed.
    Evidence: .sisyphus/evidence/task-1-terminal-offload-regression.txt
  ```

  **Commit**: YES | Message: `fix(carrier): preserve synthesis delivery snapshots` | Files: [`src/runtime/creepAssignmentState.ts`, `src/roles/carrier.ts`, `src/roles/carrier.test.ts`]

- [x] 2. Count in-flight reagent cargo in synthesis lab_supply generation

  **What to do**:
  1. In `src/runtime/synthesisControlStateMachine.test.ts`, add a RED test near loading/lab_supply coverage. Use the existing `createStore`, `createLab`, `createSynthesisRoom`, `setConfig`, and `setRoomStage` helpers (`src/runtime/synthesisControlStateMachine.test.ts:15-187`).
  2. Test setup must create a live carrier in `Game.creeps` with `store.getUsedCapacity(RESOURCE_OXYGEN) === 500` and assignment state fields from Task 1 pointing to the oxygen reagent lab. The source store should have zero oxygen after pickup. Run `runSynthesisControl()` and assert the oxygen lab_supply step is not regenerated as missing demand; only genuinely missing reagents may remain in the task board.
  3. In `src/runtime/synthesisControl.ts`, import `getCreepAssignmentState` from `@/runtime/creepAssignmentState`.
  4. Add a private helper near `roomTransferableAmount()` (`src/runtime/synthesisControl.ts:384-393`) named `countInFlightSynthesisCargo(labId: string, resource: ResourceConstant): number`.
  5. Helper rules:
     - Iterate `Object.values(Game.creeps)` only; dead creeps automatically do not count.
     - Read each creep’s `getCreepAssignmentState(creep.name)`.
     - Count only if `synthesisCarrierPendingToId === labId` and `synthesisCarrierPendingResource === resource`.
     - Add `creep.store.getUsedCapacity(resource)` if > 0.
     - Do not require `synthesisCarrierTaskId`; task-board deletion must not stop in-flight accounting.
  6. In `generateSupplyTask()` (`src/runtime/synthesisControl.ts:894-961`), compute `inFlightAmount` per reagent lab and use `effectiveCurrentAmount = currentAmount + inFlightAmount` for:
     - deficit calculation (`desiredLabAmount - effectiveCurrentAmount`),
     - partial top-up gate (`effectiveCurrentAmount > 0`),
     - amount partial top-up gate.
  7. Keep source availability live: `available = source.store.getUsedCapacity(reagent)` must remain based only on storage/terminal stores. Do not add in-flight cargo to source availability.

  **Must NOT do**:
  - Do not count cargo from missing/dead creeps.
  - Do not count cargo by resource alone; it must match both target lab ID and resource.
  - Do not change `roomResourceAmount()` target-product semantics.
  - Do not alter `resolveSupplySourceStructure()` source selection.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized scheduler helper plus one regression test.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser/manual UI verification.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [3, 4] | Blocked By: [1]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/synthesisControl.ts:362-393` - resource amount helper placement and style.
  - Pattern: `src/runtime/synthesisControl.ts:894-961` - lab_supply deficit and step generation logic to modify.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts:15-187` - mutable room/lab/store helpers.
  - API/Type: `src/runtime/creepAssignmentState.ts:47-49` - getter for per-creep assignment state.
  - Guardrail: `src/runtime/synthesisControl.ts:926-932` - source availability remains live and must not include in-flight cargo.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runTestsByPath src/runtime/synthesisControlStateMachine.test.ts -t "in-flight"` passes.
  - [ ] New in-flight test fails before implementation and passes after implementation.
  - [ ] The resulting lab_supply task does not include a duplicate step for a reagent already carried to that same lab.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: In-flight oxygen suppresses duplicate oxygen supply demand
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/runtime/synthesisControlStateMachine.test.ts -t "in-flight"
    Expected: Test passes; board tasks exclude the already in-flight oxygen-to-lab step while still allowing any truly missing hydrogen step.
    Evidence: .sisyphus/evidence/task-2-in-flight-scheduling.txt

  Scenario: Source stores remain authoritative for new withdrawals
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/runtime/synthesisControlStateMachine.test.ts -t "in-flight"
    Expected: Test assertion confirms no step is generated from a depleted source merely because cargo is in flight.
    Evidence: .sisyphus/evidence/task-2-source-authority.txt
  ```

  **Commit**: YES | Message: `fix(synthesis): count in-flight lab supply cargo` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 3. Add full multi-tick jitter regression across synthesisControl and carrier role

  **What to do**:
  1. Add one integration-style Jest regression in `src/roles/carrier.test.ts` after the existing lab_supply tests (`src/roles/carrier.test.ts:1806-1939`).
  2. Import `runSynthesisControl` from `@/runtime/synthesisControl` into `src/roles/carrier.test.ts` for this test only.
  3. Test sequence must be exactly:
     - Set synthesis config for a room producing OH with oxygen/hydrogen reagent labs.
     - Tick N: run `runSynthesisControl()` to create lab_supply tasks.
     - Same tick: run `carrierRole().source?.(creep)`; the mock withdraw mutates carrier store and source store to simulate accepted reagent pickup.
     - Tick N+1: run `runSynthesisControl()` before delivery; assert the board does not create duplicate demand for the reagent in the carrier.
     - Same tick: run `carrierRole().target(creep)`; assert transfer to the intended reagent lab.
     - Tick N+2: run `runSynthesisControl()` after lab store mutation; assert room state is stable (`loading` only if the other reagent is missing, otherwise `synthesizing`).
  4. If helper duplication becomes excessive, keep test-local factories in `carrier.test.ts`; do not move shared mock factories in this task.

  **Must NOT do**:
  - Do not require a real Screeps server or `npm run push` for this regression.
  - Do not loosen assertions to only “does not throw”; assert board state and transfer target/resource.
  - Do not rewrite existing mock helper architecture.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: regression-focused integration coverage using existing test harness.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`, `frontend-ui-ux`] - No UI/browser work.

  **Parallelization**: Can Parallel: MAYBE | Wave 3 | Blocks: [5] | Blocked By: [1, 2]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.test.ts:1806-1939` - lab_supply carrier mocks.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts:201-239` - multi-tick synthesis lifecycle style.
  - Runtime order: `src/main.ts` per project knowledge - synthesisControl runs before carrier work; test must preserve this order.
  - API/Type: `src/runtime/carrierTaskBoard.ts:58-83` - use `getCarrierTasksByRoom` or `listCarrierTasksByRoom` to inspect board state.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runTestsByPath src/roles/carrier.test.ts -t "synthesisControl.*carrier"` passes.
  - [ ] Test fails if Task 1 delivery snapshot fallback is removed.
  - [ ] Test fails if Task 2 in-flight accounting is removed.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Real tick order does not orphan or duplicate lab_supply cargo
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/roles/carrier.test.ts -t "synthesisControl.*carrier"
    Expected: Test passes; tick N+1 board refresh does not duplicate carried reagent, and carrier target transfers to the intended lab.
    Evidence: .sisyphus/evidence/task-3-multitick-jitter.txt

  Scenario: Full carrier test suite remains green
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/roles/carrier.test.ts
    Expected: All carrier role tests pass.
    Evidence: .sisyphus/evidence/task-3-carrier-suite.txt
  ```

  **Commit**: YES | Message: `test(carrier): cover synthesis jitter tick order` | Files: [`src/roles/carrier.test.ts`]

- [x] 4. Harden in-flight accounting edge cases

  **What to do**:
  1. In `src/runtime/synthesisControlStateMachine.test.ts`, add edge-case coverage for dead-creep exclusion and partial top-up interaction.
  2. Dead-creep test: create assignment state for a creep name not present in `Game.creeps`, configure an empty lab and depleted source, run `runSynthesisControl()`, and assert missing cargo is not counted as in-flight.
  3. Partial top-up test: configure a reagent lab with effective supply split between physical lab amount and in-flight cargo such that remaining deficit is below `LAB_REACTION_AMOUNT`; assert the existing partial top-up rules still generate a small step only when effective current amount is positive and source has enough live resource.
  4. If Task 2 helper fails either case, adjust only `countInFlightSynthesisCargo()` and `generateSupplyTask()` effective-current usage. Do not expand scope to reservations.

  **Must NOT do**:
  - Do not count `runtimeGlobal.__creepAssignmentState` entries directly; only live `Game.creeps` may contribute.
  - Do not weaken `LAB_REACTION_AMOUNT` gates globally.
  - Do not alter product-unload or cleanup task generation.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: two edge tests and small helper corrections if needed.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser/manual UI verification.

  **Parallelization**: Can Parallel: MAYBE | Wave 3 | Blocks: [5] | Blocked By: [1, 2]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/synthesisControl.ts:917-936` - current and amount partial top-up gates.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts:15-187` - mutable stores and runtime state helpers.
  - API/Type: `src/runtime/creepAssignmentState.ts:36-49` - assignment creation/getter behavior.
  - Guardrail: `src/runtime/carrierTaskBoard.ts:99-103` - zero/negative amount steps are filtered and must not be relied on.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runTestsByPath src/runtime/synthesisControlStateMachine.test.ts -t "dead creep|partial top-up"` passes.
  - [ ] Dead creep with stale assignment state contributes 0 in-flight cargo.
  - [ ] Partial top-up behavior remains bounded and does not generate duplicate full-size steps.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Dead carrier cargo is not counted
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/runtime/synthesisControlStateMachine.test.ts -t "dead creep"
    Expected: Test passes; stale assignment state without a live Game.creeps entry does not suppress lab_supply demand.
    Evidence: .sisyphus/evidence/task-4-dead-creep.txt

  Scenario: In-flight cargo respects partial top-up thresholds
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/runtime/synthesisControlStateMachine.test.ts -t "partial top-up"
    Expected: Test passes; partial remaining deficit is handled only under the existing partial top-up conditions using effective current amount.
    Evidence: .sisyphus/evidence/task-4-partial-top-up.txt
  ```

  **Commit**: YES | Message: `test(synthesis): harden in-flight cargo edge cases` | Files: [`src/runtime/synthesisControlStateMachine.test.ts`, `src/runtime/synthesisControl.ts`]

- [x] 5. Run complete verification and prepare deployment evidence

  **What to do**:
  1. Run targeted tests for changed suites.
  2. Run full Jest suite.
  3. Run TypeScript no-emit check.
  4. Run production build.
  5. Save command outputs or concise pass/fail summaries under `.sisyphus/evidence/`.
  6. Do not deploy in this task; deployment remains after final verification wave and explicit user approval per project workflow.

  **Must NOT do**:
  - Do not run `npm run push` before final verification wave approval and explicit user approval.
  - Do not skip failing tests or use `--runInBand`/`--silent` to hide failures unless required for diagnosis and recorded.
  - Do not claim success without command output evidence.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: full verification, evidence capture, and regression triage if commands fail.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser/UI workflow.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [Final Verification Wave] | Blocked By: [3, 4]

  **References** (executor has NO interview context - be exhaustive):
  - Command reference: `AGENTS.md` project commands: `npm run build`, `npx tsc --noEmit`, `npm run test`, `npm run push`.
  - Workflow rule: deployment uses `npm run push` only after verification and final approval.
  - Evidence path convention: `.sisyphus/evidence/task-5-*.txt`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runTestsByPath src/roles/carrier.test.ts src/runtime/synthesisControlStateMachine.test.ts` passes.
  - [ ] `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run build` passes.
  - [ ] Evidence files exist for each command under `.sisyphus/evidence/`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Changed-suite verification
    Tool: Bash
    Steps: npm run test -- --runTestsByPath src/roles/carrier.test.ts src/runtime/synthesisControlStateMachine.test.ts
    Expected: Command exits 0 and includes both changed suites.
    Evidence: .sisyphus/evidence/task-5-changed-suites.txt

  Scenario: Full project verification
    Tool: Bash
    Steps: npm run test && npx tsc --noEmit && npm run build
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-5-full-verification.txt
  ```

  **Commit**: NO | Message: `N/A` | Files: [`.sisyphus/evidence/task-5-*.txt`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit after each implementation task that changes source/test files.
- Task 1 commit: `fix(carrier): preserve synthesis delivery snapshots`
- Task 2 commit: `fix(synthesis): count in-flight lab supply cargo`
- Task 3 commit: `test(carrier): cover synthesis jitter tick order`
- Task 4 commit: `test(synthesis): harden in-flight cargo edge cases`
- If hooks or review require small follow-ups, keep commits semantic and scoped; do not squash unless explicitly requested.

## Success Criteria
- Carrier with reagent cargo and a cleared synthesis task-board entry still delivers to the original lab using the pickup snapshot.
- `generateSupplyTask()` does not recreate duplicate/oscillating supply demand for reagent already carried toward the target lab.
- Dead creeps are not counted as in-flight cargo.
- Existing terminal, resourceControl, and generic carrier behavior remain unchanged by tests and code review.
- After final user approval, deployment path remains `npm run push` per project workflow.

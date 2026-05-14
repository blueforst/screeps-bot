# E4N58 Carrier Phase Jitter Fix

## TL;DR
> **Summary**: Fix carrier terminal/storage jitter caused by carrier phase decisions assuming `withdraw(OK)` and `transfer(OK)` immediately mutate `creep.store`, which is false in live Screeps intent timing.
> **Deliverables**:
> - Pending synthesis carrier intent state in assignment state
> - Carrier pickup/delivery logic that switches on accepted intents, not same-tick store mutation
> - Regression tests for `(17,15)` ↔ `(16,14)` style source/target oscillation
> **Effort**: Short
> **Parallel**: NO — state contract must be added before behavior change tests go green
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Final Verification

## Context
### Original Request
- User: “抖动问题并没有解决”.
- User clarified room: `E4N58`.
- User clarified: “不是交接的问题”.
- User observed visible jitter often between `(17,15)` and `(16,14)`.

### Interview Summary
- `(17,15)` is adjacent to both terminal `(17,14)` and storage `(18,15)`.
- `(16,14)` is adjacent to terminal but range 2 from storage.
- Therefore the visible movement is consistent with alternating terminal-side source intent and storage-side delivery intent.

### Live Snapshot Summary
- E4N58 is on `shard1`; hub room: `Memory.cfg.hub.hubRoomName = "E4N58"`.
- Post-refill snapshot: spawn full, all 40 extensions full, links empty.
- Carrier remained in hub area; terminal/storage transfer was happening: terminal X/U decreased and storage X increased.
- Samples showed inconsistent phase/cargo state:
  - carrier carried `X`/`U` while `Memory.creeps[name].working=false`
  - carrier was empty while `working=true`
- This rules out energy-demand hijack as the primary post-refill cause.

### Metis Review (gaps addressed)
- Root cause is accepted-intent timing: live Screeps resolves `withdraw`/`transfer` store mutations after the tick, while tests often mutate stores immediately.
- Keep fix in `src/roles/carrier.ts` and `src/runtime/creepAssignmentState.ts` only.
- Do not change `src/mount/mountCreep.ts`; its immediate re-entry contract applies to all roles.
- Do not change `resourceControl`, pathing, or spawn/extension refill priorities.
- Use minimal pending-intent fields rather than a new class or broad logistics refactor.

## Work Objectives
### Core Objective
Stop carrier phase/cargo mismatches that make E4N58 carrier alternate terminal-side and storage-side movement after accepted terminal/storage logistics intents.

### Deliverables
- Add pending synthesis carrier intent fields to assignment state.
- Record accepted pickup intent when `withdraw(OK)` is returned.
- Make synthesis pickup return `picked: true` on `withdraw(OK)` even if `creep.store` is still empty that tick.
- Make delivery honor a pending committed pickup step during same-tick mount re-entry and next tick.
- Record accepted delivery intent on `transfer(OK)` and clear task/pending state only after store emptiness is confirmed on the following source tick.
- Tests that reproduce live-intent timing without relying on immediate store mutation.

### Definition of Done
- `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` passes.
- `npm run test` passes.
- `npx tsc --noEmit` exits 0.
- New tests fail before implementation and pass after implementation.
- No files outside `src/roles/carrier.ts`, `src/roles/carrier.test.ts`, and `src/runtime/creepAssignmentState.ts` are modified, except `.sisyphus/evidence/*`.

### Must Have
- Accepted `withdraw(OK)` for a synthesis carrier task must switch carrier toward target/delivery phase without waiting for same-tick store mutation.
- Same-tick target re-entry after pickup intent must not clear the task or select a new source target when store is still empty.
- Accepted `transfer(OK)` must not assume store is empty in the same tick.
- Empty-store confirmation on next source phase must clear pending delivery state and the completed synthesis task.
- Existing normal spawn/extension refill remains unchanged when no synthesis task intent is pending.

### Must NOT Have
- No `mountCreep.ts` changes.
- No pathing changes.
- No `resourceControl.ts` changes.
- No broad suppression of spawn/extension refill.
- No new analytics/logging.
- No new state class or large refactor.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest in `src/roles/carrier.test.ts`.
- QA policy: Every task includes command-based verification and scenario tracing.
- Evidence: `.sisyphus/evidence/e4n58-carrier-phase-jitter-task-{N}.txt`.

## Execution Strategy
### Parallel Execution Waves
Wave 1: Task 1 tests only.
Wave 2: Task 2 state fields and cleanup helper updates.
Wave 3: Task 3 pickup/delivery behavior.
Wave 4: Task 4 full verification and evidence.
Final Wave: F1-F4 in parallel.

### Dependency Matrix
- Task 1 blocks Task 2 and Task 3.
- Task 2 blocks Task 3.
- Task 3 blocks Task 4.
- Task 4 blocks final verification.

### Agent Dispatch Summary
- Wave 1: 1 task, category `quick`.
- Wave 2: 1 task, category `quick`.
- Wave 3: 1 task, category `deep`.
- Wave 4: 1 task, category `quick`.

## TODOs

- [x] 1. Add live-intent carrier jitter regressions

  **What to do**: Add failing tests to `src/roles/carrier.test.ts` that model live Screeps intent timing: `withdraw(OK)` and `transfer(OK)` do not immediately mutate `creep.store`. Tests must cover a carrier assigned to a synthesis/terminal logistics task near terminal/storage, including the `(17,15)`/`(16,14)` geometry.
  **Must NOT do**: Do not change implementation files in this task.

  **Recommended Agent Profile**:
  - Category: `quick` - focused Jest additions in one file.
  - Skills: [] - no external skills needed.
  - Omitted: `playwright` - no browser/UI.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: Task 2, Task 3 | Blocked By: none

  **References**:
  - Pattern: `src/roles/carrier.test.ts` existing `terminal_offload` tests added near the prior jitter fix.
  - Runtime: `src/mount/mountCreep.ts:82-103` - phase switch and same-tick re-entry behavior.
  - Bug path: `src/roles/carrier.ts:460-490` - pickup uses store after `withdraw(OK)`.
  - Bug path: `src/roles/carrier.ts:559-628` - delivery uses store after `transfer(OK)`.

  **Acceptance Criteria**:
  - [ ] Add a test where `withdraw(OK)` leaves store empty in the same tick, but carrier still records/switches as picked; this must fail before Task 3.
  - [ ] Add a test where same-tick target re-entry with pending pickup moves/plans toward the committed `toId` storage, not back toward terminal/source; this must fail before Task 3.
  - [ ] Add a test where `transfer(OK)` leaves store populated in the same tick and task is not cleared until the next empty-store tick.
  - [ ] Command evidence: `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand --testNamePattern="pending synthesis intent|phase jitter"` captured to `.sisyphus/evidence/e4n58-carrier-phase-jitter-task-1-red.txt`.

  **QA Scenarios**:
  ```
  Scenario: Pickup intent accepted while store remains empty
    Tool: Bash
    Steps: Run targeted Jest test with live-intent store mock.
    Expected: Before implementation, assertion shows source did not correctly switch/record pending pickup.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-1-red.txt

  Scenario: Transfer OK does not clear same tick
    Tool: Bash
    Steps: Run targeted Jest test where transfer returns OK but store still contains U/X.
    Expected: Before implementation, task clearing/phase behavior mismatches live intent semantics.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-1-red.txt
  ```

  **Commit**: NO | Message: n/a | Files: `src/roles/carrier.test.ts`

- [x] 2. Add pending synthesis intent assignment state

  **What to do**: Update `src/runtime/creepAssignmentState.ts` with exactly these optional fields: `synthesisCarrierPendingPickupTick?: number`, `synthesisCarrierPendingStepId?: string`, `synthesisCarrierPendingDeliveryTick?: number`. Update `clearSynthesisCarrierTaskPlan()` in `src/roles/carrier.ts` so clearing the synthesis task also deletes these three fields.
  **Must NOT do**: Do not store full step contracts (`resource`, `fromId`, `toId`) in assignment state; resolve from task + step id.

  **Recommended Agent Profile**:
  - Category: `quick` - small type/state change.
  - Skills: [] - no external skills needed.
  - Omitted: `refactor` - no broad refactor.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: Task 3 | Blocked By: Task 1

  **References**:
  - State type: `src/runtime/creepAssignmentState.ts:5-15`.
  - Clear helper: `src/roles/carrier.ts:356-358`.
  - Existing access pattern: `ensureCreepAssignmentState(creep.name)` in `src/roles/carrier.ts`.

  **Acceptance Criteria**:
  - [x] TypeScript recognizes three new optional fields.
  - [x] `clearSynthesisCarrierTaskPlan()` deletes `synthesisCarrierTaskId` and all three pending fields.
  - [x] No other state fields are renamed or removed.
  - [x] `npx tsc --noEmit` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Pending fields typecheck
    Tool: Bash
    Steps: Run npx tsc --noEmit.
    Expected: Exit 0.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-2-tsc.txt

  Scenario: Clear helper removes pending state
    Tool: Bash
    Steps: Run targeted carrier Jest tests touching clearSynthesisCarrierTaskPlan indirectly.
    Expected: Pending fields are absent after task clear.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-2-jest.txt
  ```

  **Commit**: NO | Message: n/a | Files: `src/runtime/creepAssignmentState.ts`, `src/roles/carrier.ts`

- [x] 3. Fix synthesis pickup/delivery phase logic for accepted intents

  **What to do**: Update `src/roles/carrier.ts` synthesis carrier paths only.
  1. In `pickupSynthesisCarrierResource()`, when `withdraw()` returns `OK`, set `synthesisCarrierPendingPickupTick = Game.time`, set `synthesisCarrierPendingStepId = assignment.step.id`, keep `synthesisCarrierTaskId`, and return `{ picked: true, outOfRange: false }` without checking `creep.store`.
  2. At the start of `deliverSynthesisCarrierResource()`, if `synthesisCarrierPendingPickupTick >= Game.time - 1` and `synthesisCarrierPendingStepId` exists, resolve the assigned task and step by id. If the `toId` target exists, use it as the delivery target even if current store is empty due to same-tick pickup intent timing.
  3. For pending pickup delivery target handling: if `transfer()` returns `ERR_NOT_IN_RANGE` or `ERR_NOT_ENOUGH_RESOURCES`, call `moveToTarget(creep, target)` and return `true` so the creep remains in target phase and does not choose terminal/source movement. If `transfer()` returns `OK`, clear pickup pending fields, set `synthesisCarrierPendingDeliveryTick = Game.time`, and return `true`.
  4. In normal delivery `transfer(OK)` paths, set `synthesisCarrierPendingDeliveryTick = Game.time` and do not clear the task based on same-tick store contents.
  5. At the top of `source()`, if `synthesisCarrierPendingDeliveryTick === Game.time - 1` and `creep.store.getUsedCapacity() === 0`, call `clearSynthesisCarrierTaskPlan(creep)`, clear post-transfer plan, and continue source normally without forcing a target switch.

  **Must NOT do**: Do not edit `src/mount/mountCreep.ts`, `src/runtime/resourceControl.ts`, `src/roles/energyTargets.ts`, or movement/pathing files. Do not alter generic spawn/extension refill when no synthesis pending state exists.

  **Recommended Agent Profile**:
  - Category: `deep` - behavior-dense state machine change.
  - Skills: [] - no external skills needed.
  - Omitted: `playwright` - no UI.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Task 4 | Blocked By: Task 2

  **References**:
  - Pickup function: `src/roles/carrier.ts:460-490`.
  - Delivery function: `src/roles/carrier.ts:559-628`.
  - Source phase: `src/roles/carrier.ts:630-704`.
  - Target phase: `src/roles/carrier.ts:705-807`.
  - Mount re-entry: `src/mount/mountCreep.ts:93-103`.

  **Acceptance Criteria**:
  - [x] New Task 1 tests pass.
  - [x] Existing previous `terminal_offload` guard tests still pass.
  - [x] Carrier carrying U/X after accepted pickup cannot remain in source phase long enough to move from `(17,15)` back toward terminal-side `(16,14)` when committed target is storage.
  - [x] Empty carrier after accepted delivery does not remain in target phase and repeatedly clear/reselect movement.
  - [x] Generic spawn/extension refill tests remain unchanged and pass.

  **QA Scenarios**:
  ```
  Scenario: E4N58 geometry pending pickup
    Tool: Bash
    Steps: Run Jest test with terminal at (17,14), storage at (18,15), creep at (17,15), withdraw OK but store empty.
    Expected: Role records pending pickup, switches target, and target re-entry moves/plans toward storage, not terminal.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-3-pickup.txt

  Scenario: Transfer intent clears on next empty tick
    Tool: Bash
    Steps: Run Jest test with transfer OK and store not mutated until next simulated tick.
    Expected: Task remains pending same tick; next source tick with empty store clears pending fields and proceeds normally.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-3-delivery.txt
  ```

  **Commit**: NO | Message: n/a | Files: `src/roles/carrier.ts`, `src/roles/carrier.test.ts`

- [x] 4. Run full verification and prepare deploy evidence

  **What to do**: Run targeted tests, full Jest, TypeScript, and build. Save outputs to `.sisyphus/evidence/`.
  **Must NOT do**: Do not deploy in this task; deployment happens only after final wave approval.

  **Recommended Agent Profile**:
  - Category: `quick` - verification commands and evidence collection.
  - Skills: [] - no external skills needed.
  - Omitted: `git-master` - commit/deploy handled by orchestrator after approval.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: Final Verification | Blocked By: Task 3

  **References**:
  - Commands: `npm run test`, `npx tsc --noEmit`, `npm run build`.
  - Workflow memory: deployment uses `npm run push` only after verification approval.

  **Acceptance Criteria**:
  - [x] `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` exits 0.
  - [x] `npm run test` exits 0.
  - [x] `npx tsc --noEmit` exits 0.
  - [x] `npm run build` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Full automated regression
    Tool: Bash
    Steps: Run targeted carrier Jest, full Jest, tsc, and build.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-4-verification.txt

  Scenario: Scope check
    Tool: Bash
    Steps: Run git diff --stat excluding .sisyphus.
    Expected: Only carrier.ts, carrier.test.ts, creepAssignmentState.ts changed.
    Evidence: .sisyphus/evidence/e4n58-carrier-phase-jitter-task-4-scope.txt
  ```

  **Commit**: YES | Message: `fix(carrier): stabilize synthesis intent phase switching` | Files: `src/roles/carrier.ts`, `src/roles/carrier.test.ts`, `src/runtime/creepAssignmentState.ts`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- One atomic commit after Task 4 and final approval: `fix(carrier): stabilize synthesis intent phase switching`.
- Commit only source/test files; `.sisyphus/evidence` stays as work evidence unless user requests commit.

## Success Criteria
- E4N58 carrier no longer has a tested path where accepted terminal/storage pickup leaves it source-side with cargo.
- E4N58 carrier no longer has a tested path where accepted terminal/storage transfer leaves it target-side empty and reselecting movement.
- Existing terminal_offload fallthrough fix remains intact.
- Spawn/extension refill remains legitimate when no synthesis pending state exists.
- After final approval, run `npm run push` to deploy to Screeps.

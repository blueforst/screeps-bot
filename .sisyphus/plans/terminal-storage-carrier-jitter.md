# Terminal Storage Carrier Jitter

## TL;DR
> **Summary**: Fix carrier terminal_offload behavior so a carrier that withdraws from terminal remains bound to the task storage destination and never falls through to unrelated generic energy delivery targets while carrying task cargo. Same-tick movement toward storage remains allowed.
> **Deliverables**:
> - TDD regressions in `src/roles/carrier.test.ts`
> - Targeted carrier delivery guard in `src/roles/carrier.ts`
> - TypeScript/Jest verification and final agent QA
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3 → Final Verification

## Context
### Original Request
- User reported: carrier still jitters during terminal→storage resource transfer, possibly because terminal energy refill or preselected targets influence behavior.
- User corrected symptom: after withdrawing resource/energy from terminal, movement toward storage in the same tick is acceptable; the bug is movement toward a **non-storage** target.
- User selected TDD Jest strategy.
- Wrong target is unknown; plan covers both generic energy-target fallback and stale/preselected movement risks.

### Interview Summary
- Do not suppress same-tick movement itself.
- Do not change global `mountCreep()` source→target immediate re-entry.
- For terminal_offload, task cargo must remain bound to the carrier task step `toId` storage until delivered, blocked by full storage, or the storage target is invalid.

### Metis Review (gaps addressed)
- Metis identified the likely fallthrough path: if `deliverSynthesisCarrierResource()` cannot select the assigned delivery step, `carrierRole.target()` proceeds to generic `getEnergyStoreTarget()`, which prioritizes spawn/extension/tower/lab before storage.
- Guardrail incorporated: distinguish “terminal_offload task still assigned but temporarily blocked” from “task legitimately cleared/no longer valid.”
- Adjustment from Metis recommendation: do **not** use `carrierStorageOnlyMode` as the primary fix because its fallback can target terminal when storage has no free capacity; instead, keep terminal_offload cargo bound directly to the task `toId` storage and block generic fallback.

## Work Objectives
### Core Objective
Ensure carriers carrying cargo from a `terminal_offload` task never move toward non-storage generic energy targets before completing or safely blocking on the task storage destination.

### Deliverables
- Regression tests proving terminal_offload cargo uses storage target even when generic energy targets exist.
- Regression tests proving full-storage/blocked terminal_offload does not fall through to `getEnergyStoreTarget()`.
- Minimal carrier role change in `src/roles/carrier.ts`.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/roles/carrier.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- Final review wave F1-F4 approves and user explicitly approves verification results.

### Must Have
- Preserve same-tick terminal_offload movement toward storage.
- Preserve legitimate generic energy delivery when a carrier has energy but no active synthesis carrier task.
- Preserve existing terminal_feed/lab/mineral task behavior unless directly covered by tests.
- Keep assignment stickiness via `synthesisCarrierTaskId`.

### Must NOT Have
- No changes to `src/mount/mountCreep.ts` immediate source→target re-entry.
- No changes to `src/runtime/resourceControl.ts` feed/offload thresholds for this bug.
- No global disabling of post-withdraw movement.
- No fallback that sends terminal_offload cargo back to terminal because storage is full.
- No human-only acceptance criteria.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest (`src/roles/carrier.test.ts`) plus full Jest and TypeScript verification.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (TDD characterization)
Wave 2: Task 2 (targeted implementation)
Wave 3: Task 3 (verification and deploy readiness)
Final Wave: F1-F4 review agents in parallel

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Add carrier terminal_offload target-binding regressions | None | 2 |
| 2. Implement terminal_offload task-bound delivery guard | 1 | 3 |
| 3. Run focused/full verification and prepare deployment evidence | 2 | F1-F4 |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Tasks | Categories |
|---|---:|---|
| 1 | 1 | quick |
| 2 | 1 | quick |
| 3 | 1 | quick |
| Final | 4 | oracle, unspecified-high, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add terminal_offload target-binding regressions

  **What to do**: Add failing Jest tests in `src/roles/carrier.test.ts` near the existing terminal_offload stability tests around lines 1397-1464. Use existing mocks at lines 6-20, `createCreep()` at lines 71-91, `createRoom()` at lines 94-119, and task board helpers from `src/runtime/carrierTaskBoard.ts:86-134`. Tests must model a carrier carrying cargo for an assigned `terminal_offload` task and prove it does not choose generic energy targets.

  Required test cases:
  1. **Storage reachable path preserved**: active `terminal_offload` task from terminal to storage, creep carries `RESOURCE_ENERGY`, storage has free capacity, `creep.transfer(storage, RESOURCE_ENERGY)` returns `ERR_NOT_IN_RANGE`; `carrierRole().target(creep)` must call `moveToTarget(creep, storage)` and must not call `getEnergyStoreTarget()` after mock reset.
  2. **Storage full blocks generic fallback**: active `terminal_offload` task from terminal to storage, creep carries `RESOURCE_ENERGY`, storage reports `getFreeCapacity(RESOURCE_ENERGY) === 0`, a fake spawn/extension/tower is available from mocked `getEnergyStoreTarget()`; `carrierRole().target(creep)` must not call `getEnergyStoreTarget()` and must not call `moveToTarget()` with the fake non-storage target.
  3. **Legitimate generic fallback preserved**: no `synthesisCarrierTaskId`, creep carries energy, mocked `getEnergyStoreTarget()` returns a spawn; `carrierRole().target(creep)` must call `getEnergyStoreTarget()` and may call `moveToTarget()` toward the spawn when transfer is out of range.
  4. **Non-energy terminal_offload does not divert**: active `terminal_offload` for a non-energy resource, storage unavailable/full, generic energy target exists; `carrierRole().target(creep)` must not move toward the generic energy target.

  Implementation details for tests:
  - For target-only tests, set `ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "terminal-offload-task"` and publish matching task with `replaceCarrierTasksForProducerRoom()`.
  - Override `creep.store.getUsedCapacity` per test so `undefined` returns total carried amount and `RESOURCE_ENERGY` or the mineral returns the carried amount.
  - Reset `getEnergyStoreTarget.mockClear()` immediately before `carrierRole().target(creep)` when source-phase setup would otherwise call it.
  - Use `moveToTarget.mock.calls` to assert no call has second argument equal to the fake non-storage target.

  **Must NOT do**: Do not edit implementation in this task. Do not add brittle assertions on exact call counts from setup phases. Do not require mounted `.work()` tests unless direct `target()` tests cannot reproduce the bug.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused Jest regression additions in one existing test file.
  - Skills: [] - no special skill needed.
  - Omitted: [`playwright`] - not a UI/browser task.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.test.ts:1-20` - existing module mocks for `getEnergyStoreTarget` and `moveToTarget`.
  - Pattern: `src/roles/carrier.test.ts:71-119` - `createCreep()` and `createRoom()` helper style.
  - Pattern: `src/roles/carrier.test.ts:1397-1464` - terminal_offload assignment stability tests.
  - API/Type: `src/runtime/carrierTaskBoard.ts:1-29` - `CarrierTaskType`, `CarrierTaskStep`, and draft shape.
  - API/Type: `src/runtime/creepAssignmentState.ts:5-15` - `synthesisCarrierTaskId` assignment state.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` fails before implementation for at least one new wrong-target regression.
  - [ ] New tests explicitly distinguish storage target movement from generic energy target movement.
  - [ ] New tests include a preserved legitimate generic fallback case.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Reproduce wrong generic target fallback
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` after adding tests only.
    Expected: At least one new terminal_offload test fails because current code calls generic energy delivery or moves toward a non-storage target.
    Evidence: .sisyphus/evidence/task-1-terminal-offload-red.txt

  Scenario: Test suite isolation
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand --testNamePattern="terminal_offload"`.
    Expected: Output identifies the new failing regression without unrelated test pollution or mock setup errors.
    Evidence: .sisyphus/evidence/task-1-terminal-offload-red-focused.txt
  ```

  **Commit**: NO | Message: `test(carrier): reproduce terminal offload target drift` | Files: [src/roles/carrier.test.ts]

- [x] 2. Implement terminal_offload task-bound delivery guard

  **What to do**: Update `src/roles/carrier.ts` so active `terminal_offload` cargo remains bound to the assigned task storage target instead of falling through to generic energy delivery. The implementation must be minimal and local to carrier delivery logic.

  Required implementation decision:
  - Add a terminal_offload-specific task-bound delivery path in or immediately adjacent to `deliverSynthesisCarrierResource()`.
  - When `assigned?.type === "terminal_offload"` and the creep carries a step resource, resolve the step `toId` storage even if `to.store.getFreeCapacity(resource) <= 0`.
  - If target exists:
    - Call `creep.transfer(target, resource)`.
    - On `ERR_NOT_IN_RANGE`, call `moveToTarget(creep, target)` and return handled (`true`) so `carrierRole.target()` does not continue to generic `getEnergyStoreTarget()`.
    - On `OK`, preserve existing completion behavior: clear task only when no carried resource remains.
    - On `ERR_FULL`, return handled (`true`) without clearing the task and without generic fallback; creep remains in target phase to retry later.
    - On `ERR_INVALID_TARGET` or missing target, clear the synthesis carrier task plan and allow existing fallback behavior.
  - For non-terminal_offload tasks, keep existing `selectDeliveryStep()` behavior unchanged.

  **Must NOT do**: Do not change `src/mount/mountCreep.ts`. Do not set `carrierStorageOnlyMode` as the primary terminal_offload fix because that branch can choose terminal when storage is full. Do not change `getEnergyStoreTarget()` priority. Do not change resourceControl task generation.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: targeted single-file role logic change with existing failing tests.
  - Skills: [] - no special skill needed.
  - Omitted: [`frontend-ui-ux`] - not frontend; [`playwright`] - not browser.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [3] | Blocked By: [1]

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.ts:460-490` - synthesis task pickup assigns task and withdraws from `fromId`.
  - Pattern: `src/roles/carrier.ts:559-594` - existing delivery helper; preserve normal success and movement behavior.
  - Pattern: `src/roles/carrier.ts:671-773` - target phase fallthrough to generic energy delivery; the fix must prevent this while terminal_offload task cargo is still bound.
  - Pattern: `src/roles/energyTargets.ts:52-164` - generic delivery priority that must not be reached for active terminal_offload cargo.
  - API/Type: `src/runtime/carrierTaskBoard.ts:1-29` - task/step fields (`type`, `resource`, `fromKind`, `toKind`, `toId`).

  **Acceptance Criteria** (agent-executable only):
  - [ ] All new tests from Task 1 pass.
  - [ ] Existing terminal_offload stability tests around `src/roles/carrier.test.ts:1397-1464` still pass.
  - [ ] No implementation touches files outside `src/roles/carrier.ts` unless tests reveal an unavoidable type/mock issue.
  - [ ] `carrierRole.target()` still calls generic `getEnergyStoreTarget()` when the creep has energy and no active synthesis carrier task.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Terminal_offload moves only toward storage
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand --testNamePattern="terminal_offload"`.
    Expected: New storage-bound tests pass; assertions prove `moveToTarget` receives storage and never the fake non-storage target.
    Evidence: .sisyphus/evidence/task-2-terminal-offload-green-focused.txt

  Scenario: Full storage does not divert carrier
    Tool: Bash
    Steps: Run the specific full-storage wrong-target test with Jest `--testNamePattern` matching its name.
    Expected: `getEnergyStoreTarget` is not called from target phase and no movement toward spawn/extension/tower occurs.
    Evidence: .sisyphus/evidence/task-2-full-storage-no-divert.txt
  ```

  **Commit**: NO | Message: `fix(carrier): keep terminal offload bound to storage` | Files: [src/roles/carrier.ts, src/roles/carrier.test.ts]

- [x] 3. Run verification and prepare deployment evidence

  **What to do**: Run focused and full verification after Task 2. Collect command outputs as evidence. If verification fails, fix only issues directly caused by this change and re-run the same command.

  Required commands:
  1. `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand`
  2. `npm run test`
  3. `npx tsc --noEmit`
  4. If final wave and user approval pass during execution, deploy with `npm run push` per project workflow.

  **Must NOT do**: Do not deploy before final review wave approval and explicit user okay. Do not use `npm run push` as a substitute for Jest/TypeScript verification.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: verification and small fix-forward if needed.
  - Skills: [] - no special skill needed.
  - Omitted: [`git-master`] - only needed if committing is requested during execution.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1, F2, F3, F4] | Blocked By: [2]

  **References** (executor has NO interview context - be exhaustive):
  - Command: `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` - focused carrier regression verification.
  - Command: `npm run test` - full Jest suite.
  - Command: `npx tsc --noEmit` - TypeScript verification.
  - Command: `npm run push` - deploy after approval only, per project workflow.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Focused carrier Jest command exits 0.
  - [ ] Full Jest command exits 0.
  - [ ] TypeScript no-emit command exits 0.
  - [ ] Evidence files contain command, exit status, and relevant pass/fail summary.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Full automated verification
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand && npm run test && npx tsc --noEmit`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-3-verification.txt

  Scenario: Deployment readiness gate
    Tool: Bash
    Steps: After final review wave approval and explicit user okay, run `npm run push`.
    Expected: Rollup compiles `dist/main.js` and upload completes without authorization/build errors.
    Evidence: .sisyphus/evidence/task-3-deploy.txt
  ```

  **Commit**: YES | Message: `fix(carrier): keep terminal offload bound to storage` | Files: [src/roles/carrier.ts, src/roles/carrier.test.ts]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Single atomic commit after all tests pass: `fix(carrier): keep terminal offload bound to storage`.
- Include only `src/roles/carrier.ts` and `src/roles/carrier.test.ts` unless verification exposes a directly related test helper/type issue.
- Do not commit generated `dist/` or secret files.

## Success Criteria
- Terminal_offload task cargo never moves toward generic non-storage energy targets while `synthesisCarrierTaskId` remains active.
- Same-tick movement toward storage is preserved.
- Legitimate generic energy delivery without an active synthesis task is preserved.
- Focused carrier tests, full Jest suite, and TypeScript verification pass.
- Final review wave approves and user explicitly approves before completion/deploy.

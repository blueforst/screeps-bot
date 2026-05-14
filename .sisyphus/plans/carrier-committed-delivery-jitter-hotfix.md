# Carrier Committed Delivery Jitter Hotfix

## TL;DR
> **Summary**: Fix the live carrier resource jitter by making task-board non-energy pickups a committed delivery: once a carrier accepts a task pickup, matching carried cargo must go to the original destination before terminal/storage cleanup paths. Also cap `withdraw` to the task step amount so lab supply carriers do not over-withdraw OH.
> **Deliverables**:
> - Multi-tick committed-delivery guard for synthesis carrier task cargo.
> - Amount-bounded `withdraw` for carrier task-board steps.
> - Regression coverage for stale snapshots, multi-tick travel, over-withdraw, invalid target fallback, source re-entry, and terminal_offload non-regression.
> - Full verification and live deployment.
> **Effort**: Short
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2/3/4 → Task 5 → Final Verification → Deploy

## Context
### Original Request
- Live after deploy: “没有正常供料”.
- Correction: “UO在lab中”.
- Live symptom: “carrier在terminal反复存放OH”.
- Amount bug: “carrier取OH的数量也不对, 没有取合成需要的量”.
- Expanded scope: “需要彻底修复类似的问题” and “避免carrier再反复抖动拿存资源”.

### Interview Summary
- Treat this as a follow-up hotfix to the previous lab synthesis carrier jitter work.
- Success is not merely “OH reaches the lab once”; success is a reusable carrier invariant preventing task-bound cargo from falling into generic terminal/storage cleanup while a valid committed destination exists.
- Keep scope focused on carrier task-board cargo semantics; do not redesign the entire carrier role.

### Metis Review (gaps addressed)
- Metis identified the direct live chain: pickup succeeds, delivery may take more than one tick, `pendingStepId` expires, snapshot fallback is skipped, OH falls through to terminal cleanup.
- Metis separated two defects: over-withdraw (`withdraw(resource)` without amount) and stale delivery binding (one-tick window). Both must be fixed.
- Metis warned that open-ended “harden lifecycle” could cause scope creep; this plan uses a precise committed-delivery guard instead.

### Oracle Review (architecture decision)
- Oracle confirmed the invariant: if `synthesisCarrierPendingToId` + `synthesisCarrierPendingResource` exist and the creep carries that resource, delivery must target the snapshot destination before generic cleanup/offload paths, regardless of pickup tick age or task-board freshness.
- Oracle recommended reusing existing snapshot fields, not adding a new Memory-backed reservation system.
- Oracle recommended leaving `carrierTaskBoard` and `energyPickupReservation` unchanged.

## Work Objectives
### Core Objective
Eliminate carrier resource jitter for task-bound non-energy cargo by preserving committed delivery intent across multi-tick travel, task-board refresh, and Screeps intent latency.

### Deliverables
- `src/roles/carrier.ts` updates:
  - Committed-delivery guard at the top of `deliverSynthesisCarrierResource()`.
  - Amount-capped task-board `withdraw` in `pickupSynthesisCarrierResource()`.
  - Source re-entry preservation of snapshot destination/resource while matching cargo is carried.
  - Invalid target fallback that clears snapshot before existing cleanup behavior.
- Tests in `src/roles/carrier.test.ts` covering live-style jitter regressions.
- If needed, focused tests in `src/runtime/synthesisControlStateMachine.test.ts` proving in-flight accounting remains correct with bounded withdrawal.
- Evidence files under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx jest --runTestsByPath src/roles/carrier.test.ts src/runtime/synthesisControlStateMachine.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- Live-style QA confirms carrier with OH no longer terminal-loops when snapshot target lab is valid.
- `npm run push` deploys after final verification approval.

### Must Have
- `lab_supply` withdrawal must pass an explicit amount: `Math.min(step.amount, creep.store.getFreeCapacity(resource), source.store.getUsedCapacity(resource), target.store.getFreeCapacity(resource))` or equivalent.
- Snapshot delivery must run before generic non-energy cleanup if snapshot target and resource are valid.
- Snapshot delivery must be independent of `synthesisCarrierPendingPickupTick >= Game.time - 1`.
- Existing `terminal_offload` behavior must remain unchanged for terminal offload tasks.
- Existing `mineral_haul`, `lab_cleanup`, and `lab_product_unload` task-board paths must not regress.

### Must NOT Have
- Do NOT redesign `src/runtime/carrierTaskBoard.ts` replacement semantics.
- Do NOT modify `src/runtime/energyPickupReservation.ts`.
- Do NOT move assignment state from `global` to creep `Memory`.
- Do NOT touch `hubPlanner`, `resourceControl`, terminal market behavior, or room planning logic.
- Do NOT add generic mineral delivery in the normal energy carrier target path.
- Do NOT rely on human visual observation as the only verification.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.
- Live QA uses Screeps read-only API/console read operations first; deploy only after final verification.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. This hotfix is intentionally small; wave sizes are smaller to preserve ordering around the carrier state machine.

Wave 1: Task 1 foundation test harness and RED regressions.
Wave 2: Tasks 2-4 implementation and focused edge tests.
Wave 3: Task 5 verification, live read-only validation, and deploy.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | none | 2, 3, 4 |
| 2 | 1 | 5 |
| 3 | 1 | 5 |
| 4 | 1 | 5 |
| 5 | 2, 3, 4 | F1-F4, Deploy |

### Agent Dispatch Summary
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 3 | quick, quick, unspecified-high |
| 3 | 1 | unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add RED regressions for committed delivery and over-withdraw

  **What to do**: In `src/roles/carrier.test.ts`, add failing tests before implementation for the live defects:
  1. A `lab_supply` step with `amount=45`, terminal has `OH=800`, carrier capacity `800`; `source()` must call `withdraw(terminal, RESOURCE_HYDROXIDE, 45)`.
  2. Carrier carries `OH`, has `synthesisCarrierPendingToId` pointing at reagent lab and `synthesisCarrierPendingResource=OH`, but `synthesisCarrierPendingPickupTick` is older than `Game.time - 1`; `target()` must transfer to the lab, not terminal/storage.
  3. Multi-tick travel: simulate tick N pickup, tick N+1 out of range, tick N+2 still carrying OH with stale pickup tick; delivery must still target the lab.
  **Must NOT do**: Do not modify implementation in this task except test scaffolding. Do not weaken existing assertions.

  **Recommended Agent Profile**:
  - Category: `quick` - focused test additions in an existing test file.
  - Skills: [] - no external skill needed.
  - Omitted: [`playwright`] - no browser UI.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2, 3, 4 | Blocked By: none

  **References**:
  - Pattern: `src/roles/carrier.test.ts:1946` - existing snapshot delivery test after board clear.
  - Pattern: `src/roles/carrier.test.ts:2260` - existing multi-tick synthesis jitter test.
  - API/Type: `src/runtime/creepAssignmentState.ts:14-20` - existing synthesis snapshot fields.
  - Behavior: `src/mount/mountCreep.ts:82-103` - source/target switch and same-tick re-entry semantics.
  - Bug source: `src/roles/carrier.ts:483` - unbounded withdraw call.
  - Bug source: `src/roles/carrier.ts:577-649` - stale pending step window and nested snapshot fallback.

  **Acceptance Criteria**:
  - [ ] Running `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand` fails for the new tests before implementation.
  - [ ] Failure messages prove expected lab delivery/amount cap behavior, not unrelated setup errors.
  - [ ] Save RED evidence to `.sisyphus/evidence/task-1-carrier-committed-delivery-red.txt`.

  **QA Scenarios**:
  ```
  Scenario: RED over-withdraw regression
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "withdraws only the lab_supply step amount"`.
    Expected: Test fails because current code calls withdraw without the amount argument.
    Evidence: .sisyphus/evidence/task-1-over-withdraw-red.txt

  Scenario: RED stale snapshot terminal-loop regression
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "delivers stale committed lab_supply cargo to lab"`.
    Expected: Test fails because current code routes stale OH to terminal/storage or returns false instead of transferring to lab.
    Evidence: .sisyphus/evidence/task-1-stale-snapshot-red.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/roles/carrier.test.ts`, `.sisyphus/evidence/*`]

- [x] 2. Implement committed-delivery guard before generic cleanup

  **What to do**: In `src/roles/carrier.ts`, add a small helper or inline guard at the top of `deliverSynthesisCarrierResource()`:
  - Read `state.synthesisCarrierPendingToId` and `state.synthesisCarrierPendingResource`.
  - If both exist and `creep.store.getUsedCapacity(snapshotResource) > 0`, resolve the target.
  - If target exists and has free capacity for the resource, transfer/move to that target and return `true`.
  - If transfer is `OK`, clear pickup tick/step and clear all snapshot fields only when the store is empty after the intent resolves on a later tick; preserve delivery tick semantics consistent with existing code.
  - If target is missing/destroyed or cannot accept the resource, clear snapshot fields and fall through to existing cleanup behavior.
  - Keep existing `terminal_offload` block behavior unchanged.
  **Must NOT do**: Do not add a new reservation system, do not rewrite carrier phases, do not edit `carrierTaskBoard.ts`.

  **Recommended Agent Profile**:
  - Category: `quick` - localized change in `carrier.ts`.
  - Skills: [] - no external skill needed.
  - Omitted: [`ai-slop-remover`] - review happens in final wave.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 1

  **References**:
  - Bug source: `src/roles/carrier.ts:573-735` - `deliverSynthesisCarrierResource()`.
  - Existing fallback to preserve: `src/roles/carrier.ts:618-649` - board-cleared snapshot fallback.
  - Terminal offload guardrail: `src/roles/carrier.ts:652-697` - must remain behavior-compatible.
  - Generic cleanup path to preempt: `src/roles/carrier.ts:699-735`.

  **Acceptance Criteria**:
  - [ ] Stale snapshot test from Task 1 passes.
  - [ ] Multi-tick travel test from Task 1 passes.
  - [ ] Existing terminal_offload tests in `carrier.test.ts` still pass.
  - [ ] No changes to `src/runtime/carrierTaskBoard.ts`.

  **QA Scenarios**:
  ```
  Scenario: Stale committed cargo routes to lab
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "delivers stale committed lab_supply cargo to lab"`.
    Expected: Pass; transfer mock receives reagent lab id and OH, not terminal id.
    Evidence: .sisyphus/evidence/task-2-stale-snapshot-green.txt

  Scenario: Terminal offload unaffected
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "terminal_offload"`.
    Expected: Pass; terminal_offload remains task-bound and does not use the lab snapshot guard unless snapshot resource is carried.
    Evidence: .sisyphus/evidence/task-2-terminal-offload-regression.txt
  ```

  **Commit**: YES | Message: `fix(carrier): commit task cargo to snapshot delivery` | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`, `.sisyphus/evidence/task-2-*`]

- [x] 3. Cap task-board withdrawal amount to requested step amount

  **What to do**: In `pickupSynthesisCarrierResource()` in `src/roles/carrier.ts`, replace unbounded `creep.withdraw(from, assignment.step.resource)` with an explicit amount:
  - `const freeCapacity = creep.store.getFreeCapacity(assignment.step.resource)`.
  - `const sourceAvailable = from.store.getUsedCapacity(assignment.step.resource)`.
  - `const target = resolveTaskStructure(assignment.step.toId)` and `targetFree = target?.store.getFreeCapacity(assignment.step.resource) ?? 0`.
  - `const withdrawAmount = Math.min(assignment.step.amount, freeCapacity, sourceAvailable, targetFree)`.
  - If `withdrawAmount <= 0`, clear only invalid pickup state and return not picked.
  - Call `creep.withdraw(from, assignment.step.resource, withdrawAmount)`.
  - Snapshot fields still record step target/resource; do not add an amount field unless tests prove it necessary.
  **Must NOT do**: Do not change `generateSupplyTask()` amount semantics in this task. Do not globally cap all energy carrier pickups.

  **Recommended Agent Profile**:
  - Category: `quick` - one API call fix plus tests.
  - Skills: [] - no external skill needed.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 1

  **References**:
  - Bug source: `src/roles/carrier.ts:467-503` - pickupSynthesisCarrierResource.
  - Task step type: `src/runtime/carrierTaskBoard.ts:3-11` - `CarrierTaskStep.amount` contract.
  - Supply task amount source: `src/runtime/synthesisControl.ts:949-966` - lab_supply step amount generation.

  **Acceptance Criteria**:
  - [ ] RED over-withdraw test from Task 1 passes.
  - [ ] Tests prove `withdraw` receives the exact bounded amount.
  - [ ] If target lab free capacity is lower than step amount, `withdraw` amount is capped to target free capacity.
  - [ ] If computed amount is 0, no withdraw intent is issued.

  **QA Scenarios**:
  ```
  Scenario: Lab supply withdraw uses step amount
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "withdraws only the lab_supply step amount"`.
    Expected: Pass; `withdraw(terminal, OH, 45)` or equivalent bounded amount is asserted.
    Evidence: .sisyphus/evidence/task-3-over-withdraw-green.txt

  Scenario: Zero-capacity target prevents pickup
    Tool: Bash
    Steps: Run a focused new test where destination lab has 0 free OH capacity and source has OH.
    Expected: No withdraw call; carrier does not pick cargo it cannot deliver.
    Evidence: .sisyphus/evidence/task-3-target-capacity-guard.txt
  ```

  **Commit**: YES | Message: `fix(carrier): cap task-board withdraw amounts` | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`, `.sisyphus/evidence/task-3-*`]

- [x] 4. Preserve committed snapshot through source re-entry and invalid-target fallback

  **What to do**: Harden lifecycle edge cases without broad redesign:
  - In `source()`, where `hadPendingPickup` clears `synthesisCarrierPendingPickupTick` and `synthesisCarrierPendingStepId`, preserve `synthesisCarrierPendingToId` and `synthesisCarrierPendingResource` if the creep still carries that resource.
  - Ensure `carrierStorageOnlyMode` is not set while the creep carries a resource matching a valid snapshot destination.
  - Add invalid-target behavior in committed-delivery guard: when snapshot target cannot resolve, clear snapshot fields and allow existing cleanup delivery to terminal/storage.
  - Keep no-snapshot non-energy cleanup behavior unchanged for ruins/tombstones and legitimate lab cleanup.
  **Must NOT do**: Do not prevent cleanup of genuinely orphaned minerals with no snapshot. Do not change ruin pickup behavior.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - state-machine edge cases require careful reasoning.
  - Skills: [] - no external skill needed.
  - Omitted: [`git-master`] - commit handled by executor workflow.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 1

  **References**:
  - Source re-entry cleanup: `src/roles/carrier.ts:783-788`.
  - Storage-only mode entry: `src/roles/carrier.ts:825-835` and `src/roles/carrier.ts:850-885`.
  - Invalid cleanup target behavior: `src/roles/carrier.ts:561-570` and `src/roles/carrier.ts:708-716`.

  **Acceptance Criteria**:
  - [ ] New source re-entry test passes: snapshot destination/resource survive while matching OH is carried.
  - [ ] New invalid-target test passes: destroyed/missing lab causes snapshot clear and terminal/storage cleanup, with no infinite loop.
  - [ ] Existing owned-room ruin pickup and cleanup tests still pass.
  - [ ] No snapshot fields remain after successful full delivery.

  **QA Scenarios**:
  ```
  Scenario: Source re-entry preserves committed destination
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "source re-entry preserves committed lab_supply snapshot"`.
    Expected: Pass; `synthesisCarrierPendingToId` and `synthesisCarrierPendingResource` remain while OH is carried.
    Evidence: .sisyphus/evidence/task-4-source-reentry-green.txt

  Scenario: Invalid target falls back safely
    Tool: Bash
    Steps: Run `npx jest --runTestsByPath src/roles/carrier.test.ts --runInBand -t "clears committed snapshot when lab target is gone"`.
    Expected: Pass; snapshot clears, cargo routes to cleanup target, no repeated lab movement to null target.
    Evidence: .sisyphus/evidence/task-4-invalid-target-green.txt
  ```

  **Commit**: YES | Message: `fix(carrier): preserve committed delivery state across reentry` | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`, `.sisyphus/evidence/task-4-*`]

- [x] 5. Full verification, live read-only validation, and deployment

  **What to do**:
  - Run targeted Jest for changed carrier/synthesis tests.
  - Run full Jest, TypeScript, and production build.
  - Before deployment, use Screeps read-only API/console reads to capture current E4N58 state: synthesis stage, reagent lab stores, carrier cargo, carrier assignment snapshot fields.
  - Deploy with `npm run push` only after full verification passes.
  - After deployment, use read-only API/console reads for at least three ticks to verify that a carrier carrying lab_supply OH retains committed destination or delivers to the OH lab, and does not repeatedly deposit OH into terminal when the lab target is valid.
  - Clean temporary Memory inspection keys after monitoring.
  **Must NOT do**: Do not mutate game state except deployment and temporary inspection keys that are deleted after use. Do not manually move creeps/resources through console.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - verification + live monitoring.
  - Skills: [] - no external skill needed.
  - Omitted: [`playwright`] - Screeps monitoring is API/console based here.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: F1-F4, Deploy completion | Blocked By: 2, 3, 4

  **References**:
  - Commands: `AGENTS.md` project commands: `npm run test`, `npx tsc --noEmit`, `npm run build`, `npm run push`.
  - Live room: E4N58, current product UHO2, reagent labs from runtime state.
  - Workflow memory: deploy to Screeps via `npm run push` after successful verification.

  **Acceptance Criteria**:
  - [ ] `npx jest --runTestsByPath src/roles/carrier.test.ts src/runtime/synthesisControlStateMachine.test.ts --runInBand` passes.
  - [ ] `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run build` passes.
  - [ ] `npm run push` succeeds.
  - [ ] Post-deploy live read shows no valid-snapshot OH carrier terminal-loop across the monitoring window.

  **QA Scenarios**:
  ```
  Scenario: Automated verification suite
    Tool: Bash
    Steps: Run targeted Jest, full Jest, TypeScript, and build commands.
    Expected: All commands exit 0; outputs saved.
    Evidence: .sisyphus/evidence/task-5-verification.txt

  Scenario: Live E4N58 carrier no longer terminal-loops task cargo
    Tool: Bash + Screeps API read-only console/memory reads
    Steps: After deploy, inspect E4N58 synthesis runtime, reagent lab stores, carriers carrying OH, and assignment snapshot fields for at least three ticks.
    Expected: A carrier carrying OH with a valid lab_supply snapshot moves/delivers to the OH lab; no repeated terminal offload occurs while target lab has free capacity.
    Evidence: .sisyphus/evidence/task-5-live-monitoring.json
  ```

  **Commit**: YES | Message: `test(carrier): verify committed delivery jitter fix` | Files: [`src/roles/carrier.test.ts`, `src/runtime/synthesisControlStateMachine.test.ts`, `.sisyphus/evidence/task-5-*`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `fix(carrier): commit task cargo to snapshot delivery` — committed-delivery guard and stale snapshot tests.
- Commit 2: `fix(carrier): cap task-board withdraw amounts` — amount-bounded withdraw and capacity tests.
- Commit 3: `fix(carrier): preserve committed delivery state across reentry` — lifecycle hardening and invalid-target tests.
- Commit 4: `test(carrier): verify committed delivery jitter fix` — any remaining verification/evidence-only test refinements if needed.

## Success Criteria
- Carrier no longer uses terminal/storage cleanup for task-bound lab_supply OH when the intended lab is valid.
- Carrier withdraws only the required task step amount, not full carry capacity.
- Multi-tick travel does not expire committed delivery.
- Existing terminal_offload/mineral_haul/lab_cleanup behavior remains compatible.
- Full automated verification passes and live post-deploy monitoring confirms no repeated OH terminal-loop.

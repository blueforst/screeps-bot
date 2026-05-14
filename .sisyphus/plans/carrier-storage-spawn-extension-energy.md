# Carrier Storage Withdrawal for Spawn/Extension Energy

## TL;DR
> **Summary**: Change carrier storage energy withdrawal so storage is used only when the carrier is currently sourcing energy for a spawn or extension delivery target. Encode the behavior with TDD regression tests, including emergency carrier cases.
> **Deliverables**:
> - Carrier regression tests for spawn/extension-positive and non-spawn/extension-negative storage withdrawal behavior
> - `src/roles/carrier.ts` storage pickup gate changed from emergency-carrier based to spawn/extension-target based
> - Dead-code cleanup for the old emergency storage gate if no references remain
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Final Verification Wave

## Context
### Original Request
允许carrier在为extension/spawn供能时从storage取能, 其他情况不允许carrier从storage取能

### Interview Summary
- Scope is the normal `carrier` role only.
- Test strategy is TDD.
- The rule applies to all carriers, including emergency/manual max carriers: storage energy withdrawal is allowed only when the selected delivery target is a spawn or extension.
- Non-energy carrier tasks and delivery behavior are out of scope.

### Metis Review (gaps addressed)
- Metis identified the intentional emergency-carrier behavior change: emergency carriers lose unconditional storage access for tower/factory/lab/etc. delivery.
- Metis identified likely dead code: local `isEmergencyResponseCarrier()` and `emergencyResponseMode` become unused after the gate changes.
- Metis recommended extracting a shared boolean because proto-storage and real storage gates should both depend on `isSpawnOrExtensionTarget(energyDemandTarget)`.
- Metis warned not to add target-phase validation for target changes after withdrawal; this is pre-existing carrier behavior and out of scope.

## Work Objectives
### Core Objective
Ensure `carrier` creeps may withdraw `RESOURCE_ENERGY` from room storage only when the current source-phase delivery target selected by `getEnergyStoreTarget()` is a spawn or extension.

### Deliverables
- New TDD tests in `src/roles/carrier.test.ts`.
- Minimal implementation change in `src/roles/carrier.ts`.
- Verification evidence stored under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose` passes.
- `npx tsc --noEmit` passes.
- `npm test` passes.
- Final review agents approve and user explicitly says okay before work is considered complete.

### Must Have
- Normal carrier + spawn target + storage energy → carrier withdraws from storage.
- Normal carrier + extension target + storage energy → carrier withdraws from storage.
- Normal carrier + tower/factory target + storage energy → carrier does not withdraw from storage.
- Emergency/manual max carrier + spawn target + storage energy → carrier withdraws from storage.
- Emergency/manual max carrier + tower target + storage energy → carrier does not withdraw from storage.
- Existing no-demand emergency carrier guard remains passing.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- MUST NOT modify `src/roles/remoteCarrier.ts`.
- MUST NOT modify worker behavior.
- MUST NOT modify `src/roles/energyTargets.ts` target priority ordering.
- MUST NOT modify `pickupEnergyForCarrier()`, `getWeightedCarrierPickupCandidates()`, or `isCarrierPickupTarget()` lower-level semantics.
- MUST NOT touch synthesis carrier tasks (`lab_supply`, `lab_cleanup`, `mineral_haul`, `terminal_feed`, `terminal_offload`).
- MUST NOT touch `src/runtime/resourceControl.ts`, terminal tasks, spawn planner, main loop ordering, or deployment config.
- MUST NOT add logging, analytics, comments, abstractions, interfaces, or type aliases for this small behavior change.
- MUST NOT add target-phase validation for the case where the original spawn/extension target becomes full after storage withdrawal.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest/ts-jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (`quick`) — implement the behavior with TDD: write failing tests, update gate, confirm targeted GREEN.
Wave 2: Task 2 (`quick`) — run full verification and capture evidence.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 2 |
| 2 | 1 | Final Verification Wave |
| F1-F4 | 1, 2 | Completion |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | `quick` |
| 2 | 1 | `quick` |
| Final | 4 | `oracle`, `unspecified-high`, `unspecified-high`, `deep` |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Implement spawn/extension-only storage withdrawal gate with TDD

  **What to do**: Use TDD in `src/roles/carrier.test.ts` and `src/roles/carrier.ts`. First add failing Jest tests proving storage energy withdrawal is allowed only when the carrier source-phase `energyDemandTarget` is a spawn or extension. Confirm RED. Then update the carrier source-phase storage access rule so `includeStorage` is true only when the selected `energyDemandTarget` is a spawn or extension. Confirm GREEN with the targeted carrier test command.

  Required tests to add before implementation:
  1. Normal carrier with spawn target and storage energy withdraws from storage.
  2. Normal carrier with extension target and storage energy withdraws from storage.
  3. Normal carrier with tower target and storage energy does not withdraw from storage.
  4. Normal carrier with factory target and storage energy does not withdraw from storage.
  5. Emergency/manual max carrier with spawn target and storage energy withdraws from storage.
  6. Emergency carrier with tower target and storage energy does not withdraw from storage.

  Implementation requirements:
  - Use `getEnergyStoreTarget.mockReturnValue(...)` in tests to control the current delivery target, storage mocks with `store.getUsedCapacity(RESOURCE_ENERGY) > 0`, and the existing reservation mock pattern so storage can be chosen when `includeStorage` permits it.
  - In `src/roles/carrier.ts`, use the existing `isSpawnOrExtensionTarget(energyDemandTarget)` helper.
  - Extract a shared local boolean, for example `const isSupplyingSpawnOrExtension = isSpawnOrExtensionTarget(energyDemandTarget);`, and use it for both the existing proto-storage gate and the new real-storage gate.
  - Keep `includeProtoStorage` behavior equivalent to current behavior.
  - Change the `pickupEnergyForCarrier()` call that currently passes `includeStorage: emergencyResponseMode` to pass the shared spawn/extension boolean.
  - Keep the fallback `pickupEnergyForCarrier(... includeStorage: false ...)` path unchanged.
  - If `isEmergencyResponseCarrier()` and `emergencyResponseMode` have no remaining references after this change, remove them in the same task.

  **Must NOT do**: Do not add shared mock factories. Do not test `remoteCarrier`. Do not add broad snapshot tests. Do not change `getEnergyStoreTarget()` priority. Do not modify target-phase delivery. Do not modify `carrierStorageOnlyMode`. Do not alter synthesis carrier tasks, ruin pickup logic, or lower-level pickup candidate filtering functions.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized Jest test additions plus narrow one-file behavior change.
  - Skills: [`superpowers:test-driven-development`] - Needed because RED/GREEN ordering is required.
  - Omitted: [`frontend-ui-ux`, `graphify`, `superpowers:brainstorming`] - No UI/graph work; requirements and approach are already decided.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.test.ts` - existing carrier mock setup, `createRoom()`, `createCreep()`, module mocks, and carrier source/target tests.
  - Pattern: `src/roles/carrier.test.ts` - existing test named `does not let emergency carriers withdraw storage energy when no delivery target needs energy`; use as the negative storage access precedent.
  - Pattern: `src/roles/carrier.test.ts` - existing proto-storage tests named `can withdraw from proto storage container when spawn or extension demand exists` and `does not withdraw from proto storage container when only tower demand exists`; use as spawn/extension-vs-tower gating precedent.
  - API/Type: `src/roles/carrier.ts:isSpawnOrExtensionTarget` - current target classifier that should define allowed storage withdrawal.
  - Pattern: `src/roles/carrier.ts` source phase - existing `energyDemandTarget` calculation and `pickupEnergyForCarrier()` call.
  - Pattern: `src/roles/carrier.ts` fallback source-phase `includeStorage: false` path - leave unchanged.
  - Pattern: `src/runtime/creepAssignmentState.ts:carrierStorageOnlyMode` - delivery-only state; do not modify.
  - API/Type: `src/roles/energyTargets.ts:getEnergyStoreTarget` - mocked selector for source-phase delivery target.
  - Test command: `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Running `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose` after adding tests and before implementation fails because storage withdrawal is not yet allowed for normal spawn/extension targets and/or emergency tower behavior still uses the old gate.
  - [ ] Failure output is saved to `.sisyphus/evidence/task-1-carrier-storage-gate-red.txt`.
  - [ ] After implementation, `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose` exits 0 and output is saved to `.sisyphus/evidence/task-1-carrier-storage-gate-green.txt`.
  - [ ] `src/roles/carrier.ts` contains no unused local `emergencyResponseMode` variable.
  - [ ] If `isEmergencyResponseCarrier()` has no references, it is removed; otherwise its remaining use is documented in evidence.
  - [ ] No files outside `src/roles/carrier.ts` and `src/roles/carrier.test.ts` are modified by this task.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: RED proves normal spawn/extension carriers need storage access
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose` after adding the normal carrier spawn/extension tests and before changing `carrier.ts`; redirect output to `.sisyphus/evidence/task-1-carrier-storage-gate-red.txt`.
    Expected: Command exits non-zero with at least one new positive storage-withdrawal test failing because current code gates storage on emergency carrier status.
    Evidence: .sisyphus/evidence/task-1-carrier-storage-gate-red.txt

  Scenario: RED proves emergency tower storage access must be removed
    Tool: Bash
    Steps: In the same targeted Jest run, inspect output for the new emergency-carrier-with-tower-target negative test.
    Expected: The new test fails before implementation if the current emergency storage gate still allows tower-target storage withdrawal.
    Evidence: .sisyphus/evidence/task-1-carrier-storage-gate-red.txt

  Scenario: GREEN proves storage is allowed only for spawn/extension supply
    Tool: Bash
    Steps: Implement the gate, then run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose`; redirect output to `.sisyphus/evidence/task-1-carrier-storage-gate-green.txt`.
    Expected: Command exits 0; spawn/extension positive tests pass for normal and emergency carriers; tower/factory negative tests pass; existing no-demand emergency guard still passes.
    Evidence: .sisyphus/evidence/task-1-carrier-storage-gate-green.txt
  ```

  **Commit**: YES | Message: `fix(carrier): gate storage withdrawal to spawn extension supply` | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`]

- [x] 2. Run full verification and capture completion evidence

  **What to do**: Run the complete verification command set and capture outputs. Confirm no unintended files changed beyond `src/roles/carrier.ts` and `src/roles/carrier.test.ts` unless the test runner produces ignored artifacts. Do not deploy in this task; deployment occurs only after final verification wave approval and explicit user okay per project workflow.

  Commands:
  1. `npx tsc --noEmit`
  2. `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose`
  3. `npm test`

  **Must NOT do**: Do not run `npm run push` before final wave approval and explicit user okay. Do not run formatters that rewrite unrelated files. Do not broaden verification failures into unrelated refactors.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: deterministic command execution and evidence capture.
  - Skills: [] - No extra skill required.
  - Omitted: [`frontend-ui-ux`] - No browser/UI verification.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [F1, F2, F3, F4] | Blocked By: [1]

  **References** (executor has NO interview context - be exhaustive):
  - Command: `npx tsc --noEmit` - TypeScript verification.
  - Command: `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose` - targeted carrier regression verification.
  - Command: `npm test` - full Jest suite.
  - Workflow rule: after final wave approval and explicit user okay, deploy with `npm run push`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] TypeScript verification exits 0 and output is saved to `.sisyphus/evidence/task-2-tsc.txt`.
  - [ ] Targeted carrier Jest verification exits 0 and output is saved to `.sisyphus/evidence/task-2-carrier-jest.txt`.
  - [ ] Full Jest suite exits 0 and output is saved to `.sisyphus/evidence/task-2-npm-test.txt`.
  - [ ] `git diff --name-only` shows only intended source/test files plus `.sisyphus/evidence/` outputs.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Type and targeted regression verification
    Tool: Bash
    Steps: Run `npx tsc --noEmit` and `npx jest --config jest.config.cjs src/roles/carrier.test.ts --verbose`; save outputs to the task-2 evidence files.
    Expected: Both commands exit 0 with no TypeScript errors and all carrier tests passing.
    Evidence: .sisyphus/evidence/task-2-tsc.txt and .sisyphus/evidence/task-2-carrier-jest.txt

  Scenario: Full suite regression verification
    Tool: Bash
    Steps: Run `npm test`; save output to `.sisyphus/evidence/task-2-npm-test.txt`.
    Expected: Command exits 0 with the full Jest suite passing.
    Evidence: .sisyphus/evidence/task-2-npm-test.txt
  ```

  **Commit**: NO | Message: N/A | Files: [`.sisyphus/evidence/task-2-tsc.txt`, `.sisyphus/evidence/task-2-carrier-jest.txt`, `.sisyphus/evidence/task-2-npm-test.txt`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
  - Verify the implementation matches this plan exactly: storage withdrawal is allowed only for spawn/extension delivery targets, including emergency carriers.
  - Verify no out-of-scope files were modified.
- [x] F2. Code Quality Review — unspecified-high
  - Verify the implementation is minimal, readable, and does not introduce unused code.
  - Verify the shared boolean is clear and no unnecessary abstractions/comments were added.
- [x] F3. Real Manual QA — unspecified-high
  - Execute the commands from Task 2 using the produced branch state.
  - Review evidence files and confirm test output demonstrates the positive and negative cases.
- [x] F4. Scope Fidelity Check — deep
  - Confirm remoteCarrier, worker, synthesis carrier tasks, resourceControl, spawn planner, and delivery target priority are untouched.
  - Confirm the emergency-carrier behavior change is intentional and encoded by tests.

## Commit Strategy
- One implementation commit after Task 1 succeeds:
  - `fix(carrier): gate storage withdrawal to spawn extension supply`
  - Files: `src/roles/carrier.ts`, `src/roles/carrier.test.ts`
- Do not commit generated `.sisyphus/evidence/` files unless the user explicitly requests evidence tracking in git.
- After final verification wave approval and explicit user okay, deploy with `npm run push` per project workflow.

## Success Criteria
- Carrier storage energy withdrawal is permitted only when the source-phase delivery target is a spawn or extension.
- Emergency/manual max carriers obey the same spawn/extension-only storage withdrawal rule.
- Non-spawn/extension targets, including tower and factory, cannot trigger storage withdrawal.
- Existing proto-storage behavior remains unchanged.
- Existing carrierStorageOnlyMode behavior remains unchanged.
- TypeScript, targeted carrier tests, and full Jest suite all pass.

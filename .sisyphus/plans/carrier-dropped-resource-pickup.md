# Carrier Dropped Resource Pickup Recovery

## TL;DR
> **Summary**: Fix owned-room ordinary carriers so resources lost from dead carriers are recovered from dropped Resource piles and tombstones. Keep current energy-demand behavior intact by adding non-energy orphan recovery beside the existing owned-room ruin recovery, plus a target-phase delivery branch for recovered non-energy cargo.
> **Deliverables**:
> - TDD regression tests in `src/roles/carrier.test.ts`
> - Non-energy dropped-resource and tombstone getters in `src/runtime/tickContext.ts`
> - Owned-room carrier orphan pickup path in `src/roles/carrier.ts`
> - Owned-room carrier non-energy delivery path to terminal then storage
> - Full Jest + TypeScript + build verification
> **Effort**: Short
> **Parallel**: NO - small sequential change set with final parallel review wave
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Final Verification Wave

## Context
### Original Request
User reported: `carrier搬运资源时死亡, 资源掉在地上carrier不会去捡`.

### Interview Summary
- Scope selected: owned-room ordinary carriers only.
- Resource scope selected: all resources.
- Test strategy selected: TDD recommended.
- Interpretation for “all resources”: existing energy pickup remains responsible for energy; the new path fills the missing non-energy dropped-resource and tombstone recovery gap so energy and non-energy are both recoverable without mixed-cargo complexity.

### Metis Review (gaps addressed)
- Added explicit target-phase non-energy delivery branch; without it, carriers holding orphan non-energy cargo would idle in target phase.
- Avoid mixed cargo: new orphan recovery runs only when `creep.store.getUsedCapacity() === 0`.
- Do not modify `energyPickupReservation.ts`; new non-energy recovery is opportunistic like existing ruin pickup.
- Do not refactor `pickupEnergyForCarrier` or `getWeightedCarrierPickupCandidates`; keep them energy-only.
- Energy demand remains higher priority than orphan non-energy recovery.

## Work Objectives
### Core Objective
Owned-room ordinary carriers recover carrier-death resources from the ground/tombstones instead of ignoring them, without changing remote hauling, synthesis tasks, or energy-demand priority.

### Deliverables
- `src/roles/carrier.test.ts` has red-first tests for dropped non-energy pickup, tombstone non-energy pickup, non-energy delivery, and priority/guardrails.
- `src/runtime/tickContext.ts` exposes lazy cached non-energy dropped resources and non-energy tombstones.
- `src/roles/carrier.ts` has a new owned-room orphan recovery function modeled after existing ruin pickup.
- `src/roles/carrier.ts` target phase delivers orphan non-energy cargo to terminal first, then storage.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/roles/carrier.test.ts` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- `npm run build` passes.
- No changes to `src/roles/remoteCarrier.ts`.
- No changes to `src/runtime/energyPickupReservation.ts` except if required by TypeScript import fallout; preferred result is zero diff in that file.

### Must Have
- Energy demand stays first priority in `carrierRole().source` (`src/roles/carrier.ts:789-816`).
- New pickup runs after synthesis task pickup and before fallback energy pickup, near existing ruin pickup (`src/roles/carrier.ts:831-857`).
- New pickup requires owned room (`creep.room.controller?.my`) and empty store (`creep.store.getUsedCapacity() === 0`).
- Dropped Resource objects use `creep.pickup(resource)`.
- Tombstones use `creep.withdraw(tombstone, resourceType)` with selected non-energy resource.
- Non-energy delivery uses assigned-room terminal first, then storage via existing `getSynthesisCleanupDeliveryTarget` semantics (`src/roles/carrier.ts:568-577`).

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- MUST NOT change `remoteCarrier` behavior.
- MUST NOT broaden this into all roles or all logistics systems.
- MUST NOT mix energy and non-energy in one newly recovered load.
- MUST NOT extend energy pickup reservations for non-energy recovery.
- MUST NOT make energy pickup resource-agnostic.
- MUST NOT remove the planned-storage dropped-energy exclusion (`src/roles/carrier.ts:59-64`, `src/roles/carrier.ts:103`).
- MUST NOT change synthesis task assignment/delivery semantics.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with existing Jest/ts-jest framework.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. This plan is intentionally smaller than target because source and target behavior touch the same role file and must be sequenced for TDD clarity.

Wave 1: Task 1 (TDD regression spec)
Wave 2: Task 2 (tick context getters)
Wave 3: Task 3 (carrier source pickup)
Wave 4: Task 4 (target-phase non-energy delivery)
Wave 5: Task 5 (verification and post-approval deployment readiness)

### Dependency Matrix (full, all tasks)
- Task 1: no blockers; blocks Tasks 2-5.
- Task 2: blocked by Task 1; blocks Task 3.
- Task 3: blocked by Tasks 1-2; blocks Task 4.
- Task 4: blocked by Tasks 1 and 3; blocks Task 5.
- Task 5: blocked by Tasks 1-4.
- Final Verification Wave: blocked by Task 5.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 1 task → `quick`
- Wave 2 → 1 task → `quick`
- Wave 3 → 1 task → `quick`
- Wave 4 → 1 task → `quick`
- Wave 5 → 1 task → `quick`
- Final Verification → 4 review agents → oracle, unspecified-high, unspecified-high, deep

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add red regression tests for owned carrier orphan resource recovery

  **What to do**: In `src/roles/carrier.test.ts`, add failing tests before implementation. Use existing mocks/helpers from lines `1-145` and the owned-room ruin test pattern at `src/roles/carrier.test.ts:1024-1066`. Required tests:
  1. empty owned-room carrier with no energy demand picks up a dropped non-energy Resource via `creep.pickup(resource)`;
  2. empty owned-room carrier with no energy demand withdraws non-energy from tombstone via `creep.withdraw(tombstone, RESOURCE_UTRIUM)`;
  3. carrier with orphan `RESOURCE_UTRIUM` cargo transfers to terminal when terminal has capacity;
  4. carrier with orphan `RESOURCE_UTRIUM` cargo transfers to storage when terminal is full and storage has capacity;
  5. carrier does not pick up orphan non-energy when `getEnergyStoreTarget` returns an energy-demand target;
  6. carrier does not pick up orphan non-energy when already carrying anything;
  7. new orphan pickup ignores energy-only dropped resources and energy-only tombstones;
  8. terminal and storage both full: carrier with non-energy cargo returns a stable target-phase false/no-crash result and does not call `transfer`.

  **Must NOT do**: Do not edit implementation files in this task except if import/type fixes are necessary for tests to compile. Do not add tests for `remoteCarrier`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused regression test additions in one existing test file.
  - Skills: [] - no specialized skill required.
  - Omitted: [`superpowers:test-driven-development`] - user selected TDD but Sisyphus can execute directly from this plan.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: Tasks 2, 3, 4, 5 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.test.ts:1-145` - existing Jest mocks and helpers for carrier role tests.
  - Pattern: `src/roles/carrier.test.ts:1024-1066` - existing owned-room non-energy ruin pickup test; mirror its room/creep setup.
  - API/Type: `src/roles/carrier.ts:513-543` - existing owned-room ruin pickup behavior that new tests should generalize from.
  - Command: `package.json:13` - `npm run test` uses Jest config.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` fails before implementation for the new expected behavior, with failures caused by missing orphan pickup/delivery logic rather than syntax/type errors.
  - [ ] New tests use concrete resource constants such as `RESOURCE_UTRIUM` and `RESOURCE_CATALYZED_UTRIUM_ACID`.
  - [ ] New tests assert exact calls: `pickup(resource)`, `withdraw(tombstone, RESOURCE_UTRIUM)`, and `transfer(terminalOrStorage, RESOURCE_UTRIUM)`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Red test captures dropped non-energy pickup gap
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` immediately after adding tests and before implementation.
    Expected: Command exits non-zero; at least one new test fails because `creep.pickup` was not called for dropped `RESOURCE_UTRIUM`.
    Evidence: .sisyphus/evidence/task-1-red-dropped-resource.txt

  Scenario: Red test captures orphan non-energy delivery gap
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` immediately after adding tests and before implementation.
    Expected: Command exits non-zero; at least one new test fails because `creep.transfer` was not called for carried `RESOURCE_UTRIUM`.
    Evidence: .sisyphus/evidence/task-1-red-delivery.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/roles/carrier.test.ts`]

- [x] 2. Add non-energy dropped-resource and tombstone getters to tick context

  **What to do**: In `src/runtime/tickContext.ts`, extend `RoomTickContext` with `getDroppedNonEnergyResources(): Resource[]` and `getNonEnergyTombstones(): Tombstone[]`. Implement both using the existing lazy-cache style at `src/runtime/tickContext.ts:44-193`. `getDroppedNonEnergyResources` must use `room.find(FIND_DROPPED_RESOURCES, { filter: resource.resourceType !== RESOURCE_ENERGY })`. `getNonEnergyTombstones` must include tombstones where at least one stored resource other than `RESOURCE_ENERGY` has positive amount; use `Object.keys(tombstone.store)` plus `store.getUsedCapacity(resource)` to avoid counting energy-only tombstones.

  **Must NOT do**: Do not add a ruin getter. Do not change existing energy getters or their filters.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: small typed API extension in one runtime file.
  - Skills: [] - no specialized skill required.
  - Omitted: [`refactor`] - not a broad refactor.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: Task 3 | Blocked By: Task 1

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/tickContext.ts:1-20` - `RoomTickContext` interface currently lists room-level getters.
  - Pattern: `src/runtime/tickContext.ts:44-62` - local lazy-cache variable declarations.
  - Pattern: `src/runtime/tickContext.ts:169-192` - existing dropped energy, energy tombstone, and energy ruin cache implementations.
  - Constraint: `src/runtime/energyPickupReservation.ts:38-48` remains energy-only; this task must not touch it.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx tsc --noEmit` reaches no errors attributable to the new `RoomTickContext` interface/getters.
  - [ ] Existing `getDroppedEnergyResources`, `getEnergyTombstones`, and `getEnergyRuins` behavior remains unchanged in diff.
  - [ ] No modifications are made to `src/runtime/energyPickupReservation.ts`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Tick context exposes non-energy dropped resources
    Tool: Bash
    Steps: Run `npx tsc --noEmit` after adding getters.
    Expected: TypeScript accepts callers using `roomContext.getDroppedNonEnergyResources()` and `roomContext.getNonEnergyTombstones()`.
    Evidence: .sisyphus/evidence/task-2-tsc.txt

  Scenario: Energy-only APIs remain unchanged
    Tool: Bash
    Steps: Run `git diff -- src/runtime/tickContext.ts src/runtime/energyPickupReservation.ts`.
    Expected: Diff shows only additive non-energy getters in `tickContext.ts`; no diff in `energyPickupReservation.ts`.
    Evidence: .sisyphus/evidence/task-2-diff.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/tickContext.ts`]

- [x] 3. Implement owned-room orphan pickup in carrier source phase

  **What to do**: In `src/roles/carrier.ts`, add a new helper named `pickupOwnedRoomOrphanResource(creep)` modeled after `pickupOwnedRoomRuinResource` at lines `513-543`. It must:
  - require `creep.room.controller?.my`;
  - require `creep.store.getUsedCapacity() === 0`;
  - read `roomContext.getDroppedNonEnergyResources()` and `roomContext.getNonEnergyTombstones()`;
  - select nearest candidate by `creep.pos.getRangeTo(candidate.pos)`;
  - for dropped resources, call `creep.pickup(resource)` and move on `ERR_NOT_IN_RANGE`;
  - for tombstones, choose the largest non-energy resource using a new helper analogous to `getBestRuinResource`, then call `creep.withdraw(tombstone, resource)` and move on `ERR_NOT_IN_RANGE`;
  - return `{ picked: boolean; outOfRange: boolean }` like existing pickup helpers.
  Insert the call after synthesis task pickup handling and before `pickupOwnedRoomRuinResource` at `src/roles/carrier.ts:850`. Keep energy demand priority at `src/roles/carrier.ts:789-816` unchanged.

  **Must NOT do**: Do not alter `pickupEnergyForCarrier`, `getWeightedCarrierPickupCandidates`, or reservation calls. Do not pick up energy-only resources in this helper.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused role behavior addition following an existing nearby helper pattern.
  - Skills: [] - no specialized skill required.
  - Omitted: [`ai-slop-remover`] - not needed for a small helper if code follows existing style.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: Task 4 | Blocked By: Tasks 1, 2

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.ts:33-44` - `getStoredResources` and `getBestRuinResource` resource selection style.
  - Pattern: `src/roles/carrier.ts:513-543` - owned-room ruin pickup helper to mirror.
  - Pattern: `src/roles/carrier.ts:831-857` - source-phase insertion point after synthesis pickup and before ruin pickup.
  - Guardrail: `src/roles/carrier.ts:789-816` - energy demand pickup stays higher priority.
  - API: `src/runtime/tickContext.ts:17-20` after Task 2 - new getter names.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Targeted carrier tests from Task 1 for dropped non-energy pickup and tombstone non-energy pickup pass.
  - [ ] Test for “does not pick up orphan non-energy when energy demand exists” passes.
  - [ ] Test for “does not pick up orphan non-energy when already carrying something” passes.
  - [ ] `src/roles/remoteCarrier.ts` has no diff.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Empty owned carrier recovers dropped non-energy pile
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand -t "dropped non-energy"`.
    Expected: Command exits 0; assertion confirms `creep.pickup(resource)` was called and source returned true or moved out-of-range according to fixture.
    Evidence: .sisyphus/evidence/task-3-dropped-nonenergy.txt

  Scenario: Energy demand remains higher priority
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand -t "energy demand"`.
    Expected: Command exits 0; assertion confirms orphan non-energy pickup is not attempted while `getEnergyStoreTarget` returns a spawn/extension energy target.
    Evidence: .sisyphus/evidence/task-3-energy-priority.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`]

- [x] 4. Add target-phase delivery for orphan non-energy cargo

  **What to do**: In `src/roles/carrier.ts`, add a target-phase branch immediately after `deliverSynthesisCarrierResource(creep)` at lines `885-891` and before the energy-only branch at `src/roles/carrier.ts:893`. The branch must:
  - call `getFirstNonEnergyResource(creep)`;
  - if none exists, continue existing energy path unchanged;
  - choose `getSynthesisCleanupDeliveryTarget(creep, resource)`;
  - call `creep.transfer(target, resource)`;
  - on `ERR_NOT_IN_RANGE`, call `moveToTarget(creep, target)` and return `false`;
  - on `OK`, return `creep.store.getUsedCapacity(resource) === 0` or `creep.store.getUsedCapacity() === 0` consistent with existing target semantics;
  - if terminal/storage are full or unavailable, return `false` without clearing unrelated synthesis state and without falling through to energy-only delivery.

  **Must NOT do**: Do not route non-energy cargo through `getEnergyStoreTarget`. Do not drop resources. Do not clear `synthesisCarrierPendingToId` unless using existing synthesis snapshot path.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: small target-phase branch in one role file, backed by tests.
  - Skills: [] - no specialized skill required.
  - Omitted: [`frontend-ui-ux`] - no UI work.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: Task 5 | Blocked By: Tasks 1, 3

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/roles/carrier.ts:545-566` - helpers to find first carried non-energy/resource.
  - Pattern: `src/roles/carrier.ts:568-577` - terminal then storage non-energy delivery target.
  - Insertion: `src/roles/carrier.ts:885-893` - after synthesis delivery, before energy-only no-energy branch.
  - Guardrail: `src/roles/carrier.ts:957-1010` - existing energy target delivery must remain energy-only and unchanged except control flow before it.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Tests for non-energy terminal delivery and storage fallback pass.
  - [ ] Test for terminal+storage full passes: no crash, no `transfer`, stable `false` return.
  - [ ] Existing energy delivery tests still pass.
  - [ ] No new code path calls `getEnergyStoreTarget` for non-energy resources.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Orphan non-energy cargo delivers to terminal
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand -t "terminal"` with the new orphan non-energy delivery test name.
    Expected: Command exits 0; assertion confirms `creep.transfer(terminal, RESOURCE_UTRIUM)`.
    Evidence: .sisyphus/evidence/task-4-terminal-delivery.txt

  Scenario: Full terminal falls back to storage
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand -t "storage"` with the new fallback test name.
    Expected: Command exits 0; assertion confirms `creep.transfer(storage, RESOURCE_UTRIUM)` when terminal has zero free capacity.
    Evidence: .sisyphus/evidence/task-4-storage-fallback.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`]

- [x] 5. Run full verification and prepare deploy-ready result

  **What to do**: Run targeted and full verification. Fix only issues directly caused by Tasks 1-4. Capture command output evidence. Prepare the branch for Final Verification Wave review. Deployment happens only in the Post-Approval Deployment step after all final review agents approve and the user gives explicit okay.

  **Must NOT do**: Do not run `npm run push` in this task. Do not make opportunistic refactors.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: verification and small fixes if needed.
  - Skills: [] - no specialized skill required.
  - Omitted: [`git-master`] - no commit requested in this plan.

  **Parallelization**: Can Parallel: NO | Wave 5 | Blocks: Final Verification Wave | Blocked By: Tasks 1, 2, 3, 4

  **References** (executor has NO interview context - be exhaustive):
  - Command: `package.json:7` - `npm run build`.
  - Command: `package.json:13` - `npm run test`.
  - Project rule: `AGENTS.md` commands include `npx tsc --noEmit`, `npm run test`, `npm run build`.
  - Scope guard: `src/roles/remoteCarrier.ts` must be unchanged.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/roles/carrier.test.ts --runInBand` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] `git diff -- src/roles/remoteCarrier.ts src/runtime/energyPickupReservation.ts` shows no diff.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Full automated regression suite passes
    Tool: Bash
    Steps: Run `npm run test`.
    Expected: Command exits 0; all Jest suites pass.
    Evidence: .sisyphus/evidence/task-5-jest.txt

  Scenario: TypeScript and bundle build pass
    Tool: Bash
    Steps: Run `npx tsc --noEmit` then `npm run build`.
    Expected: Both commands exit 0; Rollup bundle is produced without TypeScript errors.
    Evidence: .sisyphus/evidence/task-5-type-build.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/roles/carrier.ts`, `src/runtime/tickContext.ts`, `src/roles/carrier.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Post-Approval Deployment
After F1-F4 all approve and the user explicitly says okay, run `npm run push` per project workflow.

**Acceptance Criteria**:
- [x] `npm run push` exits 0 and uploads the built bundle.
- [x] Evidence saved to `.sisyphus/evidence/post-approval-push.txt`.

**Reference**:
- `package.json:8` - `npm run push` compiles with Rollup and deploys to Screeps `DEST:main`.

## Commit Strategy
- No commit is required by this plan unless the user explicitly requests it.
- If commit is requested after approval, use one semantic commit: `fix(carrier): recover orphan dropped resources`.
- Commit files should be limited to `src/roles/carrier.ts`, `src/runtime/tickContext.ts`, and `src/roles/carrier.test.ts`.

## Success Criteria
- Owned-room carrier recovers non-energy dropped Resource piles when no energy demand exists.
- Owned-room carrier recovers non-energy resources from tombstones when no energy demand exists.
- Existing energy pickup remains responsible for energy resources and remains priority when there is active energy demand.
- Recovered non-energy cargo is delivered to terminal first, storage second.
- Existing synthesis, ruin pickup, energy delivery, and remote carrier behavior continue to pass tests.

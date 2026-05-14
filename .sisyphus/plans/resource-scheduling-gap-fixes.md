# Resource Scheduling Gap Fixes

## TL;DR
> **Summary**: Fix all audited resource scheduling gaps A-I plus Metis finding J, prioritizing silent resource loss and terminal double-intent risks before hub/synthesis/carrier edge cases.
> **Deliverables**:
> - Market sell protection for resources already committed to transfer tasks
> - Terminal busy propagation into market operations
> - Hub planner fixes for stale reactions, per-resource export blocking, tiny imports, full-storage distribution fallback, incoming transfer accounting, and distribution during blocked chains
> - Synthesis donor guard against duplicate hub-bound sourcing
> - Carrier lab-cleanup unstuck fallback
> - Regression tests for every gap
> **Effort**: Medium
> **Parallel**: YES - 4 waves
> **Critical Path**: Task 1 → Task 2 → Tasks 3-8 → Task 9 → Task 10 → Final Verification

## Context
### Original Request
- User asked: “检查资源调度逻辑是否还有疏漏”.
- After audit summary, user selected: “规划全部修复”.

### Interview Summary
- No further product preference is required. Defaults applied:
  - Gap E uses per-resource export blocking, not room-wide blocking.
  - Gap H clears the stuck synthesis carrier assignment before adding riskier drop-on-ground behavior.
  - Gap D clears stale hub-driven synthesis reactions when hub is blocked; implementation may use a short consecutive-block debounce only if tests prove immediate clearing interrupts current test patterns.
  - Gap F skips tiny hub imports below a named minimum threshold; it must not change global `createResourceTransferTask` semantics.

### Metis Review (gaps addressed)
- Metis confirmed gaps A-I and added finding J: `planHubDistribution` is skipped when chain planning is blocked, so existing hub T3 stock is not distributed while base inputs are missing.
- Metis guardrails incorporated:
  - Do not change main tick order.
  - Do not change `getStock` semantics.
  - Do not add cross-reason merge behavior to `createResourceTransferTask`.
  - Keep tests narrowly tied to these gaps; do not expand into full synthesis architecture refactor.

## Work Objectives
### Core Objective
Make resource scheduling resilient against resource loss, double terminal intents, stale hub synthesis work, hub distribution starvation, duplicate sourcing, tiny failed tasks, and carrier cleanup deadlocks.

### Deliverables
- Direct unit/regression coverage for `resourceTransferTasks.ts`.
- Targeted tests and fixes in `resourceControl.ts`, `hubPlanner.ts`, `synthesisControl.ts`, and `carrier.ts`.
- Evidence files under `.sisyphus/evidence/` for each task.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- Targeted suites pass:
  - `npx jest src/runtime/resourceControl.test.ts --runInBand`
  - `npx jest src/runtime/hubPlanner.test.ts --runInBand`
  - `npx jest src/runtime/synthesisControl.test.ts --runInBand`
  - `npx jest src/roles/carrier.test.ts --runInBand`
  - `npx jest src/runtime/logistics/resourceTransferTasks.test.ts --runInBand`
- No `.secret.json` or generated deploy credential files are staged.

### Must Have
- Market operations must not sell resources already reserved by pending outgoing resource transfer tasks.
- Market operations must not use a terminal already used by balancing or transfer task execution in the same `runResourceControl()` call.
- Hub export blocking must become per-resource rather than whole-room.
- Hub planner must clear stale hub-driven synthesis reactions when hub cannot safely plan.
- Hub planner must distribute existing T3 stock even when chain production is blocked.
- Hub chain planner must account for pending incoming hub transfers.
- Hub import planner must not create non-executable tiny transfer tasks.
- Synthesis donor selection must not duplicate hub-bound incoming resource tasks.
- Carrier lab cleanup must not leave a carrier permanently assigned and idle with cargo when normal destinations are full.

### Must NOT Have
- Do not reorder `main.ts` loop phases.
- Do not add market buying for HUB production.
- Do not weaken survival energy priority.
- Do not change global `getStock()` behavior.
- Do not change `createResourceTransferTask()` to merge across different reasons.
- Do not create a second lab reaction executor.
- Do not add new global exports or modify `Creep.work()` mount behavior.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest + TypeScript compile checks.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 foundation tests for resource transfer task store.
Wave 2: Tasks 2-3 high-risk resourceControl fixes.
Wave 3: Tasks 4-8 hubPlanner fixes; Task 9 synthesis guard may start after Task 1 but should merge after Task 4/8 test helpers are stable.
Wave 4: Task 10 carrier fallback and full regression hardening.

### Dependency Matrix (full, all tasks)
- T1 blocks T2, T4, T8, T9 because they rely on transfer-task accounting confidence.
- T2 blocks T3 because terminal-busy market tests should use the same market fixture baseline.
- T4 blocks T9 because synthesis duplicate-source behavior depends on hub incoming accounting semantics.
- T5, T6, T7, T8 can run after T1 and do not block each other except for file merge conflicts in `hubPlanner.ts`.
- T10 can run independently after reading carrier test patterns.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 1 task → quick
- Wave 2 → 2 tasks → deep
- Wave 3 → 6 tasks → quick/deep split by module complexity
- Wave 4 → 1 implementation task + final verification → deep / unspecified-high / oracle

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add direct resource transfer task store regression tests

  **What to do**: Create `src/runtime/logistics/resourceTransferTasks.test.ts`. Test `createResourceTransferTask` validation (`ERR_INVALID_ROOM`, `ERR_SAME_ROOM`, `ERR_INVALID_RESOURCE`, `ERR_INVALID_AMOUNT`), same `(from,to,resource,reason)` merge behavior, different-reason non-merge behavior, incoming/outgoing counters, cancellation, and cleanup of stale done/failed/cancelled tasks. Follow existing Jest setup patterns from `src/runtime/resourceControl.test.ts` and `src/runtime/hubPlanner.test.ts`.
  **Must NOT do**: Do not change production logic in this task unless tests reveal current behavior contradicts the plan.

  **Recommended Agent Profile**:
  - Category: `quick` - focused test addition around one module.
  - Skills: [] - no special skill needed.
  - Omitted: [`superpowers:test-driven-development`] - plan already mandates TDD and scope is narrow.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: T2, T4, T8, T9 | Blocked By: none

  **References**:
  - Pattern: `src/runtime/logistics/resourceTransferTasks.ts:90-150` - validation and merge behavior.
  - Pattern: `src/runtime/logistics/resourceTransferTasks.ts:178-243` - counters and cleanup.
  - Test: `src/runtime/resourceControl.test.ts` - Memory/Game mock style.
  - Test: `src/runtime/hubPlanner.test.ts` - transfer task store setup patterns.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/logistics/resourceTransferTasks.test.ts --runInBand` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Same reason merges; different reason stays separate
    Tool: Bash
    Steps: Run `npx jest src/runtime/logistics/resourceTransferTasks.test.ts --runInBand --testNamePattern="merge"`.
    Expected: Same reason task has accumulated amount; different reason creates separate task.
    Evidence: .sisyphus/evidence/task-1-resource-transfer-tests.txt

  Scenario: Invalid task inputs are rejected
    Tool: Bash
    Steps: Run `npx jest src/runtime/logistics/resourceTransferTasks.test.ts --runInBand --testNamePattern="invalid"`.
    Expected: Invalid room/resource/amount cases return exact error strings and no task is stored.
    Evidence: .sisyphus/evidence/task-1-resource-transfer-invalid.txt
  ```

  **Commit**: YES | Message: `test(logistics): cover resource transfer task store` | Files: [`src/runtime/logistics/resourceTransferTasks.test.ts`]

- [x] 2. Prevent market sells from consuming resources reserved by transfer tasks

  **What to do**: In `src/runtime/resourceControl.ts`, adjust `applyMarketOps` sell surplus calculation so non-energy sellable stock subtracts `getOutgoingResourceTransferAmount(room.roomName, resource)` before computing surplus and amount. Keep `getStock()` unchanged. Add tests where a satellite/native export room has a pending `hub:import:H` or intermediate transfer task and a valid market buy order; verify no sale occurs for the reserved amount. Add regression test proving unrelated unreserved minerals can still be sold.
  **Must NOT do**: Do not protect all non-hub base minerals globally; only subtract pending outgoing transfer reservations from the same room/resource.

  **Recommended Agent Profile**:
  - Category: `deep` - touches market/resource scheduling with regression risk.
  - Skills: [] - no external docs needed.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: T3 | Blocked By: T1

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:995-1082` - market sell loop.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:178-185` - outgoing transfer accounting helper.
  - Test: `src/runtime/resourceControl.test.ts:1018-1140` - hub-protected market sell tests.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/resourceControl.test.ts --runInBand --testNamePattern="pending.*transfer|market"` passes.
  - [ ] `npm run test -- --runInBand` passes or repository-equivalent full Jest command passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Pending hub import prevents market sale of same resource
    Tool: Bash
    Steps: Run the new resourceControl test for pending `hub:import:H` plus market buy order.
    Expected: `Game.market.deal` is not called for H; pending transfer task remains pending.
    Evidence: .sisyphus/evidence/task-2-market-reservation.txt

  Scenario: Unreserved native mineral still sells normally
    Tool: Bash
    Steps: Run existing/regression test for non-hub unmanaged K sell.
    Expected: Market deal occurs for K when no pending outgoing K task exists.
    Evidence: .sisyphus/evidence/task-2-market-regression.txt
  ```

  **Commit**: YES | Message: `fix(resource): reserve pending transfers from market sells` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 3. Propagate terminal busy state into market operations

  **What to do**: Change `applyMarketOps` signature to accept `terminalBusy: Set<string>`. Skip sell, emergency buy, and mineral buy operations for rooms in `terminalBusy`. Pass the existing `terminalBusy` set from `runResourceControl()` after `applyInternalBalancing` and `executeTransferTasks`. Add tests proving a transfer-task terminal send suppresses same-tick market deal and that an idle room can still market deal.
  **Must NOT do**: Do not move market ops before transfer tasks; transfer task priority must remain above market actions.

  **Recommended Agent Profile**:
  - Category: `deep` - same-tick side-effect ordering is behavior-critical.
  - Skills: [] - no special skill needed.
  - Omitted: [`git-master`] - commit handled by executor workflow.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: none | Blocked By: T2

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:1267-1291` - `runResourceControl()` order and `terminalBusy` creation.
  - Pattern: `src/runtime/resourceControl.ts:540-651` - transfer task execution marks terminal busy.
  - Pattern: `src/runtime/resourceControl.ts:995-1214` - market ops loops.
  - Test: `src/runtime/resourceControl.test.ts:1143-1176` - hub import/export transfer task setup.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/resourceControl.test.ts --runInBand --testNamePattern="terminal.*busy|market"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Terminal used by transfer task cannot market sell same tick
    Tool: Bash
    Steps: Create test with pending transfer task and market order from same room; run targeted Jest pattern.
    Expected: Terminal `.send` called for transfer; `Game.market.deal` not called for same room.
    Evidence: .sisyphus/evidence/task-3-terminal-busy-market.txt

  Scenario: Different idle market room still trades
    Tool: Bash
    Steps: Run regression test with busy room A and idle export room B.
    Expected: Room B can execute market deal while room A is skipped.
    Evidence: .sisyphus/evidence/task-3-terminal-busy-regression.txt
  ```

  **Commit**: YES | Message: `fix(resource): skip market ops for busy terminals` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 4. Clear stale hub synthesis reactions when hub planning is blocked or disabled

  **What to do**: Add a helper in `src/runtime/hubPlanner.ts` to clear `Memory.cfg.synthesisControl.rooms[hubRoomName].reactions` for the hub room without deleting lab IDs or room config. Call it when hub config becomes disabled/no hub room is available if prior hub room is known, and when the hub is blocked for missing room, ownership, storage, terminal, or labs. If immediate clearing breaks existing lifecycle tests, add explicit consecutive-block tracking in `Memory.runtime.hub` and clear after a named small threshold. Add tests for blocked terminal/labs and disabled config retaining room config but emptying reactions.
  **Must NOT do**: Do not disable global synthesisControl or clear reactions for non-hub rooms.

  **Recommended Agent Profile**:
  - Category: `deep` - memory lifecycle and synthesis side effects.
  - Skills: [] - no special skill needed.
  - Omitted: [`artistry`] - conventional bugfix.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T9 | Blocked By: T1

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:418-460` - synthesis config writer preserving room config.
  - Pattern: `src/runtime/hubPlanner.ts:462-541` - blocked return paths.
  - Test: `src/runtime/hubPlanner.test.ts` - blocked state tests.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/hubPlanner.test.ts --runInBand --testNamePattern="blocked|clear.*synthesis|disabled"` passes.
  - [ ] Existing synthesis lab ID preservation test still passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Hub blocked by missing terminal clears hub reaction only
    Tool: Bash
    Steps: Run new hubPlanner blocked-terminal test.
    Expected: Hub room `reactions` becomes []; non-hub synthesis config remains unchanged.
    Evidence: .sisyphus/evidence/task-4-clear-stale-synthesis.txt

  Scenario: Lab IDs/config metadata are preserved
    Tool: Bash
    Steps: Run preservation regression test.
    Expected: `reagentLabIds` and room config still exist after reactions are cleared.
    Evidence: .sisyphus/evidence/task-4-preserve-synthesis-config.txt
  ```

  **Commit**: YES | Message: `fix(hub): clear stale synthesis reactions when blocked` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 5. Make hub export blocking per-resource instead of whole-hub

  **What to do**: Replace `getHubRoomsWithPendingImportsOrReclaims(): Set<string>` with a mapping from hub room name to set of resources that currently have pending `hub:import:` or `hub:reclaim:` tasks. In `executeTransferTasks`, skip `hub:export:<resource>` only when the same hub room has pending import/reclaim for the same resource. Add tests: import O no longer blocks export XGHO2; import XGHO2 still blocks export XGHO2.
  **Must NOT do**: Do not remove hub import/reclaim priority over exports; only narrow the blocking scope.

  **Recommended Agent Profile**:
  - Category: `deep` - scheduling priority behavior.
  - Skills: [] - no special skill needed.
  - Omitted: [] - none.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: T1

  **References**:
  - Pattern: `src/runtime/resourceControl.ts:528-538` - current room-level pending import set.
  - Pattern: `src/runtime/resourceControl.ts:575-578` - current export skip.
  - Test: `src/runtime/resourceControl.test.ts:1143-1176` - current skip test.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/resourceControl.test.ts --runInBand --testNamePattern="hub.*export|different resource"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Different resource import does not block export
    Tool: Bash
    Steps: Pending `hub:import:O` and `hub:export:XGHO2`; run targeted test.
    Expected: XGHO2 export terminal send executes.
    Evidence: .sisyphus/evidence/task-5-per-resource-export.txt

  Scenario: Same resource import still blocks export
    Tool: Bash
    Steps: Pending `hub:import:XGHO2` and `hub:export:XGHO2`; run targeted test.
    Expected: Export skipped until import/reclaim is no longer pending.
    Evidence: .sisyphus/evidence/task-5-same-resource-block.txt
  ```

  **Commit**: YES | Message: `fix(resource): narrow hub export blocking by resource` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 6. Prevent tiny non-executable hub import tasks

  **What to do**: Add named constants in `src/runtime/hubPlanner.ts` for hub import minimum amounts, e.g. `MIN_HUB_IMPORT_AMOUNT = 100` unless existing config exposes a better threshold. Skip base mineral and intermediate imports whose send amount is below the minimum. Keep T3 reclaim threshold behavior based on `surplusThreshold`/`reservePerRoom`. Add tests for base mineral surplus just above floor but below min and intermediate amount below min.
  **Must NOT do**: Do not change `createResourceTransferTask` validation or `transferMinAmount` globally.

  **Recommended Agent Profile**:
  - Category: `quick` - small localized planner guard.
  - Skills: [] - no special skill needed.
  - Omitted: [`oracle`] - no architecture decision.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: T1

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:287-310` - base/intermediate import task creation.
  - Pattern: `src/runtime/resourceControl.ts:607-612` - below transfer min failure behavior to avoid.
  - Test: `src/runtime/hubPlanner.test.ts:424-495` - import/reclaim cases.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/hubPlanner.test.ts --runInBand --testNamePattern="minimum|tiny|import"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Base mineral surplus below hub import minimum is skipped
    Tool: Bash
    Steps: Run new hubPlanner minimum base import test.
    Expected: No `hub:import:H` task is created for surplus below minimum.
    Evidence: .sisyphus/evidence/task-6-tiny-base-import.txt

  Scenario: Meaningful intermediate surplus still imports
    Tool: Bash
    Steps: Run regression test with intermediate amount above minimum.
    Expected: `hub:import:OH` task is created with expected amount.
    Evidence: .sisyphus/evidence/task-6-intermediate-regression.txt
  ```

  **Commit**: YES | Message: `fix(hub): skip tiny import transfer tasks` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 7. Allow T3 distribution to satellites with full storage but terminal capacity

  **What to do**: Change `planHubDistribution` satellite capacity gate so it does not skip the whole satellite solely because storage free capacity is below 10000. Use combined storage+terminal capacity or terminal capacity fallback, and keep final transfer amount capped by destination terminal free capacity because terminal sends land in terminal. Add tests where satellite storage is full, terminal has free capacity, and T3 reserve is below target.
  **Must NOT do**: Do not send raw `terminal.send`; continue creating resource transfer tasks only.

  **Recommended Agent Profile**:
  - Category: `quick` - localized hubPlanner condition and tests.
  - Skills: [] - no special skill needed.
  - Omitted: [] - none.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: none | Blocked By: T1

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:329-416` - distribution planner.
  - Test: `src/runtime/hubPlanner.test.ts:875-950` - T3 distribution tests.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/hubPlanner.test.ts --runInBand --testNamePattern="full storage|terminal capacity|distribution"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Full storage, empty terminal still receives T3 task
    Tool: Bash
    Steps: Run new hubPlanner distribution test.
    Expected: `hub:export:XGHO2` task is created and capped by terminal free capacity.
    Evidence: .sisyphus/evidence/task-7-full-storage-terminal.txt

  Scenario: No destination terminal capacity still skips export
    Tool: Bash
    Steps: Run regression test with both storage/terminal full.
    Expected: No hub export task is created.
    Evidence: .sisyphus/evidence/task-7-no-capacity-regression.txt
  ```

  **Commit**: YES | Message: `fix(hub): distribute compounds when satellite terminal has space` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 8. Account for pending incoming resources and distribute during blocked chains

  **What to do**: In `runHubPlanner`, compute pending incoming amounts for relevant hub resources from the transfer task store and pass them as `incomingResources` to `planHubChains` instead of `{}`. Include pending `hub:import:*`, `hub:reclaim:*`, and `synthesis:*` tasks targeting the hub. Also call `planHubDistribution(cfg)` whenever hub room/storage/terminal prerequisites are valid, even if chain planning is blocked by missing base minerals. Add tests for pending incoming reducing chain demand and for distributing existing T3 while chain planning is blocked.
  **Must NOT do**: Do not count outgoing hub exports as incoming; do not distribute if hub lacks terminal or storage.

  **Recommended Agent Profile**:
  - Category: `deep` - planner accounting affects production sequence.
  - Skills: [] - no special skill needed.
  - Omitted: [] - none.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T9 | Blocked By: T1

  **References**:
  - Pattern: `src/runtime/hubPlanner.ts:142-230` - `planHubChains` incoming support.
  - Pattern: `src/runtime/hubPlanner.ts:512` - current `{}` incoming argument.
  - Pattern: `src/runtime/logistics/resourceTransferTasks.ts:188-195` - incoming transfer accounting helper.
  - Pattern: `src/runtime/hubPlanner.ts:537-540` - distribution currently inside `!blocked` branch.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/hubPlanner.test.ts --runInBand --testNamePattern="incoming|blocked.*distribut"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Pending incoming base mineral reduces chain demand
    Tool: Bash
    Steps: Create pending `hub:import:Z` into hub; run planner test.
    Expected: Chain plan treats incoming Z as available and does not over-request equivalent production/import work.
    Evidence: .sisyphus/evidence/task-8-incoming-chain.txt

  Scenario: Existing T3 distributes even when chain planning is blocked
    Tool: Bash
    Steps: Hub has XGHO2 stock, missing base mineral blocks chains, satellite below reserve.
    Expected: `hub:export:XGHO2` task is created despite blocked chain status.
    Evidence: .sisyphus/evidence/task-8-distribute-while-blocked.txt
  ```

  **Commit**: YES | Message: `fix(hub): account for incoming transfers in planning` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 9. Prevent synthesis from duplicating hub-bound resource sourcing

  **What to do**: Add tests in `src/runtime/synthesisControl.test.ts` proving synthesis does not create an additional `synthesis:<hub>:<product>` transfer for a resource that already has sufficient pending `hub:import:<resource>`/`hub:reclaim:<resource>` incoming to the same target room. Implement the guard in `maybeGenerateSupplyTasks` by including pending incoming task amounts (already used for target room) and, if needed, specifically recognizing hub import/reclaim reasons before donor selection. Preserve current behavior where unrelated donor sourcing happens if no pending incoming resource covers the deficit.
  **Must NOT do**: Do not change `createResourceTransferTask` merge logic to merge different reasons.

  **Recommended Agent Profile**:
  - Category: `deep` - synthesis transfer lifecycle and hub planner interaction.
  - Skills: [] - no special skill needed.
  - Omitted: [] - none.

  **Parallelization**: Can Parallel: YES after T4/T8 | Wave 3 | Blocks: none | Blocked By: T1, T4, T8

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts:815-881` - supply task generation and incoming deficit logic.
  - Pattern: `src/runtime/synthesisControl.ts:432-493` - donor selection subtracts outgoing tasks.
  - Pattern: `src/runtime/hubPlanner.ts:453-458` - hub reaction writes empty donor list.
  - Test: `src/runtime/synthesisControl.test.ts` - existing synthesis tests.

  **Acceptance Criteria**:
  - [ ] `npx jest src/runtime/synthesisControl.test.ts --runInBand --testNamePattern="pending.*hub|duplicate|donor"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Existing hub import satisfies synthesis reagent deficit
    Tool: Bash
    Steps: Pending `hub:import:Z` to hub plus active reaction needing Z; run targeted synthesis test.
    Expected: No extra `synthesis:hub:*` transfer task is created for Z.
    Evidence: .sisyphus/evidence/task-9-no-duplicate-sourcing.txt

  Scenario: No incoming resource still generates synthesis donor task
    Tool: Bash
    Steps: Same reaction with no pending import and eligible donor room.
    Expected: Synthesis transfer task is created normally.
    Evidence: .sisyphus/evidence/task-9-donor-regression.txt
  ```

  **Commit**: YES | Message: `fix(synthesis): avoid duplicate hub-bound sourcing` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControl.test.ts`]

- [x] 10. Unstick synthesis carriers holding cleanup cargo when normal destinations are full

  **What to do**: In `src/roles/carrier.ts`, modify `deliverSynthesisCarrierResource` so when no target exists and the creep has cargo, it clears the synthesis carrier task assignment (and optionally falls back to a safe generic non-energy delivery/drop only if existing carrier patterns support it). Add carrier tests where a lab cleanup carrier has non-energy cargo, assigned target is unavailable/full, terminal/storage are full, and the role does not keep the stale assignment forever.
  **Must NOT do**: Do not alter `Creep.work()` mount behavior; do not add broad delivery priority refactors.

  **Recommended Agent Profile**:
  - Category: `deep` - creep state machine edge case.
  - Skills: [] - no special skill needed.
  - Omitted: [`frontend-ui-ux`] - no UI.

  **Parallelization**: Can Parallel: YES | Wave 4 | Blocks: none | Blocked By: none

  **References**:
  - Pattern: `src/roles/carrier.ts:568-606` - synthesis carrier delivery.
  - Pattern: `src/roles/carrier.ts:608-616` - source phase behavior with cargo.
  - Test: `src/roles/carrier.test.ts` - carrier role test patterns.
  - Runtime: `src/runtime/carrierTaskBoard.ts:1-29` - lab_cleanup task shape.

  **Acceptance Criteria**:
  - [ ] `npx jest src/roles/carrier.test.ts --runInBand --testNamePattern="cleanup|full|stuck"` passes.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```
  Scenario: Cleanup carrier clears stale assignment when no delivery capacity exists
    Tool: Bash
    Steps: Run carrier test with non-energy cargo, full terminal/storage, and assigned lab_cleanup task.
    Expected: Synthesis carrier task plan is cleared; role does not preserve stale assignment indefinitely.
    Evidence: .sisyphus/evidence/task-10-carrier-unstuck.txt

  Scenario: Normal cleanup delivery still works when storage has capacity
    Tool: Bash
    Steps: Run regression test with storage free capacity.
    Expected: Carrier transfers cleanup resource to storage/terminal as before.
    Evidence: .sisyphus/evidence/task-10-carrier-regression.txt
  ```

  **Commit**: YES | Message: `fix(carrier): unstick synthesis cleanup cargo` | Files: [`src/roles/carrier.ts`, `src/roles/carrier.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Resource Scheduling Regression Review — deep
- [x] F3. Real QA — unspecified-high
- [x] F4. Scope Fidelity Check — oracle

## Commit Strategy
- Use atomic semantic commits in English with scope: `test(logistics): ...`, `fix(resource): ...`, `fix(hub): ...`, `fix(synthesis): ...`, `fix(carrier): ...`.
- Commit after each task only after targeted tests, full relevant suite, and `npx tsc --noEmit` pass.
- Do not push or deploy unless explicitly requested.
- Do not commit `.secret.json` or generated deploy credentials.

## Success Criteria
- Resources reserved by pending transfer tasks are never sold by market ops from the same room/resource.
- A terminal used by balancing or transfer tasks is skipped by all same-tick market operations.
- Hub export blocking is per-resource and no longer blocks unrelated T3 distribution.
- Hub stale synthesis reactions clear when hub is blocked/disabled without affecting non-hub synthesis configs.
- Hub distributes existing T3 stock even when production chain planning is blocked.
- Hub chain planning accounts for pending incoming transfers.
- Tiny non-executable import tasks are not created.
- Synthesis does not create duplicate hub-bound resource transfer tasks when pending hub imports/reclaims already cover the deficit.
- Carrier lab cleanup cargo edge case cannot preserve a stale assignment forever.
- Full TypeScript and Jest regression suites pass.

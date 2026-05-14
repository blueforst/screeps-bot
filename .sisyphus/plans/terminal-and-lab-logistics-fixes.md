# Terminal and Lab Logistics Fixes

## TL;DR
> **Summary**: Fix two related logistics bugs: native X terminal staging must respect terminal reserved capacity to stop carrier storage↔terminal oscillation, and synthesis must use precise reagent batches plus explicit product-lab unload so hub chains advance.
> **Deliverables**:
> - Reserve-aware terminal feed/offload behavior for native minerals in `resourceControl`.
> - Deficit-bounded synthesis reagent supply for small hub-chain steps.
> - Explicit `lab_product_unload` carrier task for completed correct products in product labs.
> - Jest coverage for terminal oscillation, precise reagent supply, product unload, and hub-chain progression.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Final Verification

## Context
### Original Request
- E4N58 hub room stopped UO synthesis.
- A carrier in E4N58 repeatedly moved X from storage to terminal despite terminal reserved capacity.
- User clarified product labs still require carrier unload; reagent labs should avoid cleanup by receiving only the amount needed.

### Interview Summary
- Live read-only shard1 inspection showed E4N58 is the hub room, native mineral is X, storage had ~223k X, terminal had ~8.9k X, and a carrier held 800 X.
- No pending catalyst/X inter-room transfer task existed, so X movement was native-mineral terminal staging/auto-sell, not synthesis reagent demand.
- UO target was 106 while product lab held 110 UO; synthesisControl considered the target complete and idled, but hubPlanner only counts storage+terminal and therefore could not see usable UO for the next chain step.
- Current synthesis supply fills reagent labs to default batch size 500 when hubPlanner writes no explicit `batchSize`, causing unnecessary U/O leftover for a ~106 UO deficit.

### Metis Review (gaps addressed)
- Added guardrail: do **not** make hubPlanner count lab contents. Products locked in labs are not usable chain inventory.
- Added guardrail: do **not** change `roomResourceAmount()` completion semantics; lab-held product must count to prevent overproduction.
- Added guardrail: product unload must be separate from contamination cleanup and must prefer storage over terminal.
- Added edge cases: boundary at terminal total 250,000; partial reagent top-up smaller than 5 when it completes a 5-unit reaction batch; multiple product labs; full destinations.
- Added implementation risk: `replaceCarrierTasksForProducerRoom()` can wipe synthesis tasks, so product unload must be included in the same synthesis board replacement or use a clearly separate producer namespace.

## Work Objectives
### Core Objective
Make hub-room terminal and lab logistics converge without carrier churn: native mineral staging must not fight terminal reserved capacity, and completed lab products must become usable storage/terminal inventory while reagent labs avoid avoidable residue.

### Deliverables
- `resourceControl` terminal feed/offload logic respects `TERMINAL_TOTAL_STORAGE_CAP` when creating native mineral feed tasks.
- Synthesis config and/or supply generation uses current product deficit rounded to lab reaction granularity instead of blindly supplying default batch size 500.
- New product-unload carrier task unloads correct completed product from product labs to storage first.
- Regression tests cover all changed behavior.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` passes.
- `npx jest --no-coverage src/runtime/resourceControl.test.ts src/runtime/synthesisControl.test.ts src/runtime/synthesisControlStateMachine.test.ts src/runtime/hubPlanner.test.ts src/roles/carrier.test.ts` passes.
- `npm run test` passes.
- `npm run build` passes.
- Final review agents approve F1-F4, user explicitly approves final verification, then `npm run push` deploys.

### Must Have
- Terminal total must stay at or below `TERMINAL_TOTAL_STORAGE_CAP` for native-mineral feed decisions.
- Existing pending inter-room sends remain protected; terminal feed for pending `ResourceTransferTask`s must still work when there is capacity under the cap.
- Reagent supply amount must be `ceil(productDeficit / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT`, capped by plan/default batch and lab capacity.
- If a reagent lab already has part of the needed reagent, top-up may be less than `LAB_REACTION_AMOUNT` when the final lab amount reaches at least `LAB_REACTION_AMOUNT`.
- Product lab unload must move correct product, not only contaminated/wrong product.
- Product unload must prefer storage; terminal is fallback only when storage cannot accept the product.
- HubPlanner inventory remains storage+terminal only.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not change `TERMINAL_TOTAL_STORAGE_CAP = 250_000`.
- Do not remove native mineral auto-sell globally.
- Do not change energy reserve logic.
- Do not make hubPlanner count lab contents.
- Do not make synthesis target count only storage+terminal.
- Do not repurpose contamination `lab_cleanup` as completed-product unload; add explicit semantics.
- Do not touch `boostControl.ts`, room planner visuals, autoplanner, market pricing logic, or remote hauling.
- Do not deploy before final verification approval.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD for bug reproduction tests, then implementation.
- Framework: Jest + TypeScript compile.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 terminal oscillation fix; Task 2 synthesis precise reagent supply; Task 3 product-unload task type and carrier handling.
Wave 2: Task 4 synthesis state-machine integration and hub progression; Task 5 cross-regression cleanup.
Wave 3: Task 6 verification, build, deploy-after-approval preparation.

### Dependency Matrix (full, all tasks)
- Task 1 blocks Task 5 and Task 6.
- Task 2 blocks Task 4, Task 5, and Task 6.
- Task 3 blocks Task 4, Task 5, and Task 6.
- Task 4 blocks Task 5 and Task 6.
- Task 5 blocks Task 6.
- Task 6 blocks final verification and deployment.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 3 tasks → `quick`, `quick`, `quick`
- Wave 2 → 2 tasks → `unspecified-high`, `quick`
- Wave 3 → 1 task → `unspecified-high`

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Make native mineral terminal feed reserve-aware

  **What to do**:
  - Add failing tests in `src/runtime/resourceControl.test.ts` for E4N58-like native X staging near terminal cap.
  - In `src/runtime/resourceControl.ts`, keep `TERMINAL_TOTAL_STORAGE_CAP = 250_000` unchanged.
  - Modify terminal feed creation so native mineral feed amount is capped by remaining total terminal capacity under `TERMINAL_TOTAL_STORAGE_CAP`, not only `terminal.store.getFreeCapacity(resource)`.
  - Use post-offload projected total from `syncTerminalFeedTasks()` as the capacity basis: after overflow offload drafts adjust `overflowTotal`, compute `feedCapacity = Math.max(0, TERMINAL_TOTAL_STORAGE_CAP - overflowTotal)` and decrement it as feed drafts are added.
  - Preserve pending transfer feed behavior, but cap all non-energy feed drafts by available total capacity so feed cannot immediately create overflow.
  - Boundary rule: at terminal total exactly 250,000, no native mineral feed and no overflow offload should be generated.
  - Do not add cross-tick cooldown or persistent hysteresis in this task.

  **Must NOT do**:
  - Do not raise terminal cap.
  - Do not disable market or native mineral auto-sell globally.
  - Do not alter energy terminal balancing.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: bounded changes in one runtime file plus one test file.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`, `playwright`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [5, 6] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/resourceControl.ts:667-695` - `createTerminalFeedTask()` currently caps by storage amount, per-resource terminal free capacity, and target stock.
  - Pattern: `src/runtime/resourceControl.ts:880-918` - overflow offload computes projected `overflowTotal` and prevents same-tick conflicting feed via `offloadedResources`.
  - Pattern: `src/runtime/resourceControl.ts:920-946` - pending transfer and native mineral feed drafts are created and board tasks replaced.
  - API/Type: `src/runtime/resourceControl.ts:99` - `TERMINAL_TOTAL_STORAGE_CAP = 250_000` represents the 50k terminal reserve under Screeps 300k capacity.
  - API/Type: `src/runtime/resourceControl.ts:783-798` - `getNativeMineralAutoSellTerminalTarget()` produces up to `marketCfg.maxDealAmount`, commonly 10k.
  - Test: `src/runtime/resourceControl.test.ts` - existing ResourceControl room/storage/terminal mock patterns.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --no-coverage src/runtime/resourceControl.test.ts` passes.
  - [ ] Test case: native X room, storage has 223k X, terminal has 8.9k X, terminal total 249,500; `runResourceControl()` creates at most a 500 X `terminal_feed` step and no X `terminal_offload`.
  - [ ] Test case: native X room, terminal total exactly 250,000; `runResourceControl()` creates no native X `terminal_feed` and no X `terminal_offload`.
  - [ ] Test case: native X room, terminal total 240,000; `runResourceControl()` still creates X `terminal_feed` toward auto-sell staging.
  - [ ] Test case: pending non-energy transfer task from room still creates a feed task when terminal total capacity under cap is available.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Native X staging does not exceed reserved terminal cap
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/resourceControl.test.ts --runInBand` after adding the E4N58-like near-cap test.
    Expected: The near-cap test passes and asserts X feed amount is capped to remaining capacity under 250,000.
    Evidence: .sisyphus/evidence/task-1-terminal-cap-jest.txt

  Scenario: Native X staging still works when terminal has capacity
    Tool: Bash
    Steps: Run the same Jest file with the below-cap test enabled.
    Expected: `resourceControl:terminal_feed:E4N58:X` exists with resource `X` when terminal total is 240,000.
    Evidence: .sisyphus/evidence/task-1-terminal-feed-ok.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): respect terminal reserve for mineral feed` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 2. Bound synthesis reagent supply to actual product deficit

  **What to do**:
  - Add failing tests in `src/runtime/synthesisControl.test.ts` or `src/runtime/synthesisControlStateMachine.test.ts` showing a product deficit of 4 or 106 does not require 500 units of each reagent.
  - Keep `roomResourceAmount()` semantics unchanged: it must continue counting lab contents for synthesis completion.
  - Introduce a small helper in `src/runtime/synthesisControl.ts`, e.g. `roundUpReactionAmount(amount: number): number`, returning `Math.ceil(amount / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT` for positive values.
  - Change `generateSupplyTask()` signature to receive `targetAmount` and `productCurrent` or a precomputed `desiredProductBatch`, not only `batchSize`.
  - Compute desired reagent amount as `min(LAB_MINERAL_CAPACITY, batchSize, roundUpReactionAmount(max(0, targetAmount - roomResourceAmount(room, product))))` with minimum 5 only when product deficit is positive.
  - Preserve cap by configured/default `batchSize`; this avoids turning small hub steps into full-lab fills.
  - Fix partial top-up: if a reagent lab already has some correct reagent, allow transfer amount below 5 when `currentAmount + amount >= desiredLabAmount` and `desiredLabAmount >= LAB_REACTION_AMOUNT`.
  - In `src/runtime/hubPlanner.ts`, update `writeSynthesisConfig()` to include `batchSize: roundUpReactionAmount(nextStep.targetAmount)` capped to the existing default/max limits if importing synthesis constants is inappropriate. If avoiding cross-module constant imports, use local `LAB_REACTION_AMOUNT = 5` equivalent with a comment referencing Screeps lab reaction amount.

  **Must NOT do**:
  - Do not make target completion count only storage+terminal.
  - Do not change `planHubChains()` deficit computation.
  - Do not reduce supply below one 5-unit reaction when product deficit is positive.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: bounded synthesis-control logic and tests.
  - Skills: [] - No special skill needed.
  - Omitted: [`playwright`] - No browser/UI verification.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5, 6] | Blocked By: []

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts:731-787` - `generateSupplyTask()` currently fills reagent labs to `desiredLabAmount = min(3000, max(5, batchSize))`.
  - Pattern: `src/runtime/synthesisControl.ts:789-805` - `chooseActivePlan()` uses `roomResourceAmount()` completion semantics; do not change.
  - Pattern: `src/runtime/synthesisControl.ts:1022-1025` - supply task generation call site.
  - Pattern: `src/runtime/synthesisControl.ts:1090-1102` - completed product sets stage idle and hub `needsPlan`.
  - Pattern: `src/runtime/hubPlanner.ts:420-461` - `writeSynthesisConfig()` writes `product` and `targetAmount`, currently omits `batchSize`.
  - Test: `src/runtime/synthesisControl.test.ts` and `src/runtime/synthesisControlStateMachine.test.ts` - lab and room mocks for synthesis behavior.

  **Acceptance Criteria**:
  - [ ] `npx jest --no-coverage src/runtime/synthesisControl.test.ts src/runtime/synthesisControlStateMachine.test.ts` passes.
  - [ ] Test case: UO target 106, zero current UO, default batch 500 creates reagent supply step amount 110, not 500.
  - [ ] Test case: product deficit 4 creates desired reagent amount 5, not 500.
  - [ ] Test case: reagent lab already has 3 correct reagent and desired amount is 5; supply top-up step amount is 2 and is not skipped.
  - [ ] Test case: product deficit 0 creates no reagent supply task.

  **QA Scenarios**:
  ```
  Scenario: Small UO deficit uses small reagent batch
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/synthesisControl.test.ts src/runtime/synthesisControlStateMachine.test.ts --runInBand`.
    Expected: Tests assert U/O supply for 106 UO is 110 each, not 500 each.
    Evidence: .sisyphus/evidence/task-2-precise-supply.txt

  Scenario: Partial reagent top-up below five is allowed when final amount reaches five
    Tool: Bash
    Steps: Run the same test command with the partial-top-up test enabled.
    Expected: A lab with 3 U receives 2 U for one reaction batch; the step is not skipped by old `amount < LAB_REACTION_AMOUNT` logic.
    Evidence: .sisyphus/evidence/task-2-partial-topup.txt
  ```

  **Commit**: YES | Message: `fix(synthesis): bound reagent supply to product deficit` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/hubPlanner.ts`, `src/runtime/synthesisControl.test.ts`, `src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 3. Add product-lab unload carrier task

  **What to do**:
  - Use `lsp_find_references` on `CarrierTaskType` before editing.
  - Add a new carrier task type named exactly `lab_product_unload` in `src/runtime/carrierTaskBoard.ts`.
  - In `src/runtime/synthesisControl.ts`, add helper `generateProductUnloadTask(room, productLabs, product)` following `generateCleanupTask()` structure but only for labs whose mineral type equals the active product.
  - Product-unload target selection must prefer storage first, then terminal if storage cannot accept; do not reuse `resolveCleanupTargetStructure()` if it prefers terminal.
  - Priority: `180` (below contamination cleanup `200`, above supply `100`, terminal_offload `90`, terminal_feed `80`).
  - Include product-unload task in the same `replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, boardTasks)` array so it is not wiped by synthesis board replacement.
  - Trigger product-unload when `productCurrent >= targetAmount`, product labs hold product, and storage+terminal usable product amount is below targetAmount.
  - If storage and terminal cannot accept product, leave stage stable, expose `lastError = "lab_product_unload_destination_full"`, and do not crash.
  - Update `src/roles/carrier.ts` only if type-specific handling is needed after references review; generic lab withdraw + storage/terminal transfer should be used if already sufficient.

  **Must NOT do**:
  - Do not treat correct product as contamination.
  - Do not unload reagent labs as part of this task.
  - Do not make product-unload target terminal first.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: adds one task type and focused synthesis/carrier handling.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`] - No visual work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5, 6] | Blocked By: []

  **References**:
  - API/Type: `src/runtime/carrierTaskBoard.ts:1` - `CarrierTaskType` union must include `lab_product_unload`.
  - Pattern: `src/runtime/synthesisControl.ts:667-729` - `generateCleanupTask()` builds lab withdrawal steps; copy structure but change semantics/target preference.
  - Pattern: `src/runtime/synthesisControl.ts:1014-1026` - current board task selection between cleanup and supply; product-unload must be merged deliberately.
  - Pattern: `src/roles/carrier.ts:426-461` - carrier task assignment is priority-based and generic.
  - Pattern: `src/roles/carrier.ts:567-698` - delivery flow handles assigned task steps and `terminal_offload` special case.
  - Test: `src/roles/carrier.test.ts` - existing `lab_cleanup`, `terminal_feed`, `terminal_offload` carrier task tests.

  **Acceptance Criteria**:
  - [ ] `npx jest --no-coverage src/runtime/synthesisControl.test.ts src/roles/carrier.test.ts` passes.
  - [ ] Test case: product lab has 110 UO, target 106, storage+terminal UO is 0; a `lab_product_unload` task is generated from lab to storage.
  - [ ] Test case: storage is full, terminal has capacity; product-unload task targets terminal.
  - [ ] Test case: storage and terminal both full; no task is created and runtime lastError is `lab_product_unload_destination_full`.
  - [ ] Test case: multiple product labs, only non-empty labs containing the active product generate unload steps.
  - [ ] Carrier can withdraw `UO` from lab and transfer to storage using `lab_product_unload` without clearing assignment prematurely.

  **QA Scenarios**:
  ```
  Scenario: Completed product lab unloads to storage
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/synthesisControl.test.ts src/roles/carrier.test.ts --runInBand`.
    Expected: Tests find `lab_product_unload` step `{ resource: "UO", fromKind: "lab", toKind: "storage" }` and carrier executes it.
    Evidence: .sisyphus/evidence/task-3-product-unload.txt

  Scenario: Full destinations are reported without crashing
    Tool: Bash
    Steps: Run the same Jest command with full storage/terminal test enabled.
    Expected: Runtime lastError is `lab_product_unload_destination_full`; no exception and no invalid task.
    Evidence: .sisyphus/evidence/task-3-product-unload-full.txt
  ```

  **Commit**: YES | Message: `fix(synthesis): unload completed lab products` | Files: [`src/runtime/carrierTaskBoard.ts`, `src/runtime/synthesisControl.ts`, `src/roles/carrier.ts`, `src/runtime/synthesisControl.test.ts`, `src/roles/carrier.test.ts`]

- [x] 4. Integrate product unload with synthesis state and hub progression

  **What to do**:
  - Add state-machine/integration tests covering the exact E4N58 stall: UO target 106, product lab UO 110, storage+terminal UO 0.
  - Ensure synthesisControl does **not** keep generating reagent supply when product lab already satisfies target.
  - Ensure synthesisControl publishes product-unload task and does not set a new supply task for the same tick.
  - Ensure hub `needsPlan` is not repeatedly toggled without making product available. Decision: when product-unload is pending/needed, keep synthesis runtime in `unloading` or a clearly documented existing stage and only set `needsPlan` after product unload is no longer needed.
  - If reusing `stage: "unloading"`, distinguish `lastError` from contamination: only set `lastError = "lab_contaminated_waiting_clear"` for contamination cleanup; use `cleanupTasks` or a new runtime field only if types already allow it. If adding a field to `global.d.ts`, name it `productUnloadTasks`.
  - After simulated product unload to storage, run hubPlanner and verify it advances from `UO` to the next chain step (`UHO2` or subsequent planned product depending on inventory).

  **Must NOT do**:
  - Do not create an infinite loop where hubPlanner writes UO, synthesisControl idles, and no unload occurs.
  - Do not block contamination cleanup priority; wrong-mineral cleanup remains higher priority than product unload.
  - Do not add a new synthesis stage unless necessary; prefer existing `unloading` with precise runtime metadata.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: cross-module state-machine behavior and hub progression tests.
  - Skills: [] - No special skill needed.
  - Omitted: [`playwright`] - No browser/UI verification.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [5, 6] | Blocked By: [2, 3]

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts:949-1122` - `handleRoom()` stage transitions, task generation, and runtime writeback.
  - Pattern: `src/runtime/synthesisControl.ts:1090-1102` - current completion logic sets idle and hub `needsPlan` immediately.
  - Pattern: `src/runtime/hubPlanner.ts:519-542` - hub inventory counts storage+terminal and plans chain deficits.
  - Pattern: `src/runtime/hubPlanner.ts:556-569` - hub runtime activeProduct and synthesis config write.
  - API/Type: `src/global.d.ts:493-504` - synthesis runtime stage and task metadata typing.
  - Test: `src/runtime/hubPlanner.test.ts` - hub chain and synthesis config expectations.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts` - state transition test patterns.

  **Acceptance Criteria**:
  - [ ] `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts src/runtime/hubPlanner.test.ts src/runtime/synthesisControl.test.ts` passes.
  - [ ] Test case: product lab UO satisfies target, storage+terminal UO does not; synthesisControl generates product-unload and does not immediately re-enter idle loop without unload.
  - [ ] Test case: after product unload into storage, hubPlanner sees UO in inventory and writes the next chain step rather than UO again.
  - [ ] Runtime metadata distinguishes product unload from contamination cleanup.

  **QA Scenarios**:
  ```
  Scenario: E4N58 UO lab-stall regression advances after unload
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts src/runtime/hubPlanner.test.ts --runInBand`.
    Expected: Test simulates UO in product lab, unloads it to storage, then hubPlanner no longer repeats UO for the same deficit.
    Evidence: .sisyphus/evidence/task-4-uO-hub-progression.txt

  Scenario: Product unload does not mask contamination cleanup
    Tool: Bash
    Steps: Run synthesis state-machine tests with a wrong-mineral lab and a completed-product lab case.
    Expected: Wrong-mineral cleanup priority remains 200 and completed-product unload priority remains 180.
    Evidence: .sisyphus/evidence/task-4-cleanup-priority.txt
  ```

  **Commit**: YES | Message: `fix(hub): advance synthesis chains after product unload` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/synthesisControlStateMachine.test.ts`, `src/global.d.ts`]

- [x] 5. Run focused regression cleanup across carrier logistics

  **What to do**:
  - Run focused tests for resource control, synthesis, hubPlanner, and carrier.
  - Fix only regressions directly caused by Tasks 1-4.
  - Pay special attention to existing carrier jitter fixes: stale assignment cleanup must not reappear when `lab_product_unload` tasks are added.
  - Confirm task priorities after all changes: `lab_cleanup` 200 > `lab_product_unload` 180 > `lab_supply` 100 > `terminal_offload` 90 > `terminal_feed` 80.
  - Confirm terminal X no longer oscillates in tests and precise reagent supply does not leave avoidable reagent residue for small deficits.

  **Must NOT do**:
  - Do not broaden into unrelated market, boost, or resource distribution refactors.
  - Do not update snapshots or expected values unless behavior change is explicitly part of this plan.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused regression pass and small fixes only.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`] - No visual changes.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [6] | Blocked By: [1, 2, 3, 4]

  **References**:
  - Test: `src/runtime/resourceControl.test.ts` - terminal feed/offload regression coverage.
  - Test: `src/runtime/synthesisControl.test.ts` - supply/unload task coverage.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts` - stage transition coverage.
  - Test: `src/runtime/hubPlanner.test.ts` - chain planning coverage.
  - Test: `src/roles/carrier.test.ts` - carrier assignment/delivery coverage.

  **Acceptance Criteria**:
  - [ ] `npx jest --no-coverage src/runtime/resourceControl.test.ts src/runtime/synthesisControl.test.ts src/runtime/synthesisControlStateMachine.test.ts src/runtime/hubPlanner.test.ts src/roles/carrier.test.ts` passes.
  - [ ] No test-only behavior branches are added to source.
  - [ ] No generated `dist/` changes are included before build/deploy task.

  **QA Scenarios**:
  ```
  Scenario: Focused logistics regression suite passes
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/resourceControl.test.ts src/runtime/synthesisControl.test.ts src/runtime/synthesisControlStateMachine.test.ts src/runtime/hubPlanner.test.ts src/roles/carrier.test.ts --runInBand`.
    Expected: All focused tests pass with no snapshots requiring manual approval.
    Evidence: .sisyphus/evidence/task-5-focused-regression.txt

  Scenario: Carrier task priorities remain ordered
    Tool: Bash
    Steps: Run carrier and synthesis tests that assert task selection when cleanup, product-unload, supply, offload, and feed are present.
    Expected: Carrier selects highest-priority runnable task in the documented order.
    Evidence: .sisyphus/evidence/task-5-priority-order.txt
  ```

  **Commit**: YES | Message: `test(logistics): cover terminal and lab task regressions` | Files: [`src/runtime/*.test.ts`, `src/roles/carrier.test.ts`]

- [x] 6. Full verification and deploy-prep

  **What to do**:
  - Run full static and test verification.
  - Run build but do not deploy until final verification wave is approved by the user.
  - If full test/build fails, fix only failures caused by this plan.
  - After Final Verification Wave approval and explicit user okay, run `npm run push` per project workflow to deploy to Screeps.

  **Must NOT do**:
  - Do not run `npm run push` before final wave approval and explicit user okay.
  - Do not commit `.secret.json`, `monitor-data/`, or unrelated generated files.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: final integration verification across the project.
  - Skills: [] - No special skill needed.
  - Omitted: [`playwright`] - No browser/UI verification.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1, F2, F3, F4] | Blocked By: [5]

  **References**:
  - Command: `npx tsc --noEmit` - TypeScript static verification.
  - Command: `npm run test` - Full Jest suite.
  - Command: `npm run build` - Rollup build without deploy.
  - Command: `npm run push` - Deployment; only after final wave approval.
  - Workflow: Project memory says deploy to Screeps after successful TypeScript and Jest verification with `npm run push`.

  **Acceptance Criteria**:
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run test` passes.
  - [ ] `npm run build` passes.
  - [ ] `git status --short` shows only planned source/test changes before final commit/deploy.
  - [ ] After final review and user approval, `npm run push` exits successfully.

  **QA Scenarios**:
  ```
  Scenario: Full project verification passes
    Tool: Bash
    Steps: Run `npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-6-full-verification.txt

  Scenario: Deployment is gated until approval
    Tool: Bash
    Steps: Before final approval, run `git status --short` only; after user approval, run `npm run push`.
    Expected: No deploy happens before approval; deploy exits 0 after approval.
    Evidence: .sisyphus/evidence/task-6-deploy.txt
  ```

  **Commit**: YES | Message: `chore(logistics): verify terminal and lab fixes` | Files: [verification evidence only if tracked by project conventions; otherwise source/test commits from prior tasks]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `fix(resource-control): respect terminal reserve for mineral feed` — resourceControl implementation/tests only.
- Commit 2: `fix(synthesis): bound reagent supply to product deficit` — precise reagent supply and hub synthesis config only.
- Commit 3: `fix(synthesis): unload completed lab products` — new product-unload task type, synthesis generation, carrier handling/tests.
- Commit 4: `fix(hub): advance synthesis chains after product unload` — state-machine/hub progression integration.
- Commit 5: `test(logistics): cover terminal and lab task regressions` — focused regression tests if not already included in prior commits.

## Success Criteria
- E4N58-like native X staging cannot create storage↔terminal oscillation at terminal total cap.
- Small UO deficits do not cause 500 U/O reagent fills.
- Completed UO in product lab creates a carrier unload task to storage, making UO visible to hubPlanner.
- Reagent labs naturally empty after precise reaction batches for small deficits except unavoidable partial/edge cases.
- Hub chain advances from UO to UHO2/XUHO2 after product unload.
- Full test/build verification passes and deployment is performed only after final wave approval.

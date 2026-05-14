# E4N58 Lab Unload and Hub Batch Progress

## TL;DR
> **Summary**: Fix E4N58 UO stranded in product labs by generating recovery unload tasks when synthesis runtime has gone idle without active product metadata. Update the hub panel to show active synthesis batch progress/status (lab + storage + terminal over targetAmount) instead of misleading `0/1000 stock`.
> **Deliverables**:
> - Stranded product-lab unload recovery in `src/runtime/synthesisControl.ts`.
> - Focused E4N58 regression tests in `src/runtime/synthesisControlStateMachine.test.ts`.
> - Hub batch-progress data path and visual text in `src/runtime/hubProgress.ts`.
> - Hub progress regression tests in `src/runtime/hubProgress.test.ts`.
> **Effort**: Short
> **Parallel**: YES - 2 waves
> **Critical Path**: Task 1 → Task 3 → Task 4 → Final Verification

## Context
### Original Request
- User reported: `E4N58房间中, carrier还是没有卸载lab`.
- User added: `hub面板也需要优化, 比如现在在合成UO, 应该显示UO的进度和状态`.
- User clarified current panel shows: `0/1000 stock`.

### Interview Summary
- Read-only live inspection was approved.
- Test strategy confirmed: tests-after.
- Hub progress display decision: while an intermediate product is being synthesized/unloaded, show current batch progress and status, e.g. `UO 110/106 unloading`, not stock-target progress.

### Live Evidence
- E4N58 on shard1 has 3 labs:
  - Reagent lab: U=690.
  - Reagent lab: O=690.
  - Product lab: UO=110.
- E4N58 storage/terminal have no UO.
- `Memory.cfg.synthesisControl.rooms.E4N58.reactions[0]` is `{ product: "UO", targetAmount: 106, batchSize: 110 }`.
- `Memory.runtime.synthesisControl.rooms.E4N58` is `stage: "idle"`, `pendingTasks: 0`, no retained `activeProduct` or `targetAmount`.
- Therefore the carrier cannot unload because no `lab_product_unload` carrier task is being generated.

### Metis Review (gaps addressed)
- Confirmed root cause: `chooseActivePlan()` counts lab contents through `roomResourceAmount()`, returns null, then the activePlan-null branch cannot generate unload without retained runtime product metadata.
- Confirmed panel root cause: `hubProgress.ts` reads only storage+terminal for `hubInventory`; labs are invisible to the panel, so active UO in labs displays as `0/1000 stock`.
- Guardrails incorporated: do not change `chooseActivePlan()`, `generateProductUnloadTask()`, `generateCleanupTask()`, `hubPlanner.ts`, reagent cleanup, or main loop ordering.
- Default applied: stranded recovery drains product labs only; reagent labs are left alone because they may be valid next-batch reagents.

## Work Objectives
### Core Objective
Recover stranded product minerals from hub product labs and make hub visual progress reflect active synthesis batch state accurately.

### Deliverables
- `generateStrandedProductUnloadTask()` helper in `src/runtime/synthesisControl.ts`.
- ActivePlan-null recovery path that sets stage to `unloading` and preserves recovered active product when product labs contain minerals.
- Hub progress snapshot fields for synthesis target amount and active-product lab amounts.
- Hub visual model batch-progress text and percent for active synthesis/unloading states.
- Tests proving both fixes and preserving backward-compatible idle/stock display.

### Definition of Done (verifiable conditions with commands)
- `npx jest -- synthesisControlStateMachine` exits 0.
- `npx jest -- hubProgress` exits 0.
- `npm run test` exits 0.
- `npx tsc --noEmit` exits 0.
- After final wave approval and explicit user okay, `npm run push` exits 0 and deploys the verified bundle.

### Must Have
- Product lab with UO=110 and runtime `stage:"idle"` with no active product must generate `lab_product_unload`.
- Recovery unload must bypass the normal `roomTransferableAmount >= targetAmount` skip; product labs must drain even if storage already has target amount.
- Hub panel active synthesis progress must count lab + storage + terminal product amount over synthesis `targetAmount`.
- Active UO display must include product, current/target amount, and current stage/status, and must not say `stock` for active batch progress.

### Must NOT Have
- Do not change `chooseActivePlan()`; its lab-inclusive resource count prevents overproduction.
- Do not change `generateProductUnloadTask()`; its target-met skip remains correct for normal active synthesis.
- Do not clean reagent labs as part of this fix.
- Do not touch `hubPlanner.ts`, `main.ts`, RoomVisual `Panel` layout internals, carrier role behavior, or task-board semantics.
- Do not require manual Screeps console checks for acceptance.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with Jest + TypeScript.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. This plan is intentionally smaller than target because the bugfix is surgical.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (stranded unload logic + tests), Task 2 (hub progress type/data design + tests scaffold) can be worked in parallel with coordination on no shared files except tests are distinct.
Wave 2: Task 3 (hub visual model rendering), Task 4 (integration verification and deployment prep) depends on Tasks 1-2.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 3, 4 |
| 2 | None | 3, 4 |
| 3 | 1, 2 | 4 |
| 4 | 1, 2, 3 | Final Verification |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 2 tasks → `unspecified-high`, `quick`.
- Wave 2 → 2 tasks → `unspecified-high`, `quick`.
- Final Verification → 4 review tasks → oracle/unspecified-high/deep.

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Recover stranded product-lab unload tasks

  **What to do**:
  1. In `src/runtime/synthesisControl.ts`, add a helper near `generateProductUnloadTask()` named `generateStrandedProductUnloadTask(room: Room, productLabs: StructureLab[], roomCfg: SynthesisRoomConfig, autoPlan?: SynthesisReactionPlan | null): { task: CarrierTaskDraft; product: ResourceConstant; targetAmount?: number } | null`.
  2. Helper behavior:
     - Iterate `topology.productLabs` only.
     - For each lab with `lab.mineralType` and `lab.store.getUsedCapacity(lab.mineralType) > 0`, resolve destination via `resolveProductUnloadTargetStructure(room, mineralType)`.
     - Create `CarrierTaskStep` using existing `createCarrierTaskStepId(resource, lab.id, target.id)` and same fields as `generateProductUnloadTask()` (`fromKind:"lab"`, `toKind:"storage"|"terminal"`).
     - Do **not** call `roomTransferableAmount()` and do **not** compare against target amount.
     - If multiple product labs/minerals exist, produce one `CarrierTaskDraft` containing all drainable product-lab steps. `CarrierTaskStep.resource` already carries the per-step resource (`src/runtime/carrierTaskBoard.ts:3-11`), so mixed-resource steps are allowed in a single task.
     - Use the first detected mineral as the returned `product` and in the task id: `createCarrierTaskId("lab_product_unload", room.name, firstDetectedMineral)`.
     - Derive returned `targetAmount` by finding a configured reaction in `roomCfg.reactions` or `autoPlan` whose product matches the first detected mineral; otherwise return `undefined`.
  3. In activePlan-null branch (`src/runtime/synthesisControl.ts:1027-1067`), after existing runtime-product unload attempt and before `replaceCarrierTasksForProducerRoom()`, call `generateStrandedProductUnloadTask(room, topology.productLabs, roomCfg, autoPlan)` when `productUnloadTask` is null.
  4. When stranded task exists:
     - Write it to carrier task board through existing `replaceCarrierTasksForProducerRoom()` call.
     - Set room runtime `stage` to `"unloading"`.
     - Set `activeProduct` to the helper's returned `product`.
     - Set `targetAmount` to the helper's returned `targetAmount` when available; for unknown minerals leave `targetAmount` undefined.
     - Do not set `Memory.runtime.hub.needsPlan` for idle→unloading recovery.
  5. Add regression tests in `src/runtime/synthesisControlStateMachine.test.ts` inside `describe("E4N58 stall regression", ...)`.

  **Must NOT do**:
  - Do not modify `chooseActivePlan()` at `src/runtime/synthesisControl.ts:867-883`.
  - Do not modify `roomResourceAmount()` at `src/runtime/synthesisControl.ts:362-382`.
  - Do not modify normal `generateProductUnloadTask()` semantics at `src/runtime/synthesisControl.ts:745-796`.
  - Do not clean reagent labs.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: behavior-sensitive state-machine bugfix with test coverage.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`] - No UI work in this task.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [3, 4] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - API/Type: `src/runtime/carrierTaskBoard.ts:3-29` - Carrier tasks allow per-step resources; use one stranded unload task with multiple steps if multiple product labs contain minerals.
  - Pattern: `src/runtime/synthesisControl.ts:735-796` - Normal product unload task shape, destination resolution, task id/step construction.
  - Pattern: `src/runtime/synthesisControl.ts:1027-1067` - ActivePlan-null branch that currently clears tasks when runtime product metadata is missing.
  - API/Type: `src/runtime/synthesisControl.ts:362-392` - Lab-inclusive total vs storage+terminal transferable total; this distinction is the root cause.
  - Test: `src/runtime/synthesisControlStateMachine.test.ts:997-1167` - Existing E4N58 stall regression structure to extend.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Test added: idle runtime with no activeProduct, product lab UO=110, targetAmount=106 generates `lab_product_unload`, `stage === "unloading"`, step resource UO, `fromKind === "lab"`, `toKind === "storage"`, amount 110.
  - [ ] Test added: empty product labs with idle/no-activeProduct generates no carrier task and remains idle.
  - [ ] Test added: storage already has UO above target and product lab still has UO; stranded unload still generates.
  - [ ] Test added or existing test confirmed: normal active-plan path still produces supply/product-unload behavior without invoking stranded recovery.
  - [ ] `npx jest -- synthesisControlStateMachine` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Stranded E4N58 UO lab recovers unload task
    Tool: Bash
    Steps: Run `npx jest -- synthesisControlStateMachine --testNamePattern="stranded|E4N58"` after adding the regression tests.
    Expected: Exit code 0; output includes passing stranded product unload test; no failing E4N58 stall regression tests.
    Evidence: .sisyphus/evidence/task-1-stranded-unload-jest.txt

  Scenario: Empty product labs do not create false unload
    Tool: Bash
    Steps: Run `npx jest -- synthesisControlStateMachine --testNamePattern="empty product labs|stranded"`.
    Expected: Exit code 0; no carrier task is generated in the empty-lab regression.
    Evidence: .sisyphus/evidence/task-1-empty-labs-jest.txt
  ```

  **Commit**: YES | Message: `fix(synthesis): recover stranded product lab unloads` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 2. Add hub progress batch data path

  **What to do**:
  1. In `src/runtime/hubProgress.ts`, extend types at `HubProgressInput` and `HubProgressSnapshot` (`src/runtime/hubProgress.ts:6-79`) to carry:
     - `synthesisRuntime.targetAmount?: number`.
     - Active product lab amounts, e.g. `hubLabInventory: Record<string, number>` or `activeProductLabAmount: number`. Prefer `hubLabInventory` because tests can cover unknown/active resources without special cases.
  2. Extend `collectHubProgressSnapshot()` (`src/runtime/hubProgress.ts:467-492`) to read hub-room labs using `room.find(FIND_MY_STRUCTURES, { filter: structure.structureType === STRUCTURE_LAB })` when the hub room is visible.
  3. Sum lab store contents into the new lab inventory field. Include only resources with amount > 0. Do not include energy in batch progress unless activeProduct is energy (not expected for synthesis).
  4. Extend `buildHubProgressSnapshot()` (`src/runtime/hubProgress.ts:387-464`) to preserve `targetAmount` from synthesis runtime and pass lab inventory through to the snapshot.
  5. Keep `buildCompactInventory()` (`src/runtime/hubProgress.ts:268-310`) storage+terminal only. Do not add labs to the compact inventory/sidebar.
  6. Add snapshot tests in `src/runtime/hubProgress.test.ts` proving lab inventory and targetAmount are captured.

  **Must NOT do**:
  - Do not change `Panel` or visual layout engine.
  - Do not change hubPlanner runtime writes.
  - Do not add labs into `buildCompactInventory()`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: typed data-threading change with direct tests.
  - Skills: [] - No special skill needed.
  - Omitted: [`frontend-ui-ux`] - This task is data plumbing, not visual design.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [3, 4] | Blocked By: []

  **References**:
  - API/Type: `src/runtime/hubProgress.ts:6-79` - Input/snapshot interfaces to extend.
  - Pattern: `src/runtime/hubProgress.ts:387-464` - Existing snapshot field threading.
  - Pattern: `src/runtime/hubProgress.ts:467-492` - Existing live store collection from hub room.
  - Test: `src/runtime/hubProgress.test.ts:40-120` - Existing snapshot test style.

  **Acceptance Criteria**:
  - [ ] `HubProgressInput.synthesisRuntime` accepts `targetAmount` without TypeScript errors.
  - [ ] `HubProgressSnapshot` includes lab inventory and synthesis target amount (naming may differ, but both facts must be present).
  - [ ] Snapshot test proves product-only-in-lab UO=110 is captured while `hubInventory.UO` remains storage+terminal only.
  - [ ] `npx jest -- hubProgress --testNamePattern="snapshot|lab"` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Snapshot captures lab-held UO separately from compact inventory
    Tool: Bash
    Steps: Run `npx jest -- hubProgress --testNamePattern="lab inventory|snapshot"`.
    Expected: Exit code 0; test confirms lab UO is available for progress and compact inventory remains storage+terminal scoped.
    Evidence: .sisyphus/evidence/task-2-hub-snapshot-jest.txt

  Scenario: Type threading remains sound
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: Exit code 0; no interface or call-site type errors.
    Evidence: .sisyphus/evidence/task-2-tsc.txt
  ```

  **Commit**: YES | Message: `feat(hub): capture lab inventory for progress` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 3. Render active synthesis batch progress in hub panel

  **What to do**:
  1. In `buildHubVisualModel()` (`src/runtime/hubProgress.ts:155-203`), detect active batch mode when `snapshot.activeProduct` exists and snapshot has a finite positive synthesis target amount.
  2. For active batch mode:
     - `currentAmount = (snapshot.hubInventory[activeProduct] || 0) + (snapshot.hubLabInventory[activeProduct] || 0)`.
     - `target = snapshot.synthesisTargetAmount`.
     - `progressPercent = Math.min(currentAmount / target, 1)`.
     - `progressText` must include product, current amount, target amount, and stage/status. Required examples: `UO 110/106 synthesizing` or `UO 110/106 unloading`.
     - `progressText` must not include `stock` in active batch mode.
  3. Keep backward compatibility when no active synthesis target exists:
     - Existing behavior remains `inventory/1000 stock` using `HUB_PROGRESS_TARGET`.
     - Existing idle behavior remains `0% idle`.
  4. Update draw tests that currently expect `500/1000 stock` only where test data represents active synthesis. Keep at least one test proving fallback stock display is unchanged.
  5. Add tests for active UO synthesizing and unloading stages in `src/runtime/hubProgress.test.ts`.

  **Must NOT do**:
  - Do not change `drawHubVisualPanel()` layout except through model text/percent.
  - Do not remove logistics section, status row, stage row, or inbound rows.
  - Do not rename console helpers.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: user-visible behavior with compatibility tests.
  - Skills: [] - No special skill needed; existing visual tests cover layout.
  - Omitted: [`frontend-ui-ux`] - No new visual design, just data-correct text.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [4] | Blocked By: [1, 2]

  **References**:
  - Pattern: `src/runtime/hubProgress.ts:155-203` - Existing visual model progress calculation/text.
  - Pattern: `src/runtime/hubProgress.ts:215-256` - Panel draws model fields; avoid layout changes.
  - Test: `src/runtime/hubProgress.test.ts:507-515` - Current active production model test to adjust.
  - Test: `src/runtime/hubProgress.test.ts:623-639` - Progress bar rendering test; update only text expectations as needed.

  **Acceptance Criteria**:
  - [ ] Active UO test with lab UO=110, storage/terminal UO=0, target=106 produces `progressPercent === 1` and text containing `UO`, `110`, `106`, and current stage/status.
  - [ ] Active UO progress text does not contain `1000` or `stock`.
  - [ ] Unloading test with lab UO=50 and storage/terminal UO=60 shows total 110/106 and includes `unloading`.
  - [ ] Fallback test with no active synthesis target still shows `500/1000 stock` for stock display.
  - [ ] `npx jest -- hubProgress` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Active UO batch progress replaces stock text
    Tool: Bash
    Steps: Run `npx jest -- hubProgress --testNamePattern="UO|batch progress|active synthesis"`.
    Expected: Exit code 0; assertions show `UO 110/106` style text and no `stock`/`1000` in active batch mode.
    Evidence: .sisyphus/evidence/task-3-hub-batch-progress-jest.txt

  Scenario: Backward-compatible stock display remains for non-active synthesis
    Tool: Bash
    Steps: Run `npx jest -- hubProgress --testNamePattern="stock display|500/1000"`.
    Expected: Exit code 0; fallback test still passes with `500/1000 stock`.
    Evidence: .sisyphus/evidence/task-3-stock-fallback-jest.txt
  ```

  **Commit**: YES | Message: `fix(hub): show active synthesis batch progress` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubProgress.test.ts`]

- [x] 4. Verify integrated synthesis + hub behavior and deploy

  **What to do**:
  1. Run targeted suites:
     - `npx jest -- synthesisControlStateMachine`
     - `npx jest -- hubProgress`
     - `npx jest -- hubProductionIntegration synthesisControl hubPlanner`
  2. Run full verification:
     - `npm run test`
     - `npx tsc --noEmit`
  3. If all review agents approve in Final Verification and user explicitly says okay, run deployment command:
     - `npm run push`
  4. Capture command outputs into `.sisyphus/evidence/` files.
  5. Do not use live mutation commands or Screeps console writes.

  **Must NOT do**:
  - Do not deploy before final verification wave approval and explicit user okay.
  - Do not require manual game-client visual confirmation.
  - Do not edit `.secret.json` or commit generated `dist/` unless repository conventions explicitly require it after `npm run push`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: verification/deploy workflow with fixed commands.
  - Skills: [] - No special skill needed.
  - Omitted: [`git-master`] - Not needed unless committing; if committing, follow repository commit rules.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [Final Verification] | Blocked By: [1, 2, 3]

  **References**:
  - Command: `package.json:6-14` - `build`, `push`, `test`, and coverage scripts.
  - Workflow rule: deployment uses `npm run push` after TypeScript and Jest verification.
  - Test: `src/runtime/hubProductionIntegration.test.ts` - Integration between hub planner, synthesis control, and status/progress.

  **Acceptance Criteria**:
  - [ ] `npx jest -- synthesisControlStateMachine` exits 0.
  - [ ] `npx jest -- hubProgress` exits 0.
  - [ ] `npx jest -- hubProductionIntegration synthesisControl hubPlanner` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] After final approval only, `npm run push` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Full automated regression suite passes
    Tool: Bash
    Steps: Run `npm run test`.
    Expected: Exit code 0; no failed Jest suites.
    Evidence: .sisyphus/evidence/task-4-full-jest.txt

  Scenario: TypeScript and deploy pipeline pass
    Tool: Bash
    Steps: Run `npx tsc --noEmit`; after final wave approval and explicit user okay, run `npm run push`.
    Expected: Both commands exit 0; deployment output shows successful Rollup/Screeps upload.
    Evidence: .sisyphus/evidence/task-4-tsc-and-push.txt
  ```

  **Commit**: YES | Message: `test(hub): verify lab unload progress recovery` | Files: [no source files unless verification fixes are needed]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ Playwright not required; use Jest/Bash evidence and optional read-only Screeps API after deploy)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit after Task 1 as `fix(synthesis): recover stranded product lab unloads`.
- Commit after Tasks 2-3 together or separately depending on file state; preferred commit after Task 3: `fix(hub): show active synthesis batch progress`.
- Commit verification/test-only adjustments only if files changed: `test(hub): verify lab unload progress recovery`.
- Do not commit `.secret.json`, generated evidence files unless explicitly requested, or unrelated workspace changes.

## Success Criteria
- E4N58 product lab UO no longer strands when runtime activeProduct metadata is missing.
- Carrier task board receives `lab_product_unload` for stranded product labs.
- Hub panel active UO synthesis displays batch progress/status using 106 target and lab-inclusive current amount.
- Existing stock display remains available for non-active synthesis contexts.
- All targeted and full verification commands pass, and deployment is performed only after final wave approval.

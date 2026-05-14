# Count Lab Products in Hub Planning Inventory

## TL;DR
> **Summary**: Align hubPlanner inventory with synthesisControl inventory so lab-held intermediates/products count toward hub production planning. This fixes the E4N58 loop where hub sees `UO:5` while synthesisControl sees `UO:65` in labs and idles.
> **Deliverables**:
> - Hub planning inventory includes storage, terminal, and lab/factory/power-spawn mineral stores, excluding energy.
> - Regression tests prove lab-held `UO` advances planning to the next chain step instead of re-planning `UO`.
> - TypeScript, Jest, build, and deployment verification are run.
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Final Verification Wave → deploy after explicit approval

## Context
### Original Request
- User asked to inspect shard1 `E4N58` synthesis logic.
- Live diagnosis found hub planning wanted `UO`, while synthesisControl was idle because reagent lab inventory already satisfied `UO` target.
- User clarified: `应该吧lab中的产物也计入库存` — lab products should count as inventory.

### Interview Summary
- Confirmed live state on shard1/E4N58:
  - `Memory.runtime.hub.activeProduct = "UO"`, `status = "importing"`.
  - `Memory.cfg.synthesisControl.rooms.E4N58.reactions[0] = { product: "UO", targetAmount: 56, batchSize: 60 }`.
  - Reagent lab `69fc4434c4df66da6077350a` held `UO:65`; product lab was empty; storage+terminal held `UO:5`.
  - `Memory.analytics.hub.hubInventory.UO = 5`; `Memory.analytics.hub.hubLabInventory.UO = 65`.
- Decision: count lab-held resources in hub planning inventory, not by mutating live Memory or changing carrier behavior.

### Metis Review (gaps addressed)
- Metis identified this as a minimal planning inventory mismatch, not a carrier execution issue.
- Guardrail from Metis: avoid cross-module behavior changes; keep the fix local to `hubPlanner.ts` unless tests require a helper adjustment.
- Metis noted `synthesisControl.ts` already signals hub replanning after target completion, so planner/synthesis inventory semantics must agree to avoid loops.

## Work Objectives
### Core Objective
Make hubPlanner count lab-held products/intermediates as inventory when planning hub synthesis chains, matching the inventory semantics already used by synthesisControl completion checks.

### Deliverables
- A small inventory-builder change in `src/runtime/hubPlanner.ts`.
- Regression coverage in `src/runtime/hubPlanner.test.ts`.
- No changes to carrier task behavior, lab cleanup policy, or live Memory.

### Definition of Done (verifiable conditions with commands)
- `npx tsc --noEmit` exits 0.
- `npm run test -- hubPlanner.test.ts` exits 0.
- `npm run test` exits 0.
- `npm run build` exits 0.
- After final review approval, `npm run push` exits 0 and deploys `dist/main.js`.

### Must Have
- Hub planning inventory includes positive non-energy contents from:
  - `room.storage.store`
  - `room.terminal.store`
  - every owned `STRUCTURE_LAB`
  - every owned `STRUCTURE_FACTORY`
  - every owned `STRUCTURE_POWER_SPAWN`
- Existing `planHubChains()` signature remains unchanged.
- Existing `writeSynthesisConfig()` behavior remains unchanged except receiving corrected inventory.
- Regression test reproduces the E4N58 class of bug: storage+terminal lacks enough `UO`, lab has enough `UO`, and planner must not choose `UO` as the next active product.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Must not edit `Memory` or run mutating Screeps console commands.
- Must not change `src/roles/carrier.ts`.
- Must not change lab cleanup behavior in `src/runtime/synthesisControl.ts`.
- Must not make hubProgress `hubInventory` ambiguous unless the display tests are intentionally updated; display can keep `hubInventory` and `hubLabInventory` separate.
- Must not count `RESOURCE_ENERGY` in hub synthesis inventory.
- Must not introduce global exports or console commands.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with Jest because existing hubPlanner tests cover the planning entry point.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (implementation + focused regression)
Wave 2: Task 2 (verification + deployment readiness)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 2 |
| 2 | 1 | Final Verification Wave |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 1 | quick |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Include lab-held resources in hub planning inventory

  **What to do**:
  1. In `src/runtime/hubPlanner.ts`, replace the inline inventory construction at lines 520-532 with a small local helper or equivalent local logic that accumulates positive non-energy resource amounts.
  2. The helper must add resources from `room.storage.store` and `room.terminal.store` exactly as the current code does.
  3. Extend the helper to scan `room.find(FIND_MY_STRUCTURES, { filter })` for structures whose `structureType` is `STRUCTURE_LAB`, `STRUCTURE_FACTORY`, or `STRUCTURE_POWER_SPAWN` and add each structure's positive non-energy store entries.
  4. Keep `planHubChains(hubInventory, incomingResources, cfg.reservePerRoom || 1000)` at `src/runtime/hubPlanner.ts:543` unchanged; only feed it corrected `hubInventory`.
  5. Add/adjust `src/runtime/hubPlanner.test.ts` fixture `setupHubRoomForSynthesis()` at lines 957-1023 so it can create lab mocks with `store.getUsedCapacity()` and enumerable mineral entries.
  6. Add a regression test under `describe("writeSynthesisConfig")` proving that when target is `RESOURCE_CATALYZED_UTRIUM_ALKALIDE`, storage/terminal have no `RESOURCE_UTRIUM_OXIDE`, but a hub lab has `RESOURCE_UTRIUM_OXIDE: 1000` and storage has required `RESOURCE_HYDROXIDE: 1000`, `runHubPlanner()` chooses `RESOURCE_UTRIUM_ALKALIDE` as the active product rather than `RESOURCE_UTRIUM_OXIDE`.
  7. Exact regression test setup:
     - `Memory.cfg.hub.targetCompounds = [RESOURCE_CATALYZED_UTRIUM_ALKALIDE]`.
     - Storage resources include `RESOURCE_HYDROGEN: 10000`, `RESOURCE_OXYGEN: 10000`, `RESOURCE_UTRIUM: 10000`, `RESOURCE_CATALYST: 10000`, and `RESOURCE_HYDROXIDE: 1000`.
     - Terminal resources can stay empty except energy.
     - One lab mock has `[RESOURCE_UTRIUM_OXIDE]: 1000`; no storage/terminal `RESOURCE_UTRIUM_OXIDE`.
     - Expected assertions: `Memory.runtime.hub.activeProduct === RESOURCE_UTRIUM_ALKALIDE`, `Memory.cfg.synthesisControl!.rooms![HUB_ROOM].reactions![0].product === RESOURCE_UTRIUM_ALKALIDE`, and no active reaction for `RESOURCE_UTRIUM_OXIDE`.

  **Must NOT do**:
  - Do not edit `src/runtime/synthesisControl.ts`; `roomResourceAmount()` already counts labs at lines 362-381.
  - Do not change `planHubChains()` behavior at lines 144-178.
  - Do not alter hub distribution/export rules.
  - Do not include energy in `hubInventory`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused single-module fix plus nearby regression test.
  - Skills: [] - no special skill needed.
  - Omitted: [`frontend-ui-ux`, `playwright`] - not a UI/browser task.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/hubPlanner.ts:520-532` - current hub inventory only counts storage+terminal; extend this logic.
  - Pattern: `src/runtime/synthesisControl.ts:362-381` - target inventory semantics already count labs/factory/power spawn; hub planning should align with this.
  - Pattern: `src/runtime/hubPlanner.ts:144-178` - chain planner consumes `hubInventory`; signature should not change.
  - Pattern: `src/runtime/hubPlanner.ts:420-463` - synthesis config writer should remain behaviorally unchanged.
  - Pattern: `src/runtime/hubPlanner.test.ts:957-1023` - hub room fixture currently creates labs; extend here for lab stores.
  - Evidence: live shard1/E4N58 had lab `UO:65`, storage+terminal `UO:5`, hub `activeProduct: "UO"`, synthesis `stage: "idle"`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- hubPlanner.test.ts` exits 0.
  - [ ] New regression fails on the pre-fix behavior because planner selects `RESOURCE_UTRIUM_OXIDE`, and passes after the fix by selecting `RESOURCE_UTRIUM_ALKALIDE`.
  - [ ] No diff in `src/roles/carrier.ts` or `src/runtime/synthesisControl.ts`.
  - [ ] Hub inventory helper ignores `RESOURCE_ENERGY` entries from all stores.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Lab-held intermediate advances hub chain
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner.test.ts`.
    Expected: The new test passes and asserts `Memory.runtime.hub.activeProduct` is `RESOURCE_UTRIUM_ALKALIDE` when UO exists only in a lab.
    Evidence: .sisyphus/evidence/task-1-lab-inventory-test.txt

  Scenario: Energy is not counted as synthesis inventory
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner.test.ts` with a test fixture lab containing `RESOURCE_ENERGY` plus UO.
    Expected: Assertions prove energy does not appear in `hubInventory`-driven decisions; no plan step uses energy as a reagent/product inventory item.
    Evidence: .sisyphus/evidence/task-1-energy-exclusion-test.txt
  ```

  **Commit**: YES | Message: `fix(hub): count lab products in planning inventory` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 2. Verify full project and prepare deployment

  **What to do**:
  1. Run focused and full verification commands in this order:
     - `npm run test -- hubPlanner.test.ts`
     - `npx tsc --noEmit`
     - `npm run test`
     - `npm run build`
  2. Save concise command output summaries to `.sisyphus/evidence/`.
  3. Inspect git diff to confirm only intended files changed before final verification.
  4. Do not deploy until the final verification wave has passed and the user gives explicit approval.
  5. After explicit approval, run `npm run push` per project deployment workflow.

  **Must NOT do**:
  - Do not run `npm run push` before final wave approval.
  - Do not commit generated `dist/` output unless project hooks or user explicitly require it.
  - Do not include `.secret.json` or evidence files in the implementation commit unless the repository convention explicitly tracks evidence.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: command verification and deployment readiness.
  - Skills: [] - no special skill needed.
  - Omitted: [`git-master`] - only use if the executor is explicitly committing via git operations.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [Final Verification Wave] | Blocked By: [1]

  **References** (executor has NO interview context - be exhaustive):
  - Command list: `AGENTS.md` project commands include `npm run build`, `npx tsc --noEmit`, `npm run test`, `npm run push`.
  - Workflow: project memory says Screeps deployment uses `npm run push` after successful TypeScript and Jest verification.
  - Guardrail: `.secret.json` contains deploy credentials and must never be committed.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- hubPlanner.test.ts` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] `git diff --name-only` contains only intended source/test files before commit.
  - [ ] After user approval, `npm run push` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Full local verification succeeds
    Tool: Bash
    Steps: Run `npm run test -- hubPlanner.test.ts && npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-2-full-verification.txt

  Scenario: Deployment command is gated by approval
    Tool: Bash
    Steps: Before explicit user approval, inspect execution log and verify `npm run push` has not been run; after approval, run `npm run push`.
    Expected: No pre-approval deployment; post-approval deployment exits 0.
    Evidence: .sisyphus/evidence/task-2-deploy-gate.txt
  ```

  **Commit**: YES | Message: `test(hub): cover lab-held synthesis inventory` | Files: [`src/runtime/hubPlanner.test.ts`] if tests are committed separately; otherwise combine with Task 1 commit as `fix(hub): count lab products in planning inventory`.

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Preferred single commit because implementation and regression test are tightly coupled: `fix(hub): count lab products in planning inventory`.
- If hooks or review require split commits:
  1. `fix(hub): count lab products in planning inventory` for `src/runtime/hubPlanner.ts`.
  2. `test(hub): cover lab-held synthesis inventory` for `src/runtime/hubPlanner.test.ts`.

## Success Criteria
- Hub planner and synthesisControl agree that lab-held `UO` counts toward hub production inventory.
- E4N58-style state no longer repeatedly plans `UO` when sufficient `UO` is already in a lab.
- Carrier behavior and lab cleanup behavior remain unchanged.
- All verification commands pass before deployment.

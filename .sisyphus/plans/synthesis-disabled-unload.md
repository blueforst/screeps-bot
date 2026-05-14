# Synthesis Disabled Lab Cargo Unload Fix

## TL;DR
> **Summary**: Fix `synthesisControl` so rooms disabled by empty `reactions` still unload stranded lab product/reagent cargo before blocking. This targets the live E4N58 case where `XUHO2` remains in a product lab after hub planning clears reactions.
> **Deliverables**:
> - Disabled-room cleanup path in `src/runtime/synthesisControl.ts`
> - Regression tests in `src/runtime/synthesisControlStateMachine.test.ts`
> - TypeScript/Jest verification evidence
> **Effort**: Short
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4

## Context
### Original Request
- User asked: `修复问题` after live inspection showed E4N58 carrier not unloading lab cargo.

### Interview Summary
- Live inspection found E4N58 is on `shard1`, not `shard2`.
- E4N58 product lab `69fc5a05e78d662d050ad585` contains `XUHO2: 110`.
- E4N58 carrier `carrier-70905906` has empty store and no unload task.
- `Memory.cfg.synthesisControl.rooms.E4N58.reactions = []`.
- `Memory.runtime.synthesisControl.rooms.E4N58.stage = "blocked"`, `lastError = "room_config_disabled"`, `pendingTasks = 0`.

### Metis Review (gaps addressed)
- Preserve `normalizeRoomConfig()` semantics: empty reactions still normalize to disabled.
- Do not change carrier task board, carrier movement, hub planner, or task replacement semantics.
- Disabled rooms with residual lab cargo should use existing stage `"unloading"`; do not add a new stage.
- Do not signal `Memory.runtime.hub.needsPlan` from disabled-room cleanup.
- Cover edge cases: product cargo, reagent residue, empty labs, no visible room/terminal, no topology, product-priority-over-reagent, cleanup-complete transition.

## Work Objectives
### Core Objective
When a synthesis room is disabled because `reactions=[]` or explicit config disables it, still inspect visible labs and generate carrier cleanup tasks for stranded product/reagent cargo before setting the room back to blocked.

### Deliverables
- Production fix in `src/runtime/synthesisControl.ts` scoped to `handleRoom()` disabled-room branch.
- Regression test block in `src/runtime/synthesisControlStateMachine.test.ts` named `disabled room lab cargo cleanup`.
- Verification evidence under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- New tests prove disabled rooms generate `lab_product_unload` / `lab_cleanup` tasks when lab cargo exists and block normally when no cleanup is possible.
- Final review agents F1-F4 approve, user explicitly approves final results, then deployment is performed with `npm run push` per project workflow.

### Must Have
- Use existing `generateStrandedProductUnloadTask()` before `generateReagentCleanupTask()`.
- Product unload takes priority over reagent cleanup.
- Keep `lastError: "room_config_disabled"` in disabled cleanup state for diagnostics.
- If cleanup task exists, set stage to `"unloading"`; otherwise stage stays/returns `"blocked"`.
- Preserve `pendingTasks: countPendingToRoom(roomName)` in runtime state.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not change `normalizeRoomConfig()` behavior at `src/runtime/synthesisControl.ts:196-235`.
- Do not change `replaceCarrierTasksForProducerRoom()` or `src/runtime/carrierTaskBoard.ts`.
- Do not change `src/roles/carrier.ts` movement/delivery logic.
- Do not change `src/runtime/hubPlanner.ts`, `resourceControl`, market, or terminal routing.
- Do not add a new synthesis stage.
- Do not write or mutate live Screeps `Memory` as part of the fix.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with existing Jest/ts-jest framework, plus targeted regression tests.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy
### Parallel Execution Waves
> Target: sequential because the production change and regression tests touch the same state-machine code path.

Wave 1: Task 1 (`quick`) — implement primary disabled product/reagent cleanup with tests.
Wave 2: Task 2 (`quick`) — harden disabled fallback/edge behavior with tests.
Wave 3: Task 3 (`quick`) — preserve enabled-room behavior and complete state-machine verification.
Wave 4: Task 4 (`unspecified-low`) — full verification and evidence.

### Dependency Matrix (full, all tasks)
| Task | Blocks | Blocked By |
|------|--------|------------|
| 1 | 2, 3 | none |
| 2 | 3, 4 | 1 |
| 3 | 4 | 2 |
| 4 | Final Verification | 3 |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Tasks | Categories |
|------|-------|------------|
| 1 | 1 | quick |
| 2 | 1 | quick |
| 3 | 1 | quick |
| 4 | 1 | unspecified-low |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Implement primary disabled-room lab cargo cleanup with regression tests

  **What to do**:
  - Open `src/runtime/synthesisControl.ts` and `src/runtime/synthesisControlStateMachine.test.ts`.
  - Modify only the disabled branch at `handleRoom()` lines `1101-1111`.
  - Keep `if (!roomCfg.enabled)` early in the function; do not move it below enabled-room logic.
  - Inside the disabled branch, implement the primary cleanup decision tree:
    1. Read `const room = Game.rooms[roomName]`.
    2. If room is unavailable or lacks owned controller/terminal, keep blocked behavior; full edge assertions are completed in Task 2.
    3. Resolve `const topology = resolveLabTopology(room, roomCfg)`.
    4. If topology exists, attempt product cleanup first using `generateStrandedProductUnloadTask(room, topology.productLabs, roomCfg, undefined)`.
    5. If no product task, attempt reagent cleanup using `generateReagentCleanupTask(room, [...topology.reagentLabs, ...topology.productLabs])`.
    6. Replace room synthesis carrier tasks with `[productTask]`, `[reagentCleanupTask]`, or `[]`.
    7. Write runtime room state with `stage: taskExists ? "unloading" : "blocked"`, `lastError: "room_config_disabled"`, `pendingTasks: countPendingToRoom(roomName)`, and topology ids when available.
  - Add a new `describe("disabled room lab cargo cleanup", () => { ... })` near the existing stranded recovery / reagent cleanup describe blocks.
  - Reuse existing helpers in that file: `createLab`, `createSynthesisRoom`, `setConfig`, `setRoomStage`.
  - Add two initial tests:
    1. `disabled room with product lab cargo generates lab_product_unload before blocking`
       - Configure `setConfig({ reactions: [] })` so normalization disables the room.
       - Create two reagent labs and one product lab; product lab contains `RESOURCE_CATALYZED_UTRIUM_ALKALIDE` (`XUHO2`) amount `110`.
       - Create room with storage and terminal available; storage has `XUHO2: 0`.
       - Set previous runtime room state with `activeProduct: RESOURCE_CATALYZED_UTRIUM_ALKALIDE`, `targetAmount: 1000` if required by current helpers.
       - Run `runSynthesisControl()`.
       - Assert carrier task list for room has one `lab_product_unload` task with one step: resource `XUHO2`, amount `110`, from product lab id, to storage or terminal.
       - Assert runtime stage is `"unloading"`, `lastError` is `"room_config_disabled"`, and `pendingTasks` reflects carrier task count.
    2. `disabled room with reagent residue generates lab_cleanup when no product unload exists`
       - Configure reactions empty.
       - Reagent labs contain `RESOURCE_UTRIUM: 45` and `RESOURCE_OXYGEN: 735`; product lab empty.
       - Run `runSynthesisControl()`.
       - Assert exactly one `lab_cleanup` task, priority `190`, two steps for U and O, and stage `"unloading"` with `lastError: "room_config_disabled"`.
  - Run the targeted test command and save passing output to `.sisyphus/evidence/task-1-disabled-cleanup-primary.txt`.

  **Must NOT do**:
  - Do not change `normalizeRoomConfig()` at `src/runtime/synthesisControl.ts:196-235`.
  - Do not write `Memory.runtime.hub.needsPlan` in this branch.
  - Do not modify `src/runtime/carrierTaskBoard.ts`, `src/roles/carrier.ts`, `src/runtime/hubPlanner.ts`, `src/runtime/resourceControl.ts`, or market code.
  - Do not weaken or delete existing tests.

  **Recommended Agent Profile**:
  - Category: `quick` - One production branch plus focused regression coverage.
  - Skills: `[]` - Existing Jest patterns are already in repo.
  - Omitted: `playwright` - No browser/UI behavior.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2, 3 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Bug path: `src/runtime/synthesisControl.ts:1101-1111` - disabled branch currently clears tasks and returns.
  - Healthy cleanup path: `src/runtime/synthesisControl.ts:1141-1166` - no-activePlan branch calls product unload, stranded product unload, then reagent cleanup.
  - Topology: `src/runtime/synthesisControl.ts:523-577` - `resolveLabTopology()` works independently of enabled flag.
  - Stranded product: `src/runtime/synthesisControl.ts:814-872` - scans product labs for residual minerals.
  - Reagent cleanup: `src/runtime/synthesisControl.ts:874-908` - scans labs for residue, priority `190`.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts:1329` - stranded recovery tests for product lab cargo.
  - Pattern: `src/runtime/synthesisControlStateMachine.test.ts:1725` - reagent cleanup tests and priority patterns.
  - API/Type: `src/runtime/synthesisControl.ts:651` - task ids use `synthesis:lab_product_unload:<room>:<product>` style.
  - Test infra: `jest.config.cjs` - Jest config; `test/setup.ts` resets Screeps mocks.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "disabled room lab cargo cleanup"` passes and output is saved to `.sisyphus/evidence/task-1-disabled-cleanup-primary.txt`.
  - [ ] New test block exists and uses concrete resources `XUHO2`, `U`, `O` with amounts `110`, `45`, `735`.
  - [ ] Diff touches only `src/runtime/synthesisControl.ts` and `src/runtime/synthesisControlStateMachine.test.ts`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Product cargo regression test exists
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "disabled room with product lab cargo"` and redirect output to `.sisyphus/evidence/task-1-product-regression.txt`.
    Expected: Test passes; generated task type is `lab_product_unload`, resource is `XUHO2`, amount is `110`, runtime stage is `unloading`.
    Evidence: .sisyphus/evidence/task-1-product-regression.txt

  Scenario: Reagent residue regression test exists
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "disabled room with reagent residue"` and redirect output to `.sisyphus/evidence/task-1-reagent-regression.txt`.
    Expected: Test passes; generated task type is `lab_cleanup`, priority is `190`, runtime stage is `unloading`.
    Evidence: .sisyphus/evidence/task-1-reagent-regression.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 2. Harden disabled-room fallback states and no-cargo completion

  **What to do**:
  - Extend the Task 1 disabled branch implementation and tests for all fallback states:
    1. If `!room?.controller?.my || !room.terminal`: clear tasks with `replaceCarrierTasksForProducerRoom(..., [])`, set stage `"blocked"`, `lastError: "room_or_terminal_unavailable"`, `lastTransitionAt: Game.time`, return.
    2. If `resolveLabTopology()` returns null: clear tasks, set stage `"blocked"`, clear `reagentLabIds`/`productLabIds`, `lastError: "lab_topology_unavailable"`, `lastTransitionAt: Game.time`, return.
    3. If topology resolves but no product/reagent cleanup task exists: replace with `[]`, set stage `"blocked"`, `lastError: "room_config_disabled"`, include topology ids, return.
    4. Preserve previous `activeProduct`, `targetAmount`, `batchSize`, `successfulRuns` unless existing nearby patterns require clearing cleanup-only fields.
  - Prefer a small local helper if it reduces duplication with the no-activePlan branch, but do not extract a broad new subsystem.
  - Run disabled fallback tests until they pass; save output to `.sisyphus/evidence/task-2-disabled-fallbacks.txt`.

  **Must NOT do**:
  - Do not change `normalizeRoomConfig()` at `src/runtime/synthesisControl.ts:196-235`.
  - Do not write `Memory.runtime.hub.needsPlan` in this branch.
  - Do not modify `src/runtime/carrierTaskBoard.ts`, `src/roles/carrier.ts`, `src/runtime/hubPlanner.ts`, `src/runtime/resourceControl.ts`, or market code.

  **Recommended Agent Profile**:
  - Category: `quick` - Same production branch plus edge-case tests.
  - Skills: `[]` - TypeScript/Jest only.
  - Omitted: `playwright` - No browser/UI behavior.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 3, 4 | Blocked By: 1

  **References** (executor has NO interview context - be exhaustive):
  - Error states: `src/runtime/synthesisControl.ts:1113-1138` - room unavailable and topology unavailable blocked states.
  - Task replacement: `src/runtime/carrierTaskBoard.ts` - replacement semantics are correct and must not change.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "disabled room.*blocks"` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] Diff touches only `src/runtime/synthesisControl.ts` and `src/runtime/synthesisControlStateMachine.test.ts`.
  - [ ] No `Memory.runtime.hub` write is added in the disabled branch.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Disabled empty/no-topology fallbacks
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "disabled room.*blocks"`.
    Expected: Empty labs, no visible room, and fewer-than-three-labs cases all pass with no carrier tasks and correct `lastError` values.
    Evidence: .sisyphus/evidence/task-2-disabled-blocked-fallbacks.txt

  Scenario: Disabled cleanup completion
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "disabled room returns to blocked"`.
    Expected: First tick generates unload task; second tick with empty labs returns to `blocked` and has no carrier tasks.
    Evidence: .sisyphus/evidence/task-2-disabled-completion.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 3. Preserve enabled-room behavior and complete state-machine verification

  **What to do**:
  - Run the whole `src/runtime/synthesisControlStateMachine.test.ts` file.
  - If any existing enabled-room tests fail, fix the disabled-branch implementation rather than weakening test assertions.
  - Specifically confirm these existing test groups still pass without edits:
    - stranded recovery tests near `src/runtime/synthesisControlStateMachine.test.ts:1329`
    - reagent cleanup tests near `src/runtime/synthesisControlStateMachine.test.ts:1725`
    - product-unload priority test near `src/runtime/synthesisControlStateMachine.test.ts:1857`
  - Add at most one additional regression test only if whole-file verification reveals an untested enabled-room interaction caused by the disabled branch; otherwise do not add more tests here.
  - Save output to `.sisyphus/evidence/task-3-state-machine-full.txt`.

  **Must NOT do**:
  - Do not modify existing tests to match new behavior.
  - Do not add duplicate disabled-room edge tests already covered by Task 2.
  - Do not introduce test-only production flags.

  **Recommended Agent Profile**:
  - Category: `quick` - Whole-file regression pass for touched subsystem.
  - Skills: `[]` - Jest patterns are local.
  - Omitted: `playwright` - No UI.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 4 | Blocked By: 2

  **References** (executor has NO interview context - be exhaustive):
  - Existing enabled behavior: `src/runtime/synthesisControlStateMachine.test.ts:710` - lab_product_unload task generation.
  - Existing stranded behavior: `src/runtime/synthesisControlStateMachine.test.ts:1329` - stranded recovery when active plan is null.
  - Existing cleanup behavior: `src/runtime/synthesisControlStateMachine.test.ts:1725` - reagent cleanup when idle.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand` passes.
  - [ ] Existing enabled-room behavior tests in the file pass without deleting or weakening assertions.
  - [ ] No additional source files beyond `src/runtime/synthesisControl.ts` and `src/runtime/synthesisControlStateMachine.test.ts` are touched.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Whole state-machine regression
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand`.
    Expected: Exit code 0; all existing and new state-machine tests pass.
    Evidence: .sisyphus/evidence/task-3-state-machine-full.txt

  Scenario: Enabled behavior spot-check
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand -t "lab_product_unload task generation|reagent lab cleanup when idle"`.
    Expected: Existing enabled/null-plan product unload and cleanup tests pass without assertion edits.
    Evidence: .sisyphus/evidence/task-3-enabled-spotcheck.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/synthesisControlStateMachine.test.ts`, `src/runtime/synthesisControl.ts` if verification fixes require production adjustment]

- [x] 4. Run full verification and prepare deployment evidence

  **What to do**:
  - Run targeted, full Jest, and TypeScript verification in this order:
    1. `npx jest --config jest.config.cjs src/runtime/synthesisControlStateMachine.test.ts --runInBand`
    2. `npm run test`
    3. `npx tsc --noEmit`
  - Save outputs to:
    - `.sisyphus/evidence/task-4-synthesis-state-machine.txt`
    - `.sisyphus/evidence/task-4-npm-test.txt`
    - `.sisyphus/evidence/task-4-tsc-noemit.txt`
  - Inspect git diff and confirm only intended source/test files changed, plus `.sisyphus/evidence/` artifacts if evidence is tracked by the work session.
  - Prepare the final implementation summary for review agents.
  - Do not deploy until final verification wave approval and explicit user okay.

  **Must NOT do**:
  - Do not run `npm run push` before final wave approval and explicit user okay.
  - Do not commit unless user explicitly asks for commit.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Verification and evidence capture.
  - Skills: `[]` - Shell verification only.
  - Omitted: `playwright` - No UI.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: Final Verification | Blocked By: 3

  **References** (executor has NO interview context - be exhaustive):
  - Commands: `package.json:6-14` - scripts for build/test.
  - Workflow: project memory says deploy via `npm run push` only after TypeScript/Jest verification and final approval.
  - Guardrail: `.secret.json` contains credentials; never commit it.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Targeted state-machine Jest command passes.
  - [ ] Full `npm run test` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `git diff --stat` contains only expected implementation/test/evidence paths.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Full unit regression
    Tool: Bash
    Steps: Run `npm run test`.
    Expected: Exit code 0; no failing Jest suites.
    Evidence: .sisyphus/evidence/task-4-npm-test.txt

  Scenario: TypeScript safety
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: Exit code 0; no TypeScript diagnostics.
    Evidence: .sisyphus/evidence/task-4-tsc-noemit.txt
  ```

  **Commit**: NO | Message: n/a | Files: [verification only]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
  - Verify disabled branch only changed intended behavior.
  - Verify every Must NOT guardrail is satisfied.
- [x] F2. Code Quality Review — unspecified-high
  - Review duplication, state writes, task replacement semantics, and test quality.
- [x] F3. Real Manual QA — unspecified-high
  - Execute unit/TypeScript commands from Task 4 and inspect evidence files.
  - Optional read-only live follow-up after deployment approval: inspect shard1/E4N58 runtime for lab task generation.
- [x] F4. Scope Fidelity Check — deep
  - Confirm no hub planner/resourceControl/carrier movement scope creep.

## Commit Strategy
- Do not commit unless user explicitly asks.
- If asked to commit after approval, use semantic message: `fix(synthesis): unload lab cargo for disabled rooms`.
- Commit files should be limited to:
  - `src/runtime/synthesisControl.ts`
  - `src/runtime/synthesisControlStateMachine.test.ts`
  - Evidence files only if repository convention requires tracking them.
- After final wave approval and user okay, deploy with `npm run push` per project workflow.

## Success Criteria
- E4N58-style state (`reactions=[]`, product lab has `XUHO2`) generates `lab_product_unload` instead of clearing all tasks.
- Disabled rooms with only reagent residue generate `lab_cleanup`.
- Disabled rooms with no cleanup possible remain blocked with accurate `lastError`.
- Existing synthesis state-machine behavior for enabled rooms remains unchanged.
- Full Jest and TypeScript verification passes.

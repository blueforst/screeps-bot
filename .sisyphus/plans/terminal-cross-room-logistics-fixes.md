# Terminal Cross-Room Logistics Fixes

## TL;DR
> **Summary**: Fix terminal transfer task correctness, prevent energy auto-balance from starving explicit cross-room transfer tasks, harden task storage cleanup, and add missing Jest coverage for the terminal logistics core.
> **Deliverables**:
> - Dedicated tests for `resourceTransferTasks.ts` pure task store behavior.
> - Runtime fix for below-minimum tail transfers in `executeTransferTasks`.
> - Runtime fairness rule: explicit pending outgoing transfer tasks take precedence over auto-balance sends from the same donor room.
> - Survival-state guard for native mineral auto-sell.
> - Safer `Memory.data.resourceControl.tasks` cleanup behavior.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 7

## Context
### Original Request
用户要求检查并修复 “terminal 的跨房物流系统” 中的问题。

### Interview Summary
- Scope was corrected from HAUL flag / `remoteCarrier` to terminal-based logistics.
- Relevant implementation is centered on `src/runtime/resourceControl.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, and terminal-related tests in `src/runtime/resourceControl.test.ts`.
- The plan intentionally excludes broad automatic mineral balancing and synthesis binding deduplication unless later requested.

### Metis Review (gaps addressed)
- Metis confirmed the below-minimum tail failure, auto-balance starvation, duplicate synthesis binding stores, aggressive task-store cleanup, survival-room native mineral auto-sell risk, and missing tests.
- Metis recommended TDD ordering: pure task-store tests first, then runtime fixes with failing tests, then full verification.
- Metis flagged synthesis binding deduplication as real but out of scope to avoid refactor creep.

## Work Objectives
### Core Objective
Make terminal cross-room transfer tasks reliable and test-covered without changing main tick order or introducing broad new mineral balancing behavior.

### Deliverables
- `src/runtime/logistics/resourceTransferTasks.test.ts` covering task creation, validation, merge, cancel, cleanup, and aggregation helpers.
- Additional `src/runtime/resourceControl.test.ts` cases covering transfer task execution tails, fairness with auto-balance, send failure/retry behavior, fee-halving/final-flush behavior, and survival auto-sell guard.
- Focused fixes in `src/runtime/resourceControl.ts` and `src/runtime/logistics/resourceTransferTasks.ts`.

### Definition of Done (verifiable conditions with commands)
- `npm run test` exits 0.
- `npx tsc --noEmit` exits 0.
- New tests fail on the current behavior for the targeted bug before implementation and pass after implementation.
- No source files outside `src/runtime/resourceControl.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, and test files are modified unless a referenced type import requires it.

### Must Have
- Below-minimum remaining transfer tasks must not be permanently failed solely because `remainingAmount < transferMinAmount`.
- Explicit pending outgoing transfer tasks must have priority over internal energy auto-balance from the same donor room.
- Survival rooms must not spend terminal energy on native mineral auto-sell.
- Task cleanup must not delete non-task data under `Memory.data.resourceControl`.
- All behavior changes must be covered by Jest tests.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do NOT change `src/main.ts` tick order.
- Do NOT implement general automatic mineral balancing.
- Do NOT deduplicate synthesis binding stores/types in this plan; record it as follow-up only.
- Do NOT add Screeps deployment or live-console verification as required acceptance criteria.
- Do NOT loosen market fee safety checks or bypass `Game.market.calcTransactionCost`.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest (`npm run test`) plus TypeScript static verification (`npx tsc --noEmit`).
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task-store test foundation and current runtime characterization.
Wave 2: Runtime correctness/fairness fixes and associated tests.
Wave 3: Cleanup hardening, survival auto-sell guard, integration verification.

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Add resource transfer task-store tests | None | 2, 6 |
| 2. Fix below-minimum transfer tails | 1 | 7 |
| 3. Prioritize explicit transfer tasks over auto-balance | None | 7 |
| 4. Guard survival rooms from native mineral auto-sell | None | 7 |
| 5. Add executeTransferTasks failure/retry tests | None | 2, 3, 7 |
| 6. Harden task-store cleanup behavior | 1 | 7 |
| 7. Full terminal logistics verification pass | 2, 3, 4, 5, 6 | Final verification |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Tasks | Categories |
|---|---:|---|
| 1 | 2 | quick, deep |
| 2 | 3 | deep, quick |
| 3 | 2 | quick, unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add dedicated tests for resource transfer task store

  **What to do**: Create `src/runtime/logistics/resourceTransferTasks.test.ts`. Cover pure task-store behavior without touching runtime send logic: valid creation, invalid room/resource/amount/same-room validation, merge into existing pending task with same `fromRoomName`/`toRoomName`/`resource`/`reason`, non-merge when reason differs, cancel existing/nonexistent tasks, cleanup stale completed/failed/cancelled tasks, room-loss pruning, and incoming/outgoing aggregation helpers. Use existing Jest/Screeps mock setup rather than custom globals.
  **Must NOT do**: Do not change production code in this task except minimal exports if a helper is already intended to be public; prefer testing exported APIs only.

  **Recommended Agent Profile**:
  - Category: `quick` - Focused test file for pure functions.
  - Skills: [`superpowers:test-driven-development`] - Tests should characterize current behavior before fixes.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: tasks 2, 6 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/resourceControl.test.ts` - existing Jest setup, room helpers, Screeps mocks, and assertion style.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts` - exported task CRUD/query/cleanup functions.
  - Memory: `Memory.data.resourceControl.tasks` - transfer task storage path.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test -- --runTestsByPath src/runtime/logistics/resourceTransferTasks.test.ts` exits 0.
  - [ ] Test asserts invalid same-room transfer returns/records `ERR_SAME_ROOM` behavior from current API.
  - [ ] Test asserts merge adds amount to an existing pending matching task and does not create a second task.
  - [ ] Test asserts incoming/outgoing aggregations count only pending tasks.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Task-store CRUD and merge behavior
    Tool: Bash
    Steps: Run `npm run test -- --runTestsByPath src/runtime/logistics/resourceTransferTasks.test.ts`.
    Expected: Jest exits 0 and includes passing tests for create, merge, cancel, cleanup, and aggregation helpers.
    Evidence: .sisyphus/evidence/task-1-resource-transfer-tasks-tests.txt

  Scenario: Invalid transfer inputs remain rejected
    Tool: Bash
    Steps: Run the same Jest path and inspect assertions for same-room, invalid amount, invalid resource, and empty-room cases.
    Expected: Each invalid input returns the expected error result and no pending task is added.
    Evidence: .sisyphus/evidence/task-1-resource-transfer-tasks-invalid.txt
  ```

  **Commit**: YES | Message: `test(resource-control): cover resource transfer task store` | Files: [`src/runtime/logistics/resourceTransferTasks.test.ts`]

- [x] 2. Fix below-minimum transfer tail handling

  **What to do**: In `src/runtime/resourceControl.ts`, change `executeTransferTasks` so a task with `remainingAmount < donor.transferMinAmount` is not permanently failed solely for that reason. Decision: allow a final flush below `transferMinAmount` when it is the task's remaining amount, but still require terminal resource availability, energy fee budget, and successful `terminal.send`. If final flush cannot send due to resource/fee/cooldown/readiness, keep task `pending` with a non-permanent `lastError` such as `waiting_for_final_flush`, not `failed`. Mark task `done` only after successful final send reduces `remainingAmount <= 0`.
  **Must NOT do**: Do not allow arbitrary normal sends below `transferMinAmount`; only the final remainder may bypass the minimum. Do not ignore transaction fees.

  **Recommended Agent Profile**:
  - Category: `deep` - Runtime behavior change in central resource control loop.
  - Skills: [`superpowers:test-driven-development`] - Must add failing test before code change.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: task 7 | Blocked By: task 1 recommended, task 5 related

  **References** (executor has NO interview context - be exhaustive):
  - Bug: `src/runtime/resourceControl.ts:543-549` - current permanent failure on `remaining_below_transfer_min`.
  - Helper: `src/runtime/resourceControl.ts:389-401` - `computeSendAmount` fee/batch logic; adapt carefully for final flush.
  - Pattern: `src/runtime/resourceControl.test.ts` - tests around resource control tick execution.
  - API: `src/runtime/logistics/resourceTransferTasks.ts` - transfer task status and remaining amount fields.

  **Acceptance Criteria** (agent-executable only):
  - [ ] New Jest test proves a task with remaining below `transferMinAmount` sends the final amount when terminal resource and fee budget are available.
  - [ ] New Jest test proves below-minimum final remainder stays `pending`, not `failed`, when fee/resource is unavailable.
  - [ ] Existing tests still pass with `npm run test -- --runTestsByPath src/runtime/resourceControl.test.ts`.
  - [ ] `npx tsc --noEmit` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Final flush succeeds below transferMinAmount
    Tool: Bash
    Steps: Run `npm run test -- --runTestsByPath src/runtime/resourceControl.test.ts` after adding a task with remaining 500 and donor transferMinAmount 1000.
    Expected: `terminal.send` called with amount 500; task status becomes `done`; no `remaining_below_transfer_min` failure remains.
    Evidence: .sisyphus/evidence/task-2-final-flush-success.txt

  Scenario: Final flush waits when resources or fees are missing
    Tool: Bash
    Steps: Run the same Jest path with terminal lacking resource or fee energy.
    Expected: Task status remains `pending`; `lastError` is non-permanent; no send occurs.
    Evidence: .sisyphus/evidence/task-2-final-flush-wait.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): allow terminal transfer final flush` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 3. Prioritize explicit transfer tasks over internal auto-balance sends

  **What to do**: Update internal energy balancing in `src/runtime/resourceControl.ts` so rooms with pending outgoing transfer tasks are skipped as auto-balance donors for that resource-control run. Decision: explicit transfer tasks win over automatic energy balancing. Use existing pending outgoing task helpers from `resourceTransferTasks.ts` if they can answer “any pending outgoing task from room”; otherwise add a small exported helper with tests in `resourceTransferTasks.test.ts`. Add tests showing a donor with pending mineral transfer does not auto-send energy first, leaving terminal available for transfer task execution.
  **Must NOT do**: Do not change `runResourceControl()` overall order unless necessary; implement donor filtering inside/around `applyInternalBalancing`. Do not block rooms that only have completed/failed/cancelled tasks.

  **Recommended Agent Profile**:
  - Category: `deep` - Scheduling fairness across two resource-control subsystems.
  - Skills: [`superpowers:test-driven-development`] - Characterize starvation before fix.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: task 7 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Bug: `src/runtime/resourceControl.ts:452-491` - `applyInternalBalancing` sends energy and marks donor busy.
  - Bug: `src/runtime/resourceControl.ts:540` - `executeTransferTasks` skips terminalBusy donors.
  - API: `src/runtime/logistics/resourceTransferTasks.ts` - pending outgoing task query/count helpers.
  - Test: `src/runtime/resourceControl.test.ts:339` - existing auto-balance fee budget test pattern.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Test creates a donor eligible for energy auto-balance and also having a pending outgoing mineral transfer; resource control does not call energy auto-balance send first.
  - [ ] Test confirms donor without pending outgoing tasks still auto-balances energy as before.
  - [ ] `npm run test -- --runTestsByPath src/runtime/resourceControl.test.ts src/runtime/logistics/resourceTransferTasks.test.ts` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Pending transfer task suppresses donor auto-balance
    Tool: Bash
    Steps: Run resource control Jest tests with one export donor, one survival receiver, and one pending outgoing mineral task from the donor.
    Expected: Energy auto-balance send is skipped for the donor; transfer-task path remains eligible to use the terminal.
    Evidence: .sisyphus/evidence/task-3-transfer-priority.txt

  Scenario: Auto-balance unchanged without pending transfers
    Tool: Bash
    Steps: Run existing auto-balance tests with no pending outgoing transfer task.
    Expected: Previous energy staging/auto-balance behavior still passes.
    Evidence: .sisyphus/evidence/task-3-autobalance-regression.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): prioritize explicit terminal transfers` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`]

- [x] 4. Prevent survival rooms from native mineral auto-sell

  **What to do**: In market sell room selection in `src/runtime/resourceControl.ts`, ensure native mineral auto-sell is skipped when the room's resource state is `survival`. Decision: survival means preserving terminal energy; native mineral sales may resume when room returns to balanced/export state and still has surplus. Add/adjust tests in `resourceControl.test.ts`.
  **Must NOT do**: Do not disable native mineral auto-sell for balanced/export rooms. Do not change manual market commands.

  **Recommended Agent Profile**:
  - Category: `quick` - Small guard plus tests.
  - Skills: [`superpowers:test-driven-development`] - Add regression test first.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: task 7 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Bug: `src/runtime/resourceControl.ts:921-928` - native mineral surplus can include non-export/survival rooms in sell candidates.
  - Pattern: `src/runtime/resourceControl.test.ts:409` - native mineral auto-sell test.
  - Config: market settings in `Memory.cfg.resourceControl.market` as used by existing tests.

  **Acceptance Criteria** (agent-executable only):
  - [ ] New test proves survival room with native mineral surplus does not call `Game.market.deal` for auto-sell.
  - [ ] Existing native mineral auto-sell test for eligible room still passes.
  - [ ] `npm run test -- --runTestsByPath src/runtime/resourceControl.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Survival room skips native mineral auto-sell
    Tool: Bash
    Steps: Run resource control Jest tests with room state below energy floor and native mineral surplus above threshold.
    Expected: No market deal is made; terminal energy remains reserved for survival/recovery logistics.
    Evidence: .sisyphus/evidence/task-4-survival-sell-skip.txt

  Scenario: Eligible room still auto-sells native mineral
    Tool: Bash
    Steps: Run existing native mineral auto-sell case for a non-survival room.
    Expected: Market deal behavior remains unchanged.
    Evidence: .sisyphus/evidence/task-4-native-sell-regression.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): skip survival mineral auto-sell` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 5. Add executeTransferTasks failure and retry coverage

  **What to do**: Extend `src/runtime/resourceControl.test.ts` to cover transfer task execution outcomes beyond happy path: room not ready, terminal cooldown, insufficient terminal resource/fee, permanent send errors such as invalid target/args if represented by existing code, retryable send errors, `taskMaxPerRun`, and fee-halving behavior for a batch that must be reduced due to transaction cost. These tests should lock expected statuses and `lastError` strings.
  **Must NOT do**: Do not overfit tests to private helper names; assert through public `createResourceTransferTask` + `runResourceControl()` behavior.

  **Recommended Agent Profile**:
  - Category: `deep` - Broad behavioral test coverage around central runtime loop.
  - Skills: [`superpowers:test-driven-development`] - Tests characterize runtime behavior and guard fixes.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 1/2 | Blocks: task 7 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Core: `src/runtime/resourceControl.ts` - `executeTransferTasks`, `computeSendAmount`, terminal send handling.
  - Tests: `src/runtime/resourceControl.test.ts` - use existing room setup and mocked `terminal.send`/`Game.market.calcTransactionCost` patterns.
  - Task API: `src/runtime/logistics/resourceTransferTasks.ts` - create/list/query task state.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Tests cover retryable conditions without changing task to permanent failed.
  - [ ] Tests cover permanent send failure changing task to failed when current code intends permanent failure.
  - [ ] Tests cover fee-halving sends a reduced amount when full batch fee exceeds budget.
  - [ ] Tests cover `taskMaxPerRun` limiting execution count.
  - [ ] `npm run test -- --runTestsByPath src/runtime/resourceControl.test.ts` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Retryable transfer task failures remain retryable
    Tool: Bash
    Steps: Run resource control Jest tests with cooldown or insufficient terminal resource/fee conditions.
    Expected: Task remains pending with expected `lastError`; no permanent failure unless explicitly permanent error path.
    Evidence: .sisyphus/evidence/task-5-retryable-failures.txt

  Scenario: Fee halving and taskMaxPerRun are enforced
    Tool: Bash
    Steps: Run tests where `Game.market.calcTransactionCost` forces reduced send amount and multiple tasks exceed max-per-run.
    Expected: Reduced valid amount is sent; only configured number of tasks execute.
    Evidence: .sisyphus/evidence/task-5-fee-and-limit.txt
  ```

  **Commit**: YES | Message: `test(resource-control): cover terminal transfer failures` | Files: [`src/runtime/resourceControl.test.ts`]

- [x] 6. Harden resource transfer task cleanup contract

  **What to do**: Update `cleanupResourceTransferTaskStore` in `src/runtime/logistics/resourceTransferTasks.ts` so it removes stale task entries and deletes the `tasks` sub-key when empty, but deletes `Memory.data.resourceControl` only if it has no other own keys. Before changing, verify with code search/LSP that no existing non-task fields are stored under `Memory.data.resourceControl`; if none exist, still implement future-safe behavior. Add test coverage in `resourceTransferTasks.test.ts` for preserving a synthetic non-task field.
  **Must NOT do**: Do not change `Memory.runtime.resourceControl` behavior. Do not delete `Memory.data.resourceControl` when it contains non-task fields.

  **Recommended Agent Profile**:
  - Category: `quick` - Small memory cleanup hardening plus tests.
  - Skills: [`superpowers:test-driven-development`] - Preserve behavior with explicit regression test.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: task 7 | Blocked By: task 1

  **References** (executor has NO interview context - be exhaustive):
  - Bug: `src/runtime/logistics/resourceTransferTasks.ts:238-240` - currently deletes whole `resourceControl` data key when tasks empty.
  - Search target: all references to `Memory.data.resourceControl` / `ensureData().resourceControl`.
  - Test: `src/runtime/logistics/resourceTransferTasks.test.ts` from task 1.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Test proves cleanup deletes empty task store when no other resourceControl fields exist.
  - [ ] Test proves cleanup preserves `Memory.data.resourceControl` when a non-task field exists.
  - [ ] `npm run test -- --runTestsByPath src/runtime/logistics/resourceTransferTasks.test.ts` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Cleanup removes stale tasks without leaving empty task map
    Tool: Bash
    Steps: Run task-store Jest tests with only stale completed/failed/cancelled tasks.
    Expected: Stale tasks removed; empty task container is cleaned according to contract.
    Evidence: .sisyphus/evidence/task-6-clean-empty-store.txt

  Scenario: Cleanup preserves non-task resourceControl data
    Tool: Bash
    Steps: Run task-store Jest test with `Memory.data.resourceControl.extraField = true` and no remaining tasks.
    Expected: `extraField` remains after cleanup; only `tasks` is removed/empty.
    Evidence: .sisyphus/evidence/task-6-preserve-non-task-data.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): preserve task store siblings on cleanup` | Files: [`src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`]

- [x] 7. Run full terminal logistics verification and record follow-ups

  **What to do**: Run the full project verification after all fixes. Confirm no unintended source files changed. Record synthesis binding deduplication as a follow-up note only if still relevant; do not implement it. Produce evidence files for test and TypeScript outputs.
  **Must NOT do**: Do not run `npm run push`. Do not modify `.secret.json`, `dist/`, or generated output.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Whole-branch verification and change audit.
  - Skills: [`superpowers:verification-before-completion`] - Evidence before completion claims.
  - Omitted: [`git-master`] - Only needed if user explicitly requests commits; per-task commit suggestions are present but execution should respect user/session commit policy.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: final verification | Blocked By: tasks 2, 3, 4, 5, 6

  **References** (executor has NO interview context - be exhaustive):
  - Commands: `npm run test`, `npx tsc --noEmit`.
  - Scope files: `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`.
  - Out-of-scope follow-up: synthesis binding deduplication across `resourceControl.ts`, `synthesisControl.ts`, `synthesisCompatibilityPlanning.ts`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run test` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `git diff --name-only` contains only scoped files unless justified in evidence.
  - [ ] Evidence files exist for full Jest and TypeScript verification.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Full Jest suite passes
    Tool: Bash
    Steps: Run `npm run test`.
    Expected: Exit code 0 with all suites passing.
    Evidence: .sisyphus/evidence/task-7-full-jest.txt

  Scenario: TypeScript static verification passes
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: Exit code 0 with no TypeScript errors.
    Evidence: .sisyphus/evidence/task-7-tsc.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: [verification only]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Prefer 4 atomic commits if commits are requested by the user:
  1. `test(resource-control): cover resource transfer task store`
  2. `fix(resource-control): handle terminal transfer tails`
  3. `fix(resource-control): prioritize explicit terminal transfers`
  4. `fix(resource-control): harden terminal logistics safeguards`
- Do not commit without explicit user request.
- Do not push or deploy unless explicitly requested after verification.

## Success Criteria
- Transfer tasks no longer permanently fail only because the remaining final amount is below `transferMinAmount`.
- Auto-balance cannot repeatedly consume a donor terminal before explicit outgoing transfer tasks get a chance to execute.
- Survival rooms do not spend terminal energy on native mineral auto-sell.
- Resource transfer task store behavior is covered by dedicated tests.
- Transfer execution failure/retry behavior is covered by tests.
- `npm run test` and `npx tsc --noEmit` pass.

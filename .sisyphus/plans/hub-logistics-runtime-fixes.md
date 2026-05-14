# Hub Logistics Runtime Fixes

## TL;DR
> **Summary**: Fix three confirmed hub/logistics runtime causes: hub T3 production under-planning, resource-transfer task bloat from failed below-min remnants, and terminal storage/offload oscillation from opposing carrier-board tasks.
> **Deliverables**:
> - Correct `planHubChains()` T3 deficit calculation so E4N58 resumes production for below-reserve T3 compounds such as `XUHO2=894`.
> - Keep below-min resource-transfer tasks pending with blocking errors so dedup/merge works and failed-task history stops growing.
> - Prevent same-room same-resource terminal feed/offload tasks from coexisting.
> - Add targeted Jest regressions and read-only live verification steps.
> **Effort**: Short
> **Parallel**: YES - 3 implementation waves + final verification
> **Critical Path**: Task 1 → Task 2/3 → Task 4 → Final verification

## Context
### Original Request
User reported logistics task memory cleanup problems, hub storage <-> terminal resource oscillation, and hub not producing. User allowed read-only game data access to identify causes.

### Interview Summary
- User clarified the active hub is room `E4N58`.
- Cross-shard read-only scan found `E4N58` on `shard1`, not the auto-selected `shard2`.
- User stated carrier-related behavior is being fixed by another agent; this plan must not modify carrier role files or depend on current `carrier.test.ts` failures.

### Metis Review (gaps addressed)
- Metis identified three concrete root causes:
  1. `planHubChains()` subtracts T3 inventory twice.
  2. `remaining_below_transfer_min` tasks become `failed`, escaping dedup and being recreated.
  3. `syncTerminalFeedTasks()` can create same-resource feed and offload tasks in the same room/tick.
- Metis guardrail: fix upstream creation/lifecycle logic; do not reduce global TTL, add Memory cooldown state, change carrier behavior, or reorder `main.ts`.

## Work Objectives
### Core Objective
Stabilize hub production and logistics task generation without changing carrier-role behavior.

### Deliverables
- `src/runtime/hubPlanner.ts`: corrected T3 planning semantics in `planHubChains()`.
- `src/runtime/resourceControl.ts`: pending-preserving handling for `remaining_below_transfer_min`; same-resource feed/offload mutual exclusion.
- Tests in existing relevant test files only: `src/runtime/hubPlanner.test.ts`, `src/runtime/hubProductionIntegration.test.ts`, `src/runtime/resourceControl.test.ts`, and `src/runtime/logistics/resourceTransferTasks.test.ts` if needed.
- Read-only evidence snapshots under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/runtime/hubPlanner.test.ts` exits 0.
- `npx jest --config jest.config.cjs src/runtime/hubProductionIntegration.test.ts` exits 0.
- `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
- `npx jest --config jest.config.cjs src/runtime/logistics/resourceTransferTasks.test.ts` exits 0 if that file is changed or referenced by new tests.
- `npx jest --config jest.config.cjs --testPathIgnorePatterns="carrier.test.ts"` exits 0.
- `npx tsc --noEmit` exits 0.
- After deployment, `node scripts/monitor-service.mjs --once --shard shard1 --output off` shows hub/read-only status and no growth of duplicate failed `remaining_below_transfer_min` task families.

### Must Have
- Keep all fixes outside `src/roles/carrier.ts` and other carrier-role files.
- Preserve `main.ts` tick order.
- Preserve resource-transfer TTL constant unless tests prove cleanup still needs task-family prevention.
- Ensure blocking-error pending tasks are excluded from incoming hub calculations.
- Ensure feed/offload mutual exclusion is local to resourceControl carrier task creation.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No carrier role changes.
- No `carrier.test.ts` changes.
- No main-loop reordering.
- No new Memory-persisted cooldown/hysteresis state.
- No new global exports.
- No broad refactors of hub/resource modules.
- No live Memory mutation in implementation tasks; only read-only monitoring after deploy.
- No exposure of `.secret.json` token contents.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD for new regressions in touched modules; skip/ignore pre-existing carrier test failures by avoiding `carrier.test.ts` in targeted acceptance.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (hub planner), Task 2 (resource-transfer below-min lifecycle), Task 3 (terminal feed/offload mutual exclusion) can be developed in parallel after reference checks.
Wave 2: Task 4 integrates targeted tests and non-carrier full verification after Tasks 1-3.
Wave 3: Task 5 deploy/read-only live verification after local verification passes.

### Dependency Matrix (full, all tasks)
- Task 1: No implementation dependency; blocks Task 4 and Task 5 hub-production verification.
- Task 2: No implementation dependency; blocks Task 4 and Task 5 task-count verification.
- Task 3: No implementation dependency; blocks Task 4 and Task 5 oscillation verification.
- Task 4: Blocked by Tasks 1-3.
- Task 5: Blocked by Task 4.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 3 tasks → `quick`/`unspecified-low` TypeScript runtime test tasks.
- Wave 2 → 1 task → `unspecified-high` verification integrator.
- Wave 3 → 1 task → `unspecified-high` deploy/read-only runtime verifier.

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Correct hub T3 production planning

  **What to do**: In `src/runtime/hubPlanner.ts`, fix `planHubChains()` so target T3 compounds start with full target demand, not pre-subtracted deficit. Specifically change the T3 initialization logic around `needed[t3]` so the later `toProduce = max(0, demand - have)` subtracts inventory exactly once. Add/update tests in `src/runtime/hubPlanner.test.ts` and, if needed, `src/runtime/hubProductionIntegration.test.ts`.
  **Must NOT do**: Do not change `PROCESS_ORDER`, target compound list, import/distribution planning, `main.ts`, or any carrier file.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized algorithm fix plus tests.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`, `playwright`] - No UI/browser work.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/hubPlanner.ts:144-231` - `planHubChains()` demand propagation and missing-resource detection.
  - Pattern: `src/runtime/hubPlanner.ts:476-571` - `runHubPlanner()` uses `planHubChains()` result to set hub status and write synthesis config.
  - Pattern: `src/runtime/hubPlanner.ts:421-474` - `writeSynthesisConfig()` writes or clears synthesis reactions.
  - Test: `src/runtime/hubPlanner.test.ts` - existing hub chain planning/import/distribution tests.
  - Test: `src/runtime/hubProductionIntegration.test.ts` - integration wiring for hub planner → synthesis control → status reporting.
  - Live evidence: shard1/E4N58 hub inventory had `XUHO2=894`, default reserve `1000`, hub status `distributing`, and no synthesis room config.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/hubPlanner.test.ts` exits 0.
  - [ ] `npx jest --config jest.config.cjs src/runtime/hubProductionIntegration.test.ts` exits 0.
  - [ ] New/updated test: `planHubChains({ XUHO2: 894 }, {}, 1000)` returns at least one step for `XUHO2`.
  - [ ] New/updated test: `planHubChains({ XUHO2: 1000 }, {}, 1000)` returns no `XUHO2` step.
  - [ ] New/updated test: `planHubChains({ XUHO2: 500 }, {}, 1000)` returns an `XUHO2` step with `targetAmount=500`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Below-reserve T3 triggers production
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubPlanner.test.ts --runInBand`; capture output to `.sisyphus/evidence/task-1-hub-planning.txt`.
    Expected: Command exits 0 and includes the new XUHO2 below-reserve regression passing.
    Evidence: .sisyphus/evidence/task-1-hub-planning.txt

  Scenario: At-reserve T3 remains idle
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubProductionIntegration.test.ts --runInBand`; capture output to `.sisyphus/evidence/task-1-hub-integration.txt`.
    Expected: Command exits 0; no integration expectation requires synthesis when all targets meet reserve.
    Evidence: .sisyphus/evidence/task-1-hub-integration.txt
  ```

  **Commit**: YES | Message: `fix(hub): correct t3 production planning` | Files: [`src/runtime/hubPlanner.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/hubProductionIntegration.test.ts` if needed]

- [x] 2. Keep below-min transfer tasks pending and deduplicated

  **What to do**: In `src/runtime/resourceControl.ts`, change `executeTransferTasks()` handling for `task.remainingAmount < donor.transferMinAmount`: do not set `status="failed"`; leave status as `pending`, set `updatedAt=Game.time`, set `lastError="remaining_below_transfer_min"`, emit an action such as `task-blocked` rather than `task-failed`, and continue. This makes the existing pending-task merge/dedup path in `createResourceTransferTask()` work. Add regression coverage in `src/runtime/resourceControl.test.ts`; use `src/runtime/logistics/resourceTransferTasks.test.ts` only if direct merge behavior needs coverage there.
  **Must NOT do**: Do not lower `RESOURCE_CONTROL_TASK_TTL`, delete historical tasks directly, or add a new cleanup command. Do not modify `src/roles/carrier.ts` or `carrier.test.ts`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized lifecycle fix and targeted tests.
  - Skills: [] - No special skill required.
  - Omitted: [`git-master`] - Commit can be handled later by main executor.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/resourceControl.ts:547-666` - `executeTransferTasks()` transfer task execution and error handling.
  - Pattern: `src/runtime/resourceControl.ts:618-624` - current below-min path marks tasks failed; replace this behavior.
  - Pattern: `src/runtime/resourceControl.ts:632-636` - `insufficient_terminal_resource_or_fee` already keeps task pending with blocking `lastError`; below-min should follow this style.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:68-88` - `findMergeablePendingTask()` only deduplicates pending tasks.
  - API/Type: `src/runtime/logistics/resourceTransferTasks.ts:188-205` - `BLOCKING_ERRORS` excludes below-min pending tasks from incoming-resource counts.
  - Cleanup: `src/runtime/logistics/resourceTransferTasks.ts:230-253` and `src/runtime/memoryCleanup.ts:36,447-449` - terminal-state TTL cleanup remains unchanged.
  - Live evidence: shard1 had ~844 terminal-state tasks, `640 failed` with `remaining_below_transfer_min`, no pending tasks.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
  - [ ] `npx jest --config jest.config.cjs src/runtime/logistics/resourceTransferTasks.test.ts` exits 0 if modified.
  - [ ] New/updated test: executing a pending transfer where `remainingAmount < transferMinAmount` leaves the task `pending` and sets `lastError="remaining_below_transfer_min"`.
  - [ ] New/updated test: creating another same from/to/resource/reason task after below-min blocking merges into the same pending task instead of creating another task.
  - [ ] New/updated test or assertion: `getIncomingResourceTransferAmount()` does not count below-min blocked pending tasks.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Below-min task remains pending
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand`; capture output to `.sisyphus/evidence/task-2-transfer-lifecycle.txt`.
    Expected: Command exits 0 and the below-min lifecycle regression passes.
    Evidence: .sisyphus/evidence/task-2-transfer-lifecycle.txt

  Scenario: Repeated planning does not bloat task store
    Tool: Bash
    Steps: In the new Jest test, simulate repeated creation/execution for the same below-min task family for 100 iterations.
    Expected: Task store contains exactly one pending task for that from/to/resource/reason family, with blocking `lastError`.
    Evidence: .sisyphus/evidence/task-2-no-bloat.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): keep below-min transfers deduplicated` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts` if changed]

- [x] 3. Prevent same-resource terminal feed/offload oscillation

  **What to do**: In `src/runtime/resourceControl.ts`, update `syncTerminalFeedTasks()` so a room/resource cannot receive both `terminal_feed` and `terminal_offload` drafts from `RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER` in the same refresh. Track resources that actually receive overflow offload drafts and suppress mineral feed drafts for those resources. Keep existing energy behavior untouched because `createEnergyTerminalTask()` already chooses feed OR offload.
  **Must NOT do**: Do not add Memory cooldown/hysteresis state, change carrier board APIs, or alter carrier execution.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized task-generation guard and tests.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser/UI task.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5] | Blocked By: []

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/resourceControl.ts:668-697` - `createTerminalFeedTask()` generates storage → terminal board drafts.
  - Pattern: `src/runtime/resourceControl.ts:699-731` - `createTerminalOffloadTask()` generates terminal → storage board drafts.
  - Pattern: `src/runtime/resourceControl.ts:834-858` - energy feed/offload path already mutually exclusive.
  - Pattern: `src/runtime/resourceControl.ts:860-950` - `syncTerminalFeedTasks()` combines energy, mineral feed, and overflow offload drafts.
  - API/Type: `src/runtime/carrierTaskBoard.ts:86-134` - `replaceCarrierTasksForProducerRoom()` stores drafts by different IDs, so feed/offload can coexist unless filtered before replacement.
  - Test: `src/runtime/resourceControl.test.ts` - terminal feed/offload and hub-aware transfer ordering patterns.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
  - [ ] New/updated test: terminal total > `TERMINAL_TOTAL_STORAGE_CAP`, pending export demand for mineral `X`, and offloadable `X` surplus results in a `terminal_offload` task for `X` but no `terminal_feed` task for `X`.
  - [ ] New/updated test: terminal total <= cap and pending export demand for `X` still creates a `terminal_feed` task for `X`.
  - [ ] New/updated test: energy terminal task behavior remains one-way and is not suppressed by mineral offload filtering.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Overflow suppresses opposing mineral feed
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand`; capture output to `.sisyphus/evidence/task-3-terminal-mutual-exclusion.txt`.
    Expected: Command exits 0 and board assertions show offload-only for the contested mineral.
    Evidence: .sisyphus/evidence/task-3-terminal-mutual-exclusion.txt

  Scenario: Normal pending export still feeds terminal
    Tool: Bash
    Steps: In the new Jest test, set terminal total below cap with a pending non-energy export; inspect carrier board tasks after `runResourceControl()`.
    Expected: A `terminal_feed` draft exists for the pending resource and no offload draft exists for that resource.
    Evidence: .sisyphus/evidence/task-3-normal-feed.txt
  ```

  **Commit**: YES | Message: `fix(resource-control): prevent terminal feed offload oscillation` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 4. Integrate targeted non-carrier verification

  **What to do**: After Tasks 1-3 are complete, run targeted Jest suites and TypeScript verification. If one of the targeted suites fails because of changed semantics, fix the implementation or update only directly related expectations. Do not touch `carrier.test.ts`; carrier behavior is explicitly out of scope and current carrier failures are owned by another agent.
  **Must NOT do**: Do not run or require all tests including `carrier.test.ts` as a pass condition. Do not skip failures in files touched by this plan.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: integration verification across multiple runtime modules.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No UI/browser verification.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [5] | Blocked By: [1, 2, 3]

  **References** (executor has NO interview context - be exhaustive):
  - Test config: `jest.config.cjs` - Jest + ts-jest config.
  - Commands: `package.json` and project AGENTS - `npx tsc --noEmit`, `npm run build`, `npm run test` exists but full suite currently has carrier failures.
  - Known exclusion: `src/roles/carrier.test.ts` has pre-existing lab-logistics failures; do not use it as pass/fail for this plan.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/hubPlanner.test.ts` exits 0.
  - [ ] `npx jest --config jest.config.cjs src/runtime/hubProductionIntegration.test.ts` exits 0.
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
  - [ ] `npx jest --config jest.config.cjs src/runtime/logistics/resourceTransferTasks.test.ts` exits 0 if modified.
  - [ ] `npx jest --config jest.config.cjs --testPathIgnorePatterns="carrier.test.ts"` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Non-carrier runtime tests pass
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs --testPathIgnorePatterns="carrier.test.ts"`; capture output to `.sisyphus/evidence/task-4-non-carrier-jest.txt`.
    Expected: Command exits 0 with no failed suites outside carrier.
    Evidence: .sisyphus/evidence/task-4-non-carrier-jest.txt

  Scenario: TypeScript remains clean
    Tool: Bash
    Steps: Run `npx tsc --noEmit`; capture output to `.sisyphus/evidence/task-4-tsc.txt`.
    Expected: Command exits 0 with no TypeScript errors.
    Evidence: .sisyphus/evidence/task-4-tsc.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: []

- [x] 5. Deploy and perform read-only shard1/E4N58 runtime verification

  **What to do**: After Task 4 passes, deploy using the repository workflow, then capture read-only state from shard1/E4N58. Verify hub production/planning status and transfer-task counts. Use existing monitor service or read-only Screeps API reads; never print secrets.
  **Must NOT do**: Do not mutate live `Memory` or run console commands that change config. Do not cancel tasks manually as part of this plan.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: deployment plus live read-only verification requires care.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser interaction required.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [] | Blocked By: [4]

  **References** (executor has NO interview context - be exhaustive):
  - Command: `npm run push` - project deployment workflow; runs Rollup and uploads to Screeps.
  - Command: `node scripts/monitor-service.mjs --once --shard shard1 --output off` - read-only Memory.analytics snapshot without writing JSONL.
  - Live target: shard1, hub room `E4N58`.
  - Prior live baseline: hub status `distributing`; `XUHO2=894`; `Memory.data.resourceControl.tasks` had hundreds of terminal-state tasks, mostly `remaining_below_transfer_min`, no pending tasks.
  - Secret guardrail: `.secret.json` contains token; commands may read it internally but must never print its contents.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npm run push` exits 0.
  - [ ] Read-only monitor output captured for shard1 and saved to `.sisyphus/evidence/task-5-monitor-once.json`.
  - [ ] Evidence includes `hub.hubRoomName === "E4N58"` and hub status/stage/product fields after deploy.
  - [ ] Evidence or supplemental read-only API summary includes resource-transfer task counts by status/error after deploy.
  - [ ] No command output includes the Screeps auth token.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Deployment succeeds
    Tool: Bash
    Steps: Run `npm run push`; capture output to `.sisyphus/evidence/task-5-deploy.txt`.
    Expected: Command exits 0 and upload completes without authorization errors.
    Evidence: .sisyphus/evidence/task-5-deploy.txt

  Scenario: Live read-only hub snapshot confirms target room
    Tool: Bash
    Steps: Run `node scripts/monitor-service.mjs --once --shard shard1 --output off`; save JSON output to `.sisyphus/evidence/task-5-monitor-once.json`.
    Expected: Snapshot is from shard1 and hub room is `E4N58`; status/product fields are present.
    Evidence: .sisyphus/evidence/task-5-monitor-once.json
  ```

  **Commit**: NO | Message: `n/a` | Files: []

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: `fix(hub): correct t3 production planning`
- Commit 2: `fix(resource-control): keep below-min transfers deduplicated`
- Commit 3: `fix(resource-control): prevent terminal feed offload oscillation`
- Commit 4: `test(runtime): cover hub logistics regressions` if tests are not naturally included with earlier commits.

## Success Criteria
- Hub planner produces synthesis steps when target T3 stock is below reserve.
- Failed `remaining_below_transfer_min` task history stops growing from repeated create-fail cycles.
- Carrier board never contains both `terminal_feed` and `terminal_offload` for the same room/resource in one resourceControl producer refresh.
- Non-carrier verification passes locally; carrier test baseline remains explicitly out of scope.
- Read-only monitor verifies shard1/E4N58 behavior after deployment.

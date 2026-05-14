# HUB Flag Production Hardening

## TL;DR
> **Summary**: HUB flag/full-chain production is usable for real Screeps operation now; this plan adds low-risk hardening around synthesis execution tests, lab cleanup recovery, carrier task foundations, operator console tooling, and explicit internal-only market semantics.
> **Deliverables**:
> - Direct tests for synthesis lifecycle, lab contamination cleanup, carrier task board, and carrier lab logistics.
> - `statusHub()`, `statusHubRaw()`, and `stopHub()` console commands.
> - Immediate hub re-plan signal when a hub-managed synthesis step completes.
> - Explicit `internalOnly` behavior for hub-driven market buys.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Tasks 2-4 → Tasks 5-8 → Final Verification

## Context
### Original Request
User asked: “检查一遍hub falg是否已经可以用于实战”. Audit conclusion: usable for practical deployment with monitoring, but hardening is worthwhile before relying on it unattended.

### Interview Summary
- User selected “生成加固计划”.
- Scope is production hardening, not rewriting the hub planner.
- Existing feature state: all 385 Jest tests passed per exploration; hub flag activation, hub planning, transfer tasks, market protection, and lifecycle planning have broad coverage.

### Metis Review (gaps addressed)
- Added missing foundation coverage for `carrierTaskBoard.ts`.
- Split synthesis hardening into separate lifecycle, contamination, and carrier execution tasks.
- Explicitly labels `needsPlan` wiring and `internalOnly` enforcement as behavioral changes.
- Defaulted contamination deadlock recovery to operator-visible error state, not automatic market selling.
- Guarded against scope creep: no chain algorithm rewrite, no new task types, no main loop reorder.

## Work Objectives
### Core Objective
Make the existing HUB flag/full-chain production feature safer to run unattended in production by adding executable tests, operator controls, and two narrowly scoped behavior hardenings.

### Deliverables
- `src/runtime/carrierTaskBoard.test.ts`
- `src/runtime/synthesisControlStateMachine.test.ts`
- Additional lab logistics cases in `src/roles/carrier.test.ts`
- Hub console commands in `src/runtime/consoleCommands.ts` with type declarations in `src/global.d.ts`
- Hub-aware `internalOnly` market-buy guard in `src/runtime/resourceControl.ts`
- Hub completion re-plan signal in `src/runtime/synthesisControl.ts`
- Focused tests in existing runtime test files for each behavior change

### Definition of Done (verifiable conditions with commands)
- `npx jest --no-coverage src/runtime/carrierTaskBoard.test.ts` exits 0.
- `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts` exits 0.
- `npx jest --no-coverage src/roles/carrier.test.ts src/runtime/consoleCommands.test.ts src/runtime/resourceControl.test.ts src/runtime/hubPlanner.test.ts src/runtime/synthesisControl.test.ts` exits 0.
- `npm run test` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run build` exits 0.

### Must Have
- Zero human-intervention verification; every acceptance criterion is command- or assertion-based.
- Existing HUB behavior remains backward compatible unless explicitly covered in this plan.
- Console commands expose safe, deterministic return values suitable for tests.
- Behavioral changes are limited to: hub step completion setting `Memory.runtime.hub.needsPlan = true`, hub `internalOnly` blocking hub-driven market buys, and `Memory.runtime.hub.lastError` metadata for impossible lab cleanup.

### Must NOT Have
- Do not rewrite `planHubChains`, reaction ordering, import planning, or distribution planning.
- Do not change `src/main.ts` loop order.
- Do not add new carrier task types or change carrier task priority values.
- Do not add automatic market selling for lab contamination recovery.
- Do not touch `synthesisCompatibilityPlanning.ts`.
- Do not deploy (`npm run push`) as part of this plan.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after hardening with Jest; add tests alongside implementation changes.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. Smaller waves are used here because synthesis state tests and behavior hardenings depend on shared runtime mocks and should not race on the same files.

Wave 1: Task 1 foundation carrier task board tests.
Wave 2: Tasks 2-4 synthesis lifecycle, contamination cleanup, carrier lab logistics.
Wave 3: Tasks 5-8 console commands, internalOnly behavior, chain advancement signal, main-loop/order regression coverage.

### Dependency Matrix (full, all tasks)
- Task 1 blocks Tasks 2-4 by validating shared carrier task board assumptions.
- Task 2 blocks Task 7 because completion signaling must be tested after lifecycle behavior is directly covered.
- Task 3 blocks Task 8 because blocked/error reporting depends on cleanup state coverage.
- Task 5 can run after Task 1 and does not block behavior tasks.
- Task 6 can run after Task 1 and only touches resource control tests/logic.
- Task 8 depends on Tasks 2, 3, 5, 7 for integration assertions.

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 1 task → quick
- Wave 2 → 3 tasks → unspecified-high
- Wave 3 → 4 tasks → unspecified-high / quick

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add carrier task board foundation tests

  **What to do**: Create `src/runtime/carrierTaskBoard.test.ts`. Cover task creation, replacement by producer room, producer-room clearing, priority ordering, stale replacement, and no cross-room deletion. Use existing task board API exactly as production modules use it.
  **Must NOT do**: Do not change carrier task schema, task priorities, or producer identifiers.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: isolated test file around one runtime utility.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3, 4] | Blocked By: []

  **References**:
  - Pattern: `src/runtime/resourceControl.test.ts` - Jest mock style for runtime modules and terminal/carrier task assertions.
  - API/Type: `src/runtime/carrierTaskBoard.ts` - task board functions and producer replacement behavior.
  - Test: `src/runtime/logistics/resourceTransferTasks.test.ts` - CRUD-style test organization for shared task stores.

  **Acceptance Criteria**:
  - [ ] `src/runtime/carrierTaskBoard.test.ts` exists with ≥6 tests.
  - [ ] Tests cover replacement by same producer and preservation of other producer tasks.
  - [ ] `npx jest --no-coverage src/runtime/carrierTaskBoard.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Producer replacement preserves other producers
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/carrierTaskBoard.test.ts`.
    Expected: Exit 0; test named like "replaces only tasks for the same producer room" passes.
    Evidence: .sisyphus/evidence/task-1-carrier-task-board.txt

  Scenario: Priority ordering is deterministic
    Tool: Bash
    Steps: Run the same Jest file and inspect reported passing test names.
    Expected: Exit 0; priority ordering test passes without relying on object insertion order.
    Evidence: .sisyphus/evidence/task-1-carrier-task-board-priority.txt
  ```

  **Commit**: YES | Message: `test(runtime): cover carrier task board behavior` | Files: [`src/runtime/carrierTaskBoard.test.ts`]

- [x] 2. Add synthesisControl happy-path lifecycle tests

  **What to do**: Create `src/runtime/synthesisControlStateMachine.test.ts`. Build a deterministic multi-tick test harness for one owned room with terminal, storage, 3 labs, and a configured reaction. Cover idle/acquiring/loading/synthesizing/unloading/idle progression, `lab.runReaction` call arguments, cooldown handling, target amount completion, and `maxRunsPerTick` limiting.
  **Must NOT do**: Do not rewrite synthesis state machine logic while adding tests. Only make minimal testability fixes if a true bug is exposed.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: multi-tick runtime mocks and state-machine verification.
  - Skills: [] - No browser or UI skill required.
  - Omitted: [`playwright`] - No browser interaction.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [7, 8] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/synthesisControl.test.ts` - existing synthesis config and hub guard tests.
  - API/Type: `src/runtime/synthesisControl.ts` - state machine stages and `lab.runReaction` execution.
  - Test: `src/runtime/hubPlanner.test.ts` - multi-room storage/terminal/lab mock setup patterns.

  **Acceptance Criteria**:
  - [ ] `src/runtime/synthesisControlStateMachine.test.ts` includes ≥4 happy-path lifecycle tests.
  - [ ] One test verifies `runReaction(productLab, reagentLabA, reagentLabB)` equivalent call with expected reagent labs.
  - [ ] One test verifies `maxRunsPerTick` caps reaction calls.
  - [ ] `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Full synthesis lifecycle completes
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts`.
    Expected: Exit 0; lifecycle test reaches idle after target amount is met.
    Evidence: .sisyphus/evidence/task-2-synthesis-lifecycle.txt

  Scenario: maxRunsPerTick prevents overproduction
    Tool: Bash
    Steps: Run the same Jest file.
    Expected: Exit 0; test asserts runReaction call count is exactly the configured max.
    Evidence: .sisyphus/evidence/task-2-synthesis-max-runs.txt
  ```

  **Commit**: YES | Message: `test(runtime): cover synthesis lifecycle execution` | Files: [`src/runtime/synthesisControlStateMachine.test.ts`]

- [x] 3. Add lab contamination cleanup and blocked-recovery hardening

  **What to do**: Extend `src/runtime/synthesisControlStateMachine.test.ts` and update `src/runtime/synthesisControl.ts` so contaminated labs reliably enter unloading, create lab cleanup carrier tasks, resume loading after cleanup, and record `Memory.runtime.hub.lastError = "lab_cleanup_destination_full"` when no cleanup destination exists because both storage and terminal are full. Add `lastError?: string` to the hub runtime type in `src/global.d.ts`. Default recovery is status/error metadata only; do not auto-sell resources.
  **Must NOT do**: Do not add market-selling recovery. Do not add new carrier task types. Do not silently discard minerals.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: state-machine edge cases plus small runtime hardening.
  - Skills: [] - No special skill required.
  - Omitted: [`git-master`] - Commit handled by main execution flow if requested.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts` - contamination detection, cleanup task generation, unloading stage.
  - API/Type: `src/runtime/carrierTaskBoard.ts` - cleanup task creation/replacement.
  - Test: `src/runtime/synthesisControl.test.ts` - existing module setup.

  **Acceptance Criteria**:
  - [ ] At least 3 contamination tests exist in `src/runtime/synthesisControlStateMachine.test.ts`.
  - [ ] Contaminated reagent lab creates a `lab_cleanup` carrier task with exact from/to/resource/amount assertions.
  - [ ] Full storage + full terminal records deterministic runtime error/blocked metadata and does not crash.
  - [ ] `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Contamination cleanup task is generated
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts`.
    Expected: Exit 0; contamination test asserts one lab_cleanup task with contaminant resource and lab source.
    Evidence: .sisyphus/evidence/task-3-lab-cleanup.txt

  Scenario: No cleanup destination blocks visibly
    Tool: Bash
    Steps: Run the same Jest file with full terminal/storage case.
    Expected: Exit 0; runtime state contains deterministic lastError/status and no resource loss.
    Evidence: .sisyphus/evidence/task-3-cleanup-blocked.txt
  ```

  **Commit**: YES | Message: `fix(runtime): expose blocked lab cleanup state` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`, `src/global.d.ts`]

- [x] 4. Cover carrier execution for lab supply and cleanup tasks

  **What to do**: Add cases to `src/roles/carrier.test.ts` for `lab_supply` and `lab_cleanup` task execution. Verify reagent pickup from terminal first, fallback to storage, delivery to reagent lab, cleanup withdrawal from contaminated lab, delivery to terminal/storage, and no-op behavior when target lab is already full.
  **Must NOT do**: Do not change task priority or create new role states unless a failing test proves an existing behavior bug.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: role execution tests with creep/structure mocks.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [1]

  **References**:
  - Pattern: `src/roles/carrier.test.ts` - existing carrier behavior test style.
  - API/Type: `src/roles/carrier.ts` - carrier task execution state machine.
  - Pattern: `src/runtime/synthesisControl.ts` - expected `lab_supply` and `lab_cleanup` task payloads.

  **Acceptance Criteria**:
  - [ ] `src/roles/carrier.test.ts` has ≥5 new lab logistics tests.
  - [ ] Tests verify terminal-source and storage-source reagent supply.
  - [ ] Tests verify cleanup withdrawal and deposit.
  - [ ] `npx jest --no-coverage src/roles/carrier.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Carrier supplies reagent lab from terminal
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/roles/carrier.test.ts`.
    Expected: Exit 0; lab_supply test asserts withdraw from terminal and transfer to lab.
    Evidence: .sisyphus/evidence/task-4-lab-supply.txt

  Scenario: Carrier cleans contaminated lab
    Tool: Bash
    Steps: Run the same Jest file.
    Expected: Exit 0; lab_cleanup test asserts withdraw contaminant from lab and deposit to valid destination.
    Evidence: .sisyphus/evidence/task-4-lab-cleanup-carrier.txt
  ```

  **Commit**: YES | Message: `test(roles): cover carrier lab logistics` | Files: [`src/roles/carrier.test.ts`]

- [x] 5. Add hub operator console commands

  **What to do**: Add exported console helpers in `src/runtime/consoleCommands.ts`: `statusHub()`, `statusHubRaw()`, and `stopHub()`. Register them on `global` using the existing console command pattern. `statusHub()` must return a stable object: `{ enabled, hubRoomName, status, activeProduct, activeStage, lastError, needsPlan, targetCompounds }`, where `activeStage` is derived from `Memory.runtime.synthesisControl.rooms[hubRoomName]?.stage`. `statusHubRaw()` returns `Memory.runtime.hub`. `stopHub()` sets `Memory.cfg.hub.enabled = false`, calls `clearHubSynthesisReactions(hubRoomName)`; if that helper is not exported, export it from `src/runtime/hubPlanner.ts` without changing its behavior. `stopHub()` returns/logs a deterministic confirmation object `{ ok: true, hubRoomName, enabled: false, reactionsCleared: true }`.
  **Must NOT do**: Do not cancel non-hub resource transfer tasks. Do not delete user override fields such as `reservePerRoom` or `targetCompounds`.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: small operator API with direct tests.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser interaction.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [8] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/consoleCommands.ts` - existing `statusSynthesisControl` and global registration pattern.
  - API/Type: `src/runtime/hubPlanner.ts` - `clearHubSynthesisReactions` behavior to preserve room metadata.
  - API/Type: `src/global.d.ts` - global function declarations and hub runtime memory shape.

  **Acceptance Criteria**:
  - [ ] `statusHub`, `statusHubRaw`, and `stopHub` are exported and registered globally.
  - [ ] Add or update `src/runtime/consoleCommands.test.ts` with ≥4 hub command tests.
  - [ ] `stopHub()` preserves hub config overrides while disabling planner and clearing reactions.
  - [ ] `npx jest --no-coverage src/runtime/consoleCommands.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: statusHub returns stable summary
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/consoleCommands.test.ts`.
    Expected: Exit 0; test asserts all required statusHub keys exist with deterministic values.
    Evidence: .sisyphus/evidence/task-5-status-hub.txt

  Scenario: stopHub disables safely
    Tool: Bash
    Steps: Run the same Jest file.
    Expected: Exit 0; test asserts enabled=false, reactions cleared, overrides preserved.
    Evidence: .sisyphus/evidence/task-5-stop-hub.txt
  ```

  **Commit**: YES | Message: `feat(runtime): add hub console controls` | Files: [`src/runtime/consoleCommands.ts`, `src/runtime/consoleCommands.test.ts`, `src/runtime/hubPlanner.ts`, `src/global.d.ts`]

- [x] 6. Enforce hub internalOnly for market buys

  **What to do**: Update `src/runtime/resourceControl.ts` so when `Memory.cfg.hub.enabled === true`, `Memory.cfg.hub.hubRoomName` matches the room being evaluated, and `Memory.cfg.hub.internalOnly !== false`, hub-driven synthesis/base-mineral market buy demand is skipped. Existing market sell protections for hub-managed resources remain active regardless of `internalOnly`. Add tests proving default true blocks hub-room market buys, explicit `internalOnly: false` preserves buy behavior, non-hub room behavior is unchanged, and hub resource sell protection remains unchanged.
  **Must NOT do**: Do not disable internal room-to-room hub imports/reclaims. Do not weaken `isHubProtectedResource` sell protection.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: resource control market behavior is safety-critical.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [8] | Blocked By: [1]

  **References**:
  - Pattern: `src/runtime/resourceControl.test.ts` - market buy/sell and hub protection tests.
  - API/Type: `src/runtime/resourceControl.ts` - market demand and hub-protected resource logic.
  - Architecture: project memory says HUB full-chain production uses internal resources only.

  **Acceptance Criteria**:
  - [ ] `src/runtime/resourceControl.test.ts` includes ≥4 new `internalOnly` tests.
  - [ ] Default `internalOnly` blocks hub-room market buy for hub synthesis/base mineral demand.
  - [ ] `internalOnly: false` allows existing buy path without changing sell protection.
  - [ ] `npx jest --no-coverage src/runtime/resourceControl.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: internalOnly blocks external buy
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/resourceControl.test.ts`.
    Expected: Exit 0; default hub internalOnly test asserts `Game.market.deal` is not called for hub-room buy demand.
    Evidence: .sisyphus/evidence/task-6-internal-only-blocks-buy.txt

  Scenario: internalOnly false preserves opt-in buy
    Tool: Bash
    Steps: Run the same Jest file.
    Expected: Exit 0; explicit false test asserts existing buy behavior still occurs.
    Evidence: .sisyphus/evidence/task-6-internal-only-false.txt
  ```

  **Commit**: YES | Message: `fix(runtime): honor hub internal-only market setting` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 7. Signal hubPlanner immediately after hub synthesis step completion

  **What to do**: Update `src/runtime/synthesisControl.ts` so when a synthesis room matching `Memory.cfg.hub.hubRoomName` completes its configured reaction target and transitions back to idle, it sets `Memory.runtime.hub.needsPlan = true`. Add a regression test proving `runHubPlanner` runs out-of-cadence on the next tick and writes the next chain step. This is a behavior hardening, not a planner algorithm change.
  **Must NOT do**: Do not reduce `planInterval` default. Do not write multiple reactions at once. Do not alter reaction ordering.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: small runtime behavior change with integration implications.
  - Skills: [] - No special skill required.
  - Omitted: [`frontend-ui-ux`] - No UI work.

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: [8] | Blocked By: [2]

  **References**:
  - Pattern: `src/runtime/synthesisControl.ts` - target completion and idle transition.
  - Pattern: `src/runtime/hubPlanner.test.ts` - `needsPlan=true` forcing off-cadence hub planning.
  - API/Type: `src/global.d.ts` - `Memory.runtime.hub.needsPlan` field.

  **Acceptance Criteria**:
  - [ ] `src/runtime/synthesisControlStateMachine.test.ts` or `src/runtime/synthesisControl.test.ts` verifies completion sets `Memory.runtime.hub.needsPlan = true` only for the configured hub room.
  - [ ] `src/runtime/hubPlanner.test.ts` includes a regression where off-cadence planning advances after completion signal.
  - [ ] `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts src/runtime/hubPlanner.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Hub synthesis completion requests re-plan
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/synthesisControlStateMachine.test.ts`.
    Expected: Exit 0; completion test asserts needsPlan=true for hub room.
    Evidence: .sisyphus/evidence/task-7-completion-signal.txt

  Scenario: Non-hub synthesis does not affect hub runtime
    Tool: Bash
    Steps: Run the same Jest file.
    Expected: Exit 0; non-hub room completion leaves hub needsPlan unchanged.
    Evidence: .sisyphus/evidence/task-7-nonhub-no-signal.txt
  ```

  **Commit**: YES | Message: `fix(runtime): replan hub after synthesis completion` | Files: [`src/runtime/synthesisControl.ts`, `src/runtime/synthesisControlStateMachine.test.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 8. Add hub production integration regression tests and status assertions

  **What to do**: Create `src/runtime/hubProductionIntegration.test.ts` with focused integration tests that document the actual tick dependency order: hubPlanner writes synthesis config, synthesisControl consumes it, resourceControl respects transfer priority, and flagControl-created `needsPlan` takes effect next tick. Include assertions that `statusHub()` exposes useful blocked/synthesizing/distributing state after Tasks 3, 5, and 7.
  **Must NOT do**: Do not import or execute the full `gameLoop` if doing so requires broad mock churn. Prefer explicit ordered calls to the runtime functions.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: cross-module integration tests with several runtime stores.
  - Skills: [] - No special skill required.
  - Omitted: [`playwright`] - No browser interaction.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [] | Blocked By: [2, 3, 4, 5, 6, 7]

  **References**:
  - Pattern: `src/main.ts` - required order: hubPlanner → synthesisControl → resourceControl → memoryCleanup → flagControl.
  - Pattern: `src/runtime/hubPlanner.test.ts` - full lifecycle integration test style.
  - Pattern: `src/runtime/resourceControl.test.ts` - hub transfer priority assertions.

  **Acceptance Criteria**:
  - [ ] Integration coverage includes at least 3 tests for ordered runtime behavior.
  - [ ] One test proves HUB flag-created config becomes effective on the next planning tick without manual memory edits.
  - [ ] One test proves statusHub output reflects blocked cleanup or active synthesis state.
  - [ ] `npx jest --no-coverage src/runtime/hubProductionIntegration.test.ts src/runtime/consoleCommands.test.ts` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Ordered runtime calls advance hub production
    Tool: Bash
    Steps: Run `npx jest --no-coverage src/runtime/hubProductionIntegration.test.ts src/runtime/consoleCommands.test.ts`.
    Expected: Exit 0; integration test documents exact ordered calls and expected memory/task changes.
    Evidence: .sisyphus/evidence/task-8-runtime-order.txt

  Scenario: statusHub reports actionable state
    Tool: Bash
    Steps: Run the same Jest command.
    Expected: Exit 0; test asserts statusHub contains status, activeProduct/activeStage, lastError, needsPlan, and targetCompounds.
    Evidence: .sisyphus/evidence/task-8-status-regression.txt
  ```

  **Commit**: YES | Message: `test(runtime): add hub production integration regressions` | Files: [`src/runtime/hubPlanner.test.ts`, `src/runtime/consoleCommands.test.ts`, `src/runtime/hubProductionIntegration.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Prefer one commit per task or tightly coupled task pair.
- Use English semantic messages with scope, e.g. `test(runtime): cover synthesis lifecycle execution`.
- Do not commit `.secret.json`, `dist/`, or generated evidence unless the user explicitly requests evidence commits.

## Success Criteria
- HUB flag remains production-usable and gains direct tests for previously indirect synthesis/lab execution paths.
- Operators can inspect and stop hub automation via console commands without manually editing raw memory.
- `internalOnly` has concrete behavior: default true prevents hub-driven external market buys; explicit false opts back into existing buy behavior.
- Hub chain step completion no longer waits up to `planInterval` before requesting the next planning pass.
- Full verification commands pass: `npm run test`, `npx tsc --noEmit`, and `npm run build`.

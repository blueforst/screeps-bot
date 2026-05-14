# Terminal Energy Carrier Jitter Guard

## TL;DR
> **Summary**: Stop terminal energy tasks from flipping between `terminal_offload` and `terminal_feed` around the reserve/target boundary. Protect terminal reserve during offload and add a one-batch deadband before creating offload work.
> **Deliverables**:
> - TDD regression tests in `src/runtime/resourceControl.test.ts` for feed/offload stability
> - Surgical fix in `src/runtime/resourceControl.ts:createEnergyTerminalTask()`
> - Targeted Jest, TypeScript, and full Jest verification evidence
> **Effort**: Short
> **Parallel**: NO
> **Critical Path**: Task 1 → Final Verification Wave

## Context

### Original Request
“还有terminal的补能逻辑也有问题, 会导致carrier反复抖动”

### Interview Summary
- User confirmed the visible jitter pattern is `terminal_feed` / `terminal_offload` flipping between storage and terminal.
- The plan targets resource-control task generation, not carrier movement/pathing.

### Metis Review (gaps addressed)
- Confirmed the binary decision in `src/runtime/resourceControl.ts:createEnergyTerminalTask()` can create ping-pong:
  - storage slightly below `energyTarget` + terminal slightly above reserve → `terminal_offload`
  - terminal then drops below reserve → `terminal_feed`
  - carrier shuttles energy terminal→storage→terminal.
- Guardrail: do not change `syncTerminalFeedTasks()`, `carrierTaskBoard.ts`, carrier role behavior, market/send logic, or mineral feed logic.
- Added concrete numeric regression scenarios and consecutive-run stability requirements.
- Default decision: use existing config values only; no new memory schema or config keys.

## Work Objectives

### Core Objective
Prevent terminal energy refill/offload task generation from oscillating around storage target and terminal reserve thresholds.

### Deliverables
- Tests in `src/runtime/resourceControl.test.ts` proving reserve protection and no flip after a batch transfer.
- Implementation in `src/runtime/resourceControl.ts:createEnergyTerminalTask()` that:
  - protects `terminalEnergyReserve` plus pending send reservations from offload;
  - requires meaningful terminal surplus before offload;
  - requires storage to be meaningfully below target before offload;
  - preserves terminal feed behavior when terminal is below desired reserve/fee budget.
- Verification output saved under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy"` exits 0.
- `npx jest src/runtime/resourceControl.test.ts` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- Only `src/runtime/resourceControl.ts` and `src/runtime/resourceControl.test.ts` are changed unless a failing test proves an unavoidable helper update.

### Must Have
- Use TDD: add failing stability tests before implementation.
- Offload must not consume the configured terminal energy reserve.
- Offload must not fire for tiny surplus amounts smaller than `transferBatchSize`.
- Offload must not fire when storage is within one `transferBatchSize` of `energyTarget`.
- Existing behavior must remain: when storage is far below target and terminal has true surplus above reserve/reservations, offload still creates a task.
- Existing behavior must remain: when terminal is below desired reserve and storage has energy, feed still creates a task.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not add state to `Memory.runtime.resourceControl`.
- Do not add new config keys.
- Do not change `terminalEnergyReserve` semantics for send fees or market logic.
- Do not modify `src/roles/carrier.ts`, `src/runtime/carrierTaskBoard.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, or `src/main.ts`.
- Do not change mineral terminal feed tasks.
- Do not deploy (`npm run push`) as part of this plan.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD + Jest/ts-jest
- QA policy: Every task has agent-executed scenarios
- Evidence: `.sisyphus/evidence/task-1-terminal-energy-jitter-*.log`

## Execution Strategy

### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (`quick`) — resourceControl regression tests + minimal terminal-energy decision fix
Final Wave: F1-F4 review agents in parallel after implementation verification

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|---|---|---|
| 1. Add terminal energy deadband and reserve protection | None | F1-F4 |
| F1-F4. Final Verification Wave | Task 1 | Completion |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|---|---:|---|
| 1 | 1 | quick |
| Final | 4 | oracle, unspecified-high, unspecified-high, deep |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Add terminal energy deadband and reserve protection

  **What to do**:
  1. Open `src/runtime/resourceControl.test.ts` and locate existing terminal energy feed/offload tests.
  2. Add a describe/test group for terminal energy jitter stability, using existing room/config/task-board helpers.
  3. Add these red tests before implementation:
     - Boundary no-op: with `energyTarget=200000`, `terminalEnergyReserve=20000`, `transferBatchSize=10000`, `storageEnergy=195000`, `terminalEnergy=22000`, expect no `terminal_offload` and no `terminal_feed` energy task.
     - True surplus offload: with `storageEnergy=180000`, `terminalEnergy=30000`, same thresholds, expect one `terminal_offload` task for `10000` energy.
     - Consecutive stability: first state `storageEnergy=180000`, `terminalEnergy=30000` creates `terminal_offload(10000)`; simulate carrier completion by rerunning with `storageEnergy=190000`, `terminalEnergy=20000`; expect no energy task on the second run.
     - Feed still works: with `storageEnergy=200000`, `terminalEnergy=5000`, expect one `terminal_feed` task for `15000` energy.
     - Pending/reserved energy protection: adapt the existing pending-transfer reservation setup in `resourceControl.test.ts`; with storage below target and terminal energy that is above raw zero but not at least `terminalEnergyReserve + pending reservations + transferBatchSize`, expect no offload.
  4. Confirm at least the boundary/consecutive tests fail before implementation; save output to `.sisyphus/evidence/task-1-terminal-energy-jitter-red.log`.
  5. In `src/runtime/resourceControl.ts:createEnergyTerminalTask()`, compute terminal energy protected from offload before the offload condition:
     - keep `reservedTerminalEnergy = getReservedTerminalEnergyForPendingSends(room, snapshots)`;
     - define protected energy for offload as `room.terminalEnergyReserve + reservedTerminalEnergy`;
     - define true offloadable energy as `Math.max(0, room.terminalEnergy - protectedTerminalEnergy)`.
  6. Change the offload condition so it requires both:
     - `room.storageEnergy < room.energyTarget - room.transferBatchSize`;
     - `trueOffloadableTerminalEnergy >= room.transferBatchSize`.
  7. Pass `trueOffloadableTerminalEnergy` to `createTerminalOffloadTask()` instead of the old raw offloadable amount.
  8. Leave `createTerminalFeedTask()` behavior intact except for any variable movement required to compute `protectedTerminalEnergy`; do not add feed-side state or config.
  9. If an existing offload test expects offload from terminal reserve energy, update only its fixture numbers so terminal energy contains reserve plus at least one batch of surplus.
  10. Run targeted and full verification; save outputs to `.sisyphus/evidence/task-1-terminal-energy-jitter-green.log`, `.sisyphus/evidence/task-1-resourcecontrol-suite.log`, and `.sisyphus/evidence/task-1-terminal-energy-jitter-full-test.log`.

  **Must NOT do**:
  - Do not change carrier assignment or movement behavior.
  - Do not alter task board replacement semantics.
  - Do not introduce new persistent state or config fields.
  - Do not change non-energy terminal feed tasks.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: localized resource-control bugfix with established tests.
  - Skills: [`superpowers:test-driven-development`] - Needed because this bug has a clear red/green regression path.
  - Omitted: [`playwright`, `frontend-ui-ux`] - No UI/browser surface.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: F1-F4 | Blocked By: None

  **References** (executor has NO interview context - be exhaustive):
  - Bug Site: `src/runtime/resourceControl.ts:createEnergyTerminalTask` - binary feed/offload choice currently lacks reserve-protected surplus/deadband.
  - Task Publishing: `src/runtime/resourceControl.ts:syncTerminalFeedTasks` - publishes generated carrier tasks; do not modify.
  - Task Board: `src/runtime/carrierTaskBoard.ts:replaceCarrierTasksForProducerRoom` - replacement explains why task type flips affect carriers; do not modify.
  - Execution Context: `src/main.ts` - `runResourceControl()` publishes tasks before `creepWork`, so generated tasks affect same-tick carrier decisions.
  - Carrier Execution: `src/roles/carrier.ts` - carriers execute `terminal_feed`/`terminal_offload` board tasks; out of scope for this confirmed feed/offload flip.
  - Test Pattern: `src/runtime/resourceControl.test.ts` - existing terminal feed/offload task generation tests and room config helpers.
  - Test Pattern: `src/roles/carrier.test.ts` - carrier board-task execution tests; reference only if diagnosing unexpected behavior, not a planned edit.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy jitter"` fails before implementation and passes after implementation.
  - [ ] `npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy"` passes.
  - [ ] `npx jest src/runtime/resourceControl.test.ts` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] `npm run test` passes.
  - [ ] `git diff -- src/runtime/resourceControl.ts src/runtime/resourceControl.test.ts` shows only terminal energy decision tests and the `createEnergyTerminalTask()` offload guard.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Boundary state produces no shuttle task
    Tool: Bash
    Steps: npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy jitter.*boundary"
    Expected: Exit code 0; storage=195000 and terminal=22000 creates neither terminal_feed nor terminal_offload.
    Evidence: .sisyphus/evidence/task-1-terminal-energy-jitter-boundary.log

  Scenario: True surplus still offloads
    Tool: Bash
    Steps: npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy jitter.*true surplus"
    Expected: Exit code 0; storage=180000 and terminal=30000 creates terminal_offload for 10000 energy.
    Evidence: .sisyphus/evidence/task-1-terminal-energy-jitter-surplus.log

  Scenario: Consecutive sample does not flip to feed
    Tool: Bash
    Steps: npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy jitter.*consecutive"
    Expected: Exit code 0; after simulated offload completion to storage=190000 and terminal=20000, second run creates no energy task.
    Evidence: .sisyphus/evidence/task-1-terminal-energy-jitter-consecutive.log

  Scenario: Terminal refill still happens when reserve is low
    Tool: Bash
    Steps: npx jest src/runtime/resourceControl.test.ts --testNamePattern="terminal energy jitter.*feed"
    Expected: Exit code 0; storage=200000 and terminal=5000 creates terminal_feed for 15000 energy.
    Evidence: .sisyphus/evidence/task-1-terminal-energy-jitter-feed.log

  Scenario: Full resource control suite remains green
    Tool: Bash
    Steps: npx jest src/runtime/resourceControl.test.ts
    Expected: Exit code 0; no resourceControl regression.
    Evidence: .sisyphus/evidence/task-1-resourcecontrol-suite.log
  ```

  **Commit**: NO | Message: `fix(resource): stabilize terminal energy tasks` | Files: `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Do not commit unless the user explicitly asks for a commit after implementation.
- If the user asks for a commit, use: `fix(resource): stabilize terminal energy tasks`.
- Include only `src/runtime/resourceControl.ts` and `src/runtime/resourceControl.test.ts`.

## Success Criteria
- Terminal reserve energy is no longer offloaded to storage just because storage is slightly below target.
- `terminal_offload` only appears when storage has a meaningful deficit and terminal has surplus above reserve/reservations.
- `terminal_feed` still appears when terminal energy is genuinely below desired reserve/fee budget.
- Consecutive resourceControl samples around the boundary do not alternate feed/offload tasks.
- Targeted resourceControl tests, TypeScript check, and full Jest suite pass.

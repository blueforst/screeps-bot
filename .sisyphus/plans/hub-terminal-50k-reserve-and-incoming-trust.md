# Hub Terminal 50k Reserve And Incoming Trust

## TL;DR
> **Summary**: Fix the hub production stall by making terminals keep a 50k energy buffer for send/receive, offloading terminal overflow above 250k to storage while protecting pending send staging, and stopping hub planning from trusting blocked incoming resources as available inventory.
> **Deliverables**:
> - Terminal energy reserve default becomes 50,000.
> - Terminal non-energy overflow above 250,000 is moved to storage, except amounts reserved for pending sends.
> - Hub planner excludes blocked pending incoming tasks from production-chain availability.
> - TDD coverage across resourceControl, resourceTransferTasks, hubPlanner, and hub production integration.
> **Effort**: Medium
> **Parallel**: YES - 3 waves
> **Critical Path**: Task 1 → Tasks 2/3 → Task 4 → Task 5

## Context
### Original Request
- “hub的termina应该预留50k用于发送物资到其他房间. termianl的资源可以先搬到storage存储”
- “预留50k用于发送和接收”
- “terminal大于250k的部分移到storage中存储”
- “有发送任务时允许发送任务的部分大于250k”

### Interview Summary
- User observed hub terminal appears to have enough base resources, but production remains idle.
- Live shard1 data showed hub `E4N58` in `status="distributing"`, `activeProduct=null`, `missingResources=[]`, with many pending `hub:import:*` and `hub:reclaim:*` tasks and no `hub:export:*` tasks.
- Pending incoming tasks included `lastError="insufficient_terminal_resource_or_fee"`, so resources counted by planning were not actually arriving.
- User clarified terminal policy: keep 50k energy for send/receive, use storage as backing inventory, keep terminal total store under 250k unless pending send staging requires more.

### Metis Review (gaps addressed)
- Metis confirmed the core stall chain: pending incoming tasks remain `pending`, `getIncomingResourceTransferAmount()` counts them all, `planHubChains()` merges them into available inventory, and hub status becomes `distributing` with no active product.
- Metis identified existing generic offload infrastructure: `createTerminalOffloadTask()` already accepts any `ResourceConstant`.
- Metis warned against changing task lifecycle/statuses or main loop order.
- Metis suggested hub-only reserve, but this plan supersedes that with the later user clarification “预留50k用于发送和接收”; reserve becomes the default terminal policy so all terminals maintain send/receive buffer.
- Metis suggested an age threshold for stale errored incoming tasks; this plan instead filters currently blocked incoming tasks by `lastError`, because live data shows blocked tasks are updated repeatedly, so age based on `updatedAt` would not reliably identify them.

## Work Objectives
### Core Objective
Restart hub production decisions by making terminal logistics realistic: terminal energy must support send/receive, terminal capacity should be managed by storage offload, and hub chain planning must not treat currently blocked incoming transfers as already available.

### Deliverables
- `src/runtime/resourceControl.ts` terminal reserve and overflow-offload behavior.
- `src/runtime/logistics/resourceTransferTasks.ts` incoming trust filter.
- Tests in `src/runtime/resourceControl.test.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`, `src/runtime/hubPlanner.test.ts`, and `src/runtime/hubProductionIntegration.test.ts`.
- Verification evidence for targeted tests, full Jest, TypeScript, and build.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/hubPlanner.test.ts src/runtime/hubProductionIntegration.test.ts` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- `npm run build` exits 0.
- Static search confirms no changes to main loop order and no new resource transfer task statuses.

### Must Have
- Default terminal energy reserve is `50_000` for send/receive buffer.
- Terminal energy offload does not drain below `terminalEnergyReserve + reservedTerminalEnergy`.
- Terminal non-energy overflow above total terminal store cap `250_000` is offloaded to storage.
- Pending outbound send staging is protected: resources needed by pending sends may cause terminal total store to exceed `250_000` and must not be offloaded.
- Hub planner does not count pending incoming tasks with `lastError="insufficient_terminal_resource_or_fee"` or `lastError="remaining_below_transfer_min"` as available chain resources.
- Healthy pending incoming tasks with no blocking `lastError` still count, preserving deduplication and avoiding overproduction.

### Must NOT Have
- Do not change main loop order (`hubPlanner` → `synthesisControl` → `resourceControl`).
- Do not add a new `ResourceTransferTaskStatus`.
- Do not add retry limits or fail pending tasks in `executeTransferTasks()`.
- Do not change market selling/buying strategy.
- Do not change lab reaction target list or T3 production goals.
- Do not touch hub visual rendering.
- Do not hard-code room names such as `E4N58`.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD with Jest.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave is acceptable here because the work is bounded and dependency-heavy.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: Task 1 (terminal 50k reserve)
Wave 2: Task 2 (incoming trust filter) and Task 3 (250k terminal overflow offload) in parallel after Task 1
Wave 3: Task 4 (hub production integration) and Task 5 (full verification)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 2, 3 |
| 2 | 1 | 4, 5 |
| 3 | 1 | 4, 5 |
| 4 | 2, 3 | 5 |
| 5 | 4 | F1-F4 |
| F1-F4 | 5 | Completion |

### Agent Dispatch Summary (wave → task count → categories)
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 2 | unspecified-high, unspecified-high |
| 3 | 2 | deep, unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Set terminal energy reserve default to 50k with feed/offload regression tests

  **What to do**: In `src/runtime/resourceControl.ts`, change `DEFAULT_ROOM_CONFIG.terminalEnergyReserve` from `20_000` to `50_000`. Add TDD coverage in `src/runtime/resourceControl.test.ts` proving default snapshots use 50k, per-room overrides still work, terminal feed stages reserve + pending send fee budget, and energy offload never drains below `terminalEnergyReserve + reservedTerminalEnergy`.
  **Must NOT do**: Do not add hub-room special cases. Do not change `energyFloor`, `energyTarget`, or `energyExportStart`. Do not alter `computeSendAmount()` semantics except through the existing reserve value.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: One default value plus focused existing tests.
  - Skills: [] - Existing Jest patterns are enough.
  - Omitted: [`librarian`] - No external API research needed.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3] | Blocked By: []

  **References**:
  - Code: `src/runtime/resourceControl.ts:100-125` - `DEFAULT_ROOM_CONFIG` including `terminalEnergyReserve`.
  - Code: `src/runtime/resourceControl.ts:383-421` - `getEnergyAvailableForFees()` and `computeSendAmount()` fee budget.
  - Code: `src/runtime/resourceControl.ts:809-850` - `getReservedTerminalEnergyForPendingSends()` and `createEnergyTerminalTask()`.
  - Test pattern: `src/runtime/resourceControl.test.ts` `createRoom()` helper and terminal energy jitter/reserve tests.

  **Acceptance Criteria**:
  - [ ] New test `uses 50000 terminalEnergyReserve by default for send and receive buffer` passes.
  - [ ] New test `keeps per-room terminalEnergyReserve override behavior` passes with an override such as `10_000`.
  - [ ] New test `feeds terminal to 50000 reserve plus pending send fee budget` passes.
  - [ ] New or updated test `does not offload terminal energy protected by 50000 reserve and pending sends` passes.
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "terminalEnergyReserve"` exits 0.

  **QA Scenarios**:
  ```
  Scenario: Default terminal reserve is 50k
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "50000 terminalEnergyReserve"`.
    Expected: Test proves default room config uses 50,000 and non-overridden rooms inherit it.
    Evidence: .sisyphus/evidence/task-1-terminal-reserve-default.log

  Scenario: Terminal energy feed/offload respects send and receive reserve
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "pending send fee budget"`.
    Expected: Feed task stages reserve + fee budget; offload does not reduce terminal below protected amount.
    Evidence: .sisyphus/evidence/task-1-terminal-reserve-feed-offload.log
  ```

  **Commit**: NO | Message: `fix(resource): reserve 50k terminal energy` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 2. Exclude blocked pending incoming transfers from hub planning availability

  **What to do**: In `src/runtime/logistics/resourceTransferTasks.ts`, update `getIncomingResourceTransferAmount(roomName, resource)` so it sums only pending incoming tasks that are still trustworthy. Exclude pending tasks whose `lastError` is exactly `"insufficient_terminal_resource_or_fee"` or `"remaining_below_transfer_min"`. Keep pending tasks with no `lastError` counted. Keep terminal cooldown or temporary busy errors counted unless they use one of the two exact blocking strings above. Add tests in `src/runtime/logistics/resourceTransferTasks.test.ts` and `src/runtime/hubPlanner.test.ts`.
  **Must NOT do**: Do not change task lifecycle, statuses, cleanup TTL, or `executeTransferTasks()`. Do not change `planHubChains()`; fix the data source used by planners.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Shared utility affects planner and resource control consumers.
  - Skills: [] - Existing tests and source references are sufficient.
  - Omitted: [`git-master`] - Commit happens after all tasks.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [4, 5] | Blocked By: [1]

  **References**:
  - Code: `src/runtime/logistics/resourceTransferTasks.ts:188-196` - current `getIncomingResourceTransferAmount()` sums all pending incoming.
  - Code: `src/runtime/hubPlanner.ts:534-543` - `runHubPlanner()` reads incoming resources through this utility.
  - Code: `src/runtime/hubPlanner.ts:144-232` - `planHubChains()` merges incoming into available.
  - Test pattern: `src/runtime/logistics/resourceTransferTasks.test.ts` task store CRUD/counter tests.
  - Test pattern: `src/runtime/hubPlanner.test.ts:100-130` - incoming resources reduce demand behavior.

  **Acceptance Criteria**:
  - [ ] New test `getIncomingResourceTransferAmount excludes pending task blocked by insufficient terminal resource or fee` returns 0 for matching `lastError`.
  - [ ] New test `getIncomingResourceTransferAmount excludes pending task below transfer minimum` returns 0 for `lastError="remaining_below_transfer_min"`.
  - [ ] New test `getIncomingResourceTransferAmount includes healthy pending incoming task` returns `remainingAmount` when `lastError` is absent.
  - [ ] New test `hub planner treats blocked incoming resources as unavailable` proves a blocked pending import does not clear `missingResources` or production demand.
  - [ ] Existing tests that rely on healthy pending imports reducing demand still pass.

  **QA Scenarios**:
  ```
  Scenario: Blocked incoming is not trusted
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/logistics/resourceTransferTasks.test.ts -t "blocked"`.
    Expected: Incoming amount excludes `insufficient_terminal_resource_or_fee` and `remaining_below_transfer_min` pending tasks.
    Evidence: .sisyphus/evidence/task-2-blocked-incoming-filter.log

  Scenario: Hub planner restarts production/blocking decisions when incoming is blocked
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubPlanner.test.ts -t "blocked incoming"`.
    Expected: Blocked incoming resources are unavailable to chain planning; healthy pending incoming still counts.
    Evidence: .sisyphus/evidence/task-2-hubplanner-blocked-incoming.log
  ```

  **Commit**: NO | Message: `fix(hub): ignore blocked incoming resource transfers` | Files: [`src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`, `src/runtime/hubPlanner.test.ts`]

- [x] 3. Offload terminal overflow above 250k while protecting pending send staging

  **What to do**: In `src/runtime/resourceControl.ts`, extend `syncTerminalFeedTasks()` to create `terminal_offload` carrier tasks for non-energy terminal resources when effective terminal total exceeds `250_000`. Effective total equals terminal used capacity minus the amount of terminal resources protected for pending outbound sends. For each non-energy resource, protect `min(terminalAmount, pendingOutgoingAmountForResource)`. Offload only `max(0, terminalAmount - protectedAmount)` and only while effective total remains above `250_000`. Use existing `createTerminalOffloadTask()` and existing `transferBatchSize`/storage free capacity caps.
  **Must NOT do**: Do not offload energy in this new path; energy remains governed by `createEnergyTerminalTask()`. Do not offload resources needed by pending sends. Do not create new carrier task types. Do not bypass storage free capacity.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Multi-resource logistics logic with edge cases.
  - Skills: [] - Existing resourceControl tests cover patterns.
  - Omitted: [`frontend-ui-ux`] - Runtime logistics only.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [4, 5] | Blocked By: [1]

  **References**:
  - Code: `src/runtime/resourceControl.ts:667-730` - `createTerminalFeedTask()` and generic `createTerminalOffloadTask()`.
  - Code: `src/runtime/resourceControl.ts:852-905` - `syncTerminalFeedTasks()` current pending-transfer feed/offload loop.
  - Code: `src/runtime/carrierTaskBoard.ts:1-2` - existing `terminal_offload` task type.
  - Test pattern: `src/runtime/resourceControl.test.ts` terminal feed/offload and carrier task board assertions.

  **Acceptance Criteria**:
  - [ ] New constant or local policy value `TERMINAL_TOTAL_STORAGE_CAP = 250_000` exists in `resourceControl.ts` with no config schema change.
  - [ ] New test `offloads non-energy terminal overflow above 250000 to storage` creates terminal_offload for excess non-energy resource.
  - [ ] New test `does not offload pending outbound send staging even when terminal exceeds 250000` protects resource amounts needed by pending sends.
  - [ ] New test `offloads only amount above pending send protection` keeps protected amount and offloads surplus of the same resource if present.
  - [ ] New test `caps overflow offload by storage free capacity and transferBatchSize` passes.
  - [ ] No new offload task is created when effective terminal total is exactly `250_000` or lower.

  **QA Scenarios**:
  ```
  Scenario: Terminal overflow moves to storage
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "terminal overflow"`.
    Expected: Terminal over 250k creates `terminal_offload` for non-energy surplus and respects storage capacity/batch caps.
    Evidence: .sisyphus/evidence/task-3-terminal-overflow-offload.log

  Scenario: Pending send staging may exceed 250k
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "pending outbound send staging"`.
    Expected: Resource required by pending outbound send is not offloaded even if terminal total remains above 250k.
    Evidence: .sisyphus/evidence/task-3-pending-send-protection.log
  ```

  **Commit**: NO | Message: `fix(resource): offload terminal overflow to storage` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 4. Add hub production integration regression for blocked incoming and terminal policy

  **What to do**: Add integration coverage in `src/runtime/hubProductionIntegration.test.ts` or the integration section of `src/runtime/hubPlanner.test.ts` proving the complete stall is fixed. Scenario: hub lacks a base resource for target production, a pending incoming task for that resource exists but has `lastError="insufficient_terminal_resource_or_fee"`, and after `runHubPlanner()` the hub must not enter `distributing` solely because of that blocked incoming. Also verify terminal 250k overflow policy does not remove resources staged for a pending hub export.
  **Must NOT do**: Do not require live Screeps API or manual console checks. Do not assert visual output.

  **Recommended Agent Profile**:
  - Category: `deep` - Reason: Cross-module runtime behavior and regression fidelity.
  - Skills: [] - Existing integration helpers are enough.
  - Omitted: [`playwright`] - No UI.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [5] | Blocked By: [2, 3]

  **References**:
  - Code: `src/main.ts:58-61` - main loop order: hubPlanner, synthesisControl, resourceControl.
  - Test pattern: `src/runtime/hubProductionIntegration.test.ts` hubPlanner → synthesisControl → statusHub pipeline.
  - Test pattern: `src/runtime/hubPlanner.test.ts:1476-1625` full lifecycle hub flag/planner/synthesis scenarios.
  - Live scenario: hub `E4N58` was `distributing` with `activeProduct=null` while pending imports/reclaims had terminal/fee blockage.

  **Acceptance Criteria**:
  - [ ] New integration test `hub planner does not enter distributing from blocked pending incoming resources` passes.
  - [ ] Test proves `Memory.runtime.hub.status` is `blocked` or `importing` with an active synthesis step, not `distributing`, when only blocked incoming would satisfy demand.
  - [ ] Test proves a healthy pending incoming task still prevents duplicate demand and can keep the planner from overproducing.
  - [ ] Test proves pending hub export staging is not offloaded by the 250k terminal overflow rule.

  **QA Scenarios**:
  ```
  Scenario: Production does not stall on phantom incoming
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubProductionIntegration.test.ts -t "blocked pending incoming"`.
    Expected: Hub no longer reports distributing/no-active-product when the only satisfying resource is a blocked incoming task.
    Evidence: .sisyphus/evidence/task-4-production-blocked-incoming.log

  Scenario: Export staging survives terminal cap
    Tool: Bash
    Steps: Run integration or resourceControl test matching pending hub export with terminal total above 250k.
    Expected: The resource amount needed by `hub:export:*` remains in terminal; only non-protected surplus is offloaded.
    Evidence: .sisyphus/evidence/task-4-export-staging-cap.log
  ```

  **Commit**: NO | Message: `test(hub): cover terminal policy production stall` | Files: [`src/runtime/hubProductionIntegration.test.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 5. Run full verification, scope audit, and update plan state

  **What to do**: Run targeted test files, full test suite, TypeScript, and build. Perform static scope checks. Fix only issues directly caused by Tasks 1-4. Confirm no main-loop, market, visual, or task lifecycle scope creep.
  **Must NOT do**: Do not deploy or commit before final verification wave. Do not edit unrelated files.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Cross-module verification and cleanup.
  - Skills: [] - Verification commands are explicit.
  - Omitted: [`git-master`] - Commit happens after final wave/user approval.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1-F4] | Blocked By: [4]

  **References**:
  - Commands from `AGENTS.md`: `npx tsc --noEmit`, `npm run test`, `npm run build`.
  - Scope files: `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`, `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`, `src/runtime/hubPlanner.test.ts`, `src/runtime/hubProductionIntegration.test.ts`.

  **Acceptance Criteria**:
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/hubPlanner.test.ts src/runtime/hubProductionIntegration.test.ts` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] Search confirms no changes to `src/main.ts`, hub visuals, market-only modules, or autoplanner files.
  - [ ] Search confirms no new `ResourceTransferTaskStatus` value and no retry/fail lifecycle logic added to `executeTransferTasks()`.

  **QA Scenarios**:
  ```
  Scenario: Full automated verification
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/hubPlanner.test.ts src/runtime/hubProductionIntegration.test.ts && npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-5-full-verification.log

  Scenario: Scope guard verification
    Tool: Bash / Grep / AST-grep
    Steps: Search changed files and forbidden paths; inspect git diff stat excluding `.sisyphus`.
    Expected: Only planned runtime/test files changed; no main loop, market strategy, visuals, autoplanner, or task-status lifecycle changes.
    Evidence: .sisyphus/evidence/task-5-scope-audit.txt
  ```

  **Commit**: NO | Message: `chore(hub): verify terminal logistics planning fix` | Files: [verification evidence only]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- One atomic commit after verification:
  - `fix(hub): stabilize terminal logistics planning`
  - Files: resourceControl, resourceTransferTasks, hubPlanner/hubProduction tests.
- Do not commit `.sisyphus/` evidence unless repository policy requires it during `/start-work` orchestration.

## Success Criteria
- Hub planning no longer idles in `distributing` only because blocked pending imports/reclaims are counted as available.
- Terminals keep 50k energy buffer for send/receive.
- Terminal total store above 250k is drained into storage through carrier offload tasks.
- Pending send staging can exceed the 250k terminal cap and is not offloaded prematurely.
- Full automated verification passes.

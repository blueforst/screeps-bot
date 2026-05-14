# T3 Distribution Blockers Fix

## TL;DR
> **Summary**: Fix hub T3 distribution getting stuck when hubPlanner creates exact reserve top-up tasks below the global transfer minimum. Keep global transfer behavior unchanged while allowing hub export T3 top-ups above a hub-specific floor.
> **Deliverables**:
> - Hub export minimum-send policy in `src/runtime/resourceControl.ts`
> - Regression tests in `src/runtime/resourceControl.test.ts`
> - Verification evidence proving full tests/typecheck pass
> **Effort**: Short
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4

## Context
### Original Request
- User asked why T3 was not distributing, then said: `修复问题`.

### Interview Summary
- Live shard1 Memory showed hub enabled in `E4N58` and `Memory.runtime.hub.status = "distributing"`.
- Two pending hub exports existed:
  - `XGHO2 E4N58 -> E3N59`, `remainingAmount = 350`, `lastError = "remaining_below_transfer_min"`.
  - `XUHO2 E4N58 -> E7N58`, `remainingAmount = 1000`, `lastError = "insufficient_terminal_resource_or_fee"`.
- Code analysis found `hubPlanner` intentionally creates exact shortage tasks, while `resourceControl` refuses sends below room `transferMinAmount` (default `1000`).

### Metis Review (gaps addressed)
- There are two minimum-enforcement sites: `executeTransferTasks()` pre-check and `computeSendAmount()` internal candidate loop; both must use the same hub-specific minimum.
- Do not lower the global `transferMinAmount` default.
- Use a hub-specific floor to prevent wasteful tiny terminal sends. Default applied: `HUB_EXPORT_MIN_SEND_AMOUNT = 100`.
- Do not change terminal feed logic; pending hub exports are already visible to `syncTerminalFeedTasks()`.
- Treat `XUHO2 insufficient_terminal_resource_or_fee` as terminal availability/fee state, not the same as the sub-1000 minimum bug; add coverage that hub exports are terminal-fed when resource is in storage.

## Work Objectives
### Core Objective
Allow hub-managed T3 export tasks to execute exact reserve top-ups below the global 1000 transfer minimum when the remaining amount is at least the hub export floor, while preserving existing minimum blocking for non-hub transfers.

### Deliverables
- Production change in `src/runtime/resourceControl.ts` only.
- Regression tests in `src/runtime/resourceControl.test.ts`.
- Evidence files under `.sisyphus/evidence/`.

### Definition of Done (verifiable conditions with commands)
- `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand` passes.
- `npm run test` passes.
- `npx tsc --noEmit` passes.
- Hub export task `remainingAmount=350`, reason `hub:export:XGHO2`, sends successfully when terminal has resource and fee energy.
- Non-hub task below global `transferMinAmount` still blocks with `remaining_below_transfer_min`.
- Pending hub export with T3 in storage and terminal empty still creates a `terminal_feed` carrier task.

### Must Have
- Add `const HUB_EXPORT_MIN_SEND_AMOUNT = 100` in `src/runtime/resourceControl.ts` near existing transfer constants.
- Add a helper such as `getTransferTaskMinAmount(task: ResourceTransferTask, donor: ResourceControlSnapshot): number`.
- For `task.reason?.startsWith("hub:export:")`, return `Math.min(donor.transferMinAmount, HUB_EXPORT_MIN_SEND_AMOUNT)`.
- For all other tasks, return `donor.transferMinAmount`.
- Use this task-specific minimum in both:
  - `executeTransferTasks()` below-min pre-check at `src/runtime/resourceControl.ts:618-623`.
  - `computeSendAmount()` candidate check and fee-halving loop at `src/runtime/resourceControl.ts:403-419`.
- Preserve existing priority ordering and anti-deadlock guard.

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- Do not change `src/runtime/hubPlanner.ts` exact-shortage task creation.
- Do not change global `DEFAULT_ROOM_CONFIG.transferMinAmount = 1000`.
- Do not change `computeTransferAmount()` energy balancing minimum logic.
- Do not change `syncTerminalFeedTasks()` unless a test proves it is broken.
- Do not change carrier movement, carrier task board semantics, market behavior, synthesisControl chemistry, or hub target compounds.
- Do not mutate live Screeps Memory as part of implementation.
- Do not commit unless user explicitly asks.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with existing Jest/ts-jest framework.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

## Execution Strategy
### Parallel Execution Waves
> Sequential because all tasks touch `resourceControl.ts` / `resourceControl.test.ts` and build on the same test matrix.

Wave 1: Task 1 (`quick`) — add RED/green-target regression tests for hub export minimum policy.
Wave 2: Task 2 (`quick`) — implement hub export minimum-send policy.
Wave 3: Task 3 (`quick`) — add terminal feed and insufficient-resource coverage for hub exports.
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

- [x] 1. Add hub export minimum-policy regression tests

  **What to do**:
  - Open `src/runtime/resourceControl.test.ts`.
  - In or near `describe("executeTransferTasks hub-aware priority ordering", ...)`, add tests for the current T3 blocker policy.
  - Add these exact tests:
    1. `hub export below global transfer minimum sends when above hub floor`
       - Donor hub room terminal has `RESOURCE_ENERGY: 20_000` and `RESOURCE_CATALYZED_GHODIUM_ALKALIDE: 500`.
       - Receiver room exists with terminal.
       - Create task `createResourceTransferTask(hub.name, receiver.name, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 350, "hub:export:XGHO2")`.
       - Run `runResourceControl()`.
       - Expected after implementation: donor terminal sends `350`, task becomes `done` with `remainingAmount=0`.
    2. `non-hub transfer below global minimum still blocks`
       - Same resource and amount `500`, but reason `"test:below-min"`.
       - Run `runResourceControl()`.
       - Expected: no `terminal.send`, task remains `pending`, `lastError="remaining_below_transfer_min"`.
    3. `hub export below hub floor remains blocked`
       - Hub export amount `30`, reason `"hub:export:XGHO2"`.
       - Expected: no send, task remains `pending`, `lastError="remaining_below_transfer_min"`.
    4. `hub export at global minimum still sends normally`
       - Hub export amount `1000`, terminal has `XGHO2: 1000` and enough energy.
       - Expected: send amount `1000`, task done.
  - It is acceptable for tests 1 and 3 to fail before Task 2 if running in RED mode; do not weaken assertions.
  - Save targeted output to `.sisyphus/evidence/task-1-t3-hub-export-minimum-red.txt` if RED, or `...-green.txt` if implementation already exists.

  **Must NOT do**:
  - Do not edit production code in this task unless TypeScript cannot compile because of test helper usage.
  - Do not change existing test expectations.
  - Do not lower `transferMinAmount` in config.

  **Recommended Agent Profile**:
  - Category: `quick` - Focused test additions in one file.
  - Skills: `[]` - Existing Jest patterns are local.
  - Omitted: `playwright` - No UI/browser behavior.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2, 3 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Policy mismatch: `src/runtime/hubPlanner.ts:397-408` creates exact shortage hub export tasks.
  - Global pre-check: `src/runtime/resourceControl.ts:618-623` blocks remaining below `transferMinAmount`.
  - Internal send minimum: `src/runtime/resourceControl.ts:403-419` blocks/halves by `transferMinAmount`.
  - Existing priority tests: `src/runtime/resourceControl.test.ts:1093-1219`.
  - Existing below-min behavior tests: search `remaining_below_transfer_min` in `src/runtime/resourceControl.test.ts`.

  **Acceptance Criteria** (agent-executable only):
  - [ ] New tests exist with amounts `350`, `500`, `30`, and `1000`.
  - [ ] Non-hub below-min test passes after implementation and proves global behavior unchanged.
  - [ ] Targeted command output is saved under `.sisyphus/evidence/`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Hub export 350 regression
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "hub export below global transfer minimum"`.
    Expected: After Task 2, exit code 0 and terminal send called with XGHO2 amount 350.
    Evidence: .sisyphus/evidence/task-1-hub-export-350.txt

  Scenario: Non-hub below-min guard
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "non-hub transfer below global minimum"`.
    Expected: Exit code 0; non-hub task remains pending with `remaining_below_transfer_min`.
    Evidence: .sisyphus/evidence/task-1-non-hub-below-min.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/resourceControl.test.ts`]

- [x] 2. Implement hub export minimum-send policy

  **What to do**:
  - Open `src/runtime/resourceControl.ts`.
  - Add `const HUB_EXPORT_MIN_SEND_AMOUNT = 100;` near `DEFAULT_TASK_MAX_PER_RUN` and `TERMINAL_TOTAL_STORAGE_CAP` constants.
  - Add helper functions near `computeSendAmount()`:
    - `function isHubExportTask(task: ResourceTransferTask): boolean { return task.reason?.startsWith("hub:export:") === true; }`
    - `function getTransferTaskMinAmount(task: ResourceTransferTask, donor: ResourceControlSnapshot): number { return isHubExportTask(task) ? Math.min(donor.transferMinAmount, HUB_EXPORT_MIN_SEND_AMOUNT) : donor.transferMinAmount; }`
  - Change `computeSendAmount(...)` signature to accept `minAmount = donor.transferMinAmount` as a fifth parameter.
  - Replace the two internal uses of `donor.transferMinAmount` that enforce minimum send size with `minAmount`:
    - `if (candidate < minAmount) return 0;`
    - `while (candidate >= minAmount) { ... }`
  - In `executeTransferTasks()`, after donor/receiver are resolved and before the below-min check, compute `const taskMinAmount = getTransferTaskMinAmount(task, donor);`.
  - Replace `if (task.remainingAmount < donor.transferMinAmount)` with `if (task.remainingAmount < taskMinAmount)`.
  - Pass `taskMinAmount` to `computeSendAmount(...)`.
  - Run targeted tests from Task 1 until they pass; save output to `.sisyphus/evidence/task-2-t3-hub-export-minimum-green.txt`.

  **Must NOT do**:
  - Do not change `computeTransferAmount()`.
  - Do not change `DEFAULT_ROOM_CONFIG.transferMinAmount`.
  - Do not change transfer priority ordering or anti-deadlock same-resource guard.
  - Do not change hubPlanner exact shortage logic.

  **Recommended Agent Profile**:
  - Category: `quick` - Surgical production change plus existing focused tests.
  - Skills: `[]` - TypeScript/Jest only.
  - Omitted: `playwright` - No UI/browser behavior.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 3, 4 | Blocked By: 1

  **References** (executor has NO interview context - be exhaustive):
  - Constants: `src/runtime/resourceControl.ts:90-107`.
  - `computeSendAmount()`: `src/runtime/resourceControl.ts:388-421`.
  - `executeTransferTasks()`: `src/runtime/resourceControl.ts:547-665`.
  - Metis guardrail: both pre-check and `computeSendAmount()` must use same task-specific minimum.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "hub export below global transfer minimum|non-hub transfer below global minimum|hub export below hub floor|hub export at global minimum"` passes.
  - [ ] `npx tsc --noEmit` passes.
  - [ ] Diff in production is limited to `src/runtime/resourceControl.ts`.
  - [ ] Global transfer minimum remains `1000` in `DEFAULT_ROOM_CONFIG`.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Hub export exact top-up sends
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "hub export below global transfer minimum sends"`.
    Expected: Exit code 0; task `hub:export:XGHO2` amount 350 is sent and completed.
    Evidence: .sisyphus/evidence/task-2-hub-export-exact-topup.txt

  Scenario: Tiny hub export is not wastefully sent
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "hub export below hub floor"`.
    Expected: Exit code 0; amount 30 remains pending with `remaining_below_transfer_min`.
    Evidence: .sisyphus/evidence/task-2-hub-export-floor.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 3. Verify terminal feed path for pending hub exports

  **What to do**:
  - In `src/runtime/resourceControl.test.ts`, add or adjust tests around `describe("terminal feed respects TERMINAL_TOTAL_STORAGE_CAP", ...)`.
  - Add `pending hub export feeds T3 from storage to terminal when terminal is empty`:
    - Hub room storage has `RESOURCE_CATALYZED_UTRIUM_ALKALIDE: 1000` and `RESOURCE_ENERGY: 200000`.
    - Hub terminal has `RESOURCE_ENERGY: 25000` and zero XUHO2.
    - Receiver room exists.
    - Create `createResourceTransferTask(hub.name, receiver.name, RESOURCE_CATALYZED_UTRIUM_ALKALIDE, 1000, "hub:export:XUHO2")`.
    - Run `runResourceControl()`.
    - Assert carrier task board contains `resourceControl:terminal_feed:<hub>:XUHO2` with `type="terminal_feed"`, from storage to terminal, amount `1000` or capped by available feed capacity.
  - Add `pending hub export feed is capped by terminal total capacity` if no equivalent existing test covers hub reason specifically:
    - Terminal total `249500`, storage has XUHO2 `1000`, pending hub export `1000`.
    - Expected feed amount `500`.
  - Do not change `syncTerminalFeedTasks()` unless these tests fail for a real bug.
  - Save targeted output to `.sisyphus/evidence/task-3-t3-terminal-feed.txt`.

  **Must NOT do**:
  - Do not change carrier movement or task board semantics.
  - Do not bypass terminal total capacity cap.
  - Do not require live Screeps console verification for task completion.

  **Recommended Agent Profile**:
  - Category: `quick` - Focused tests in one subsystem.
  - Skills: `[]` - Jest only.
  - Omitted: `playwright` - No UI/browser behavior.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: 4 | Blocked By: 2

  **References** (executor has NO interview context - be exhaustive):
  - Feed logic: `src/runtime/resourceControl.ts:859-956`.
  - Feed task helper: `src/runtime/resourceControl.ts:667-696`.
  - Existing feed-cap tests: `src/runtime/resourceControl.test.ts:2566-2710`.
  - Live blocker to explain: XUHO2 hub export had `lastError="insufficient_terminal_resource_or_fee"`; if XUHO2 is in storage, terminal feed should move it to terminal before send.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "pending hub export feeds T3"` passes.
  - [ ] Test proves pending `hub:export:XUHO2` creates `terminal_feed` when XUHO2 is in storage and terminal is empty.
  - [ ] No production feed logic changes unless required by failing test.

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: Hub export resource in storage feeds terminal
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "pending hub export feeds T3"`.
    Expected: Exit code 0; carrier task `resourceControl:terminal_feed:<hub>:XUHO2` exists with amount 1000.
    Evidence: .sisyphus/evidence/task-3-hub-export-terminal-feed.txt

  Scenario: Terminal cap still limits feed
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand -t "hub export feed is capped"`.
    Expected: Exit code 0; feed amount is capped by remaining terminal total capacity.
    Evidence: .sisyphus/evidence/task-3-hub-export-feed-cap.txt
  ```

  **Commit**: NO | Message: n/a | Files: [`src/runtime/resourceControl.test.ts`, `src/runtime/resourceControl.ts` only if feed test reveals a bug]

- [x] 4. Run full verification and prepare live-safe evidence

  **What to do**:
  - Run verification in this order:
    1. `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts --runInBand`
    2. `npm run test`
    3. `npx tsc --noEmit`
  - Save outputs to:
    - `.sisyphus/evidence/task-4-resource-control.txt`
    - `.sisyphus/evidence/task-4-npm-test.txt`
    - `.sisyphus/evidence/task-4-tsc-noemit.txt`
  - Inspect diff with `git diff --stat -- src/` and confirm only intended files changed.
  - Optional read-only post-deploy verification script may inspect shard1 Memory for hub export task errors, but must not mutate Memory.
  - Do not deploy until final verification wave approval and explicit user okay if using standard `/start-work` flow.

  **Must NOT do**:
  - Do not run `npm run push` before final wave approval and user approval.
  - Do not commit unless user explicitly asks.
  - Do not change live Screeps Memory.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` - Verification and evidence capture.
  - Skills: `[]` - Shell verification only.
  - Omitted: `playwright` - No UI/browser behavior.

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: Final Verification | Blocked By: 3

  **References** (executor has NO interview context - be exhaustive):
  - Commands: `package.json:6-14`.
  - Project workflow: deploy with `npm run push` only after successful TypeScript/Jest verification and approval.
  - Secret guardrail: `.secret.json` contains credentials; never commit it.

  **Acceptance Criteria** (agent-executable only):
  - [ ] Targeted resourceControl Jest file passes.
  - [ ] Full Jest suite passes.
  - [ ] TypeScript no-emit passes.
  - [ ] Diff contains only `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`, and `.sisyphus/evidence/` files.

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
  - Verify hub export minimum override applies only to `hub:export:*` tasks.
  - Verify global non-hub minimum behavior remains unchanged.
- [x] F2. Code Quality Review — unspecified-high
  - Review helper naming, minimum-policy consistency, and absence of broad rewrites.
- [x] F3. Real Manual QA — unspecified-high
  - Execute targeted Jest, full Jest, and TypeScript commands.
  - Inspect evidence files and diff scope.
- [x] F4. Scope Fidelity Check — deep
  - Confirm no hubPlanner/synthesisControl/carrier/market scope creep.

## Commit Strategy
- Do not commit unless user explicitly asks.
- If asked to commit after approval, use semantic message: `fix(resource-control): allow small hub T3 exports`.
- Commit files should be limited to:
  - `src/runtime/resourceControl.ts`
  - `src/runtime/resourceControl.test.ts`
  - Evidence files only if repository convention requires tracking them.
- After final wave approval and user okay, deploy with `npm run push` per project workflow.

## Success Criteria
- Live-style `hub:export:XGHO2` with `remainingAmount=350` no longer gets permanently stuck behind global `transferMinAmount=1000`.
- Non-hub transfers below 1000 still block as before.
- Hub export tasks below 100 remain blocked to avoid wasteful tiny terminal sends.
- Pending hub exports for T3 in storage generate terminal feed tasks so terminal availability can recover naturally.
- Full Jest and TypeScript verification passes.

# Fix Terminal Cap Not Energy Reserve

## TL;DR
> **Summary**: Correct the deployed misunderstanding: `50k` is terminal free-space reserve, not terminal energy reserve. Restore terminal energy reserve to `20k`, keep the `250k` total terminal cap, count energy in that cap, and preserve blocked-incoming filtering.
> **Deliverables**:
> - `DEFAULT_ROOM_CONFIG.terminalEnergyReserve` restored to `20_000`.
> - Terminal cap tests define `250k` as total terminal used capacity including energy.
> - Overflow offload respects energy reserve/pending-fee protection and pending outbound send staging.
> - Existing blocked-incoming filter and hub production stall tests remain intact.
> **Effort**: Quick
> **Parallel**: NO
> **Critical Path**: Task 1 → Task 2 → Task 3

## Context
### Original Request
- User correction: “我没有说将terminal能量储备到50k”
- User clarification: “energy也是算在250k额度里的?”

### Interview Summary
- The deployed plan incorrectly changed `DEFAULT_ROOM_CONFIG.terminalEnergyReserve` from `20_000` to `50_000`.
- Correct interpretation: terminal should reserve `50k` free capacity for send/receive, meaning terminal total used capacity should normally be kept at or below `250_000` out of Screeps terminal capacity `300_000`.
- Energy counts toward the `250_000` total-store cap because the cap is based on terminal used capacity, not non-energy inventory only.
- Pending outbound send staging can exceed `250_000` and must be protected from offload.

### Metis Review (gaps addressed)
- Metis confirmed the correction is a targeted rollback of the energy-reserve default only.
- Metis identified affected tests that hard-code `50_000` energy-reserve assumptions.
- Metis warned to preserve two independent valid changes from the previous commit: terminal overflow cap and blocked incoming filter.
- This plan extends Metis guidance with the user’s latest clarification: energy is part of the `250k` cap and cap tests must prove that.

## Work Objectives
### Core Objective
Remove the incorrect “50k terminal energy reserve” behavior while keeping the correct “250k terminal total used capacity cap / 50k free capacity reserve” behavior.

### Deliverables
- `src/runtime/resourceControl.ts` energy-reserve default restored to `20_000`.
- `src/runtime/resourceControl.ts` terminal cap logic verified/corrected so energy counts toward the `250_000` overflow calculation.
- `src/runtime/resourceControl.test.ts` tests updated away from `terminalEnergyReserve default 50000` and toward `terminalEnergyReserve default 20000` plus 250k total-cap semantics.
- Full verification and deployment-ready commit.

### Definition of Done
- `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
- `npx jest --config jest.config.cjs src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/hubPlanner.test.ts` exits 0.
- `npx tsc --noEmit` exits 0.
- `npm run test` exits 0.
- `npm run build` exits 0.
- Grep confirms no `terminalEnergyReserve: 50_000` and no test names asserting default 50k energy reserve.

### Must Have
- Default terminal energy reserve is `20_000`.
- Terminal `250_000` cap is total used capacity including energy.
- If terminal is above `250_000`, offload may include energy only after preserving `terminalEnergyReserve + reservedTerminalEnergy`.
- Pending outbound send staging for any resource is protected and may keep terminal above `250_000`.
- Blocked incoming filter in `getIncomingResourceTransferAmount()` remains unchanged.

### Must NOT Have
- Do not revert `TERMINAL_TOTAL_STORAGE_CAP = 250_000`.
- Do not remove pending-send staging protection.
- Do not revert blocked incoming filter or its tests.
- Do not change hub production targets, market policy, main loop order, or resource transfer task lifecycle/statuses.
- Do not manually edit Screeps Memory.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: TDD/regression tests-after correction.
- QA policy: Every task has agent-executed scenarios.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
Wave 1: Task 1
Wave 2: Task 2
Wave 3: Task 3

### Dependency Matrix
| Task | Depends On | Blocks |
|------|------------|--------|
| 1 | None | 2 |
| 2 | 1 | 3 |
| 3 | 2 | F1-F4 |

### Agent Dispatch Summary
| Wave | Task Count | Categories |
|------|------------|------------|
| 1 | 1 | quick |
| 2 | 1 | unspecified-high |
| 3 | 1 | unspecified-high |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Restore terminal energy reserve default to 20k and update reserve tests

  **What to do**: Change `DEFAULT_ROOM_CONFIG.terminalEnergyReserve` in `src/runtime/resourceControl.ts` from `50_000` back to `20_000`. Update `src/runtime/resourceControl.test.ts` tests that were changed only because of the mistaken 50k energy-reserve assumption. Rename/remove the `terminalEnergyReserve default 50000` describe block and replace it with tests proving default `20_000` plus per-room override behavior.
  **Must NOT do**: Do not touch `TERMINAL_TOTAL_STORAGE_CAP`, overflow offload logic, blocked incoming filter, hubPlanner behavior, or task lifecycle code.

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: Mechanical rollback of one default and dependent assertions.
  - Skills: [] - Existing Jest tests are enough.
  - Omitted: [`librarian`] - No external docs needed.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2] | Blocked By: []

  **References**:
  - Code: `src/runtime/resourceControl.ts:99-105` - `TERMINAL_TOTAL_STORAGE_CAP` and `DEFAULT_ROOM_CONFIG.terminalEnergyReserve`.
  - Test: `src/runtime/resourceControl.test.ts` - search `terminalEnergyReserve default 50000`, `50000 terminalEnergyReserve`, and `50_000`.
  - Prior intended default: project behavior before commit `524ca13` used `terminalEnergyReserve: 20_000`.

  **Acceptance Criteria**:
  - [ ] `src/runtime/resourceControl.ts` has `terminalEnergyReserve: 20_000`.
  - [ ] No test describe/name claims default terminal energy reserve is 50k.
  - [ ] Tests verify default reserve is 20k and per-room overrides still work.
  - [ ] Energy feed/offload tests expect amounts derived from 20k reserve, not 50k.

  **QA Scenarios**:
  ```
  Scenario: Energy reserve default restored
    Tool: Bash
    Steps: Run `grep -R "terminalEnergyReserve: 50_000\|terminalEnergyReserve default 50000\|50000 terminalEnergyReserve" src/runtime/resourceControl.ts src/runtime/resourceControl.test.ts`.
    Expected: No matches.
    Evidence: .sisyphus/evidence/task-1-no-50k-energy-reserve.txt

  Scenario: Resource control tests pass with 20k reserve
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "terminalEnergyReserve"`.
    Expected: Targeted reserve tests pass and assert 20k default / override behavior.
    Evidence: .sisyphus/evidence/task-1-resource-control-reserve.log
  ```

  **Commit**: NO | Message: `fix(resource): restore terminal energy reserve default` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 2. Ensure the 250k terminal cap counts energy and protects energy reserve

  **What to do**: Verify/correct `syncTerminalFeedTasks()` overflow logic so `terminal.store.getUsedCapacity()` determines overflow and therefore energy counts toward the `250_000` cap. If the terminal is above cap and only energy is offloadable, create energy offload only for energy above `terminalEnergyReserve + reservedTerminalEnergy`, capped by overflow, storage free capacity, and `transferBatchSize`. Keep non-energy pending-send protection unchanged.
  **Must NOT do**: Do not treat `250_000` as non-energy-only. Do not drain energy below `20_000 + pending send fee reserve`. Do not offload staged resources required by pending outbound sends.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Runtime logistics edge cases across energy/non-energy resources.
  - Skills: [] - Existing tests and code are sufficient.
  - Omitted: [`frontend-ui-ux`] - Runtime only.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [3] | Blocked By: [1]

  **References**:
  - Code: `src/runtime/resourceControl.ts:898-921` - current terminal overflow offload block.
  - Code: `src/runtime/resourceControl.ts:809-850` - `getReservedTerminalEnergyForPendingSends()` and `createEnergyTerminalTask()` energy reserve protection.
  - Test: `src/runtime/resourceControl.test.ts` `terminal overflow offload above 250k` block.

  **Acceptance Criteria**:
  - [ ] Test `energy counts toward terminal 250000 cap` proves terminal `200k energy + 100k H` is over cap and offloads enough H/energy surplus toward cap.
  - [ ] Test `energy-only terminal overflow offloads only above protected energy` proves terminal `260k energy`, no pending sends, creates at most `transferBatchSize` energy offload while preserving 20k reserve.
  - [ ] Test `pending send fee reserve protects energy during cap offload` proves energy required for pending send fees is not offloaded even if terminal is above 250k.
  - [ ] Existing non-energy pending-send staging tests still pass.

  **QA Scenarios**:
  ```
  Scenario: Energy is part of the 250k terminal cap
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "energy counts toward terminal 250000 cap"`.
    Expected: Test passes and demonstrates total terminal used capacity includes energy.
    Evidence: .sisyphus/evidence/task-2-energy-counts-cap.log

  Scenario: Cap offload does not violate energy reserve
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts -t "protected energy"`.
    Expected: Energy offload never reduces terminal below `terminalEnergyReserve + reservedTerminalEnergy`.
    Evidence: .sisyphus/evidence/task-2-energy-protection.log
  ```

  **Commit**: NO | Message: `fix(resource): count energy in terminal capacity cap` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

- [x] 3. Full regression verification and deploy-ready review

  **What to do**: Run targeted tests, full suite, typecheck, build, and scope searches. Confirm the correction reverts only the energy-reserve misunderstanding while preserving the terminal cap and blocked-incoming fix.
  **Must NOT do**: Do not deploy until final verification wave approves. Do not include unrelated cleanup.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` - Reason: Verification and scope audit.
  - Skills: [] - Commands are explicit.
  - Omitted: [`git-master`] - Commit happens after final review.

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1-F4] | Blocked By: [2]

  **References**:
  - Commands from `AGENTS.md`: `npx tsc --noEmit`, `npm run test`, `npm run build`.
  - Scope files: `src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`.
  - Preservation files: `src/runtime/logistics/resourceTransferTasks.ts`, `src/runtime/logistics/resourceTransferTasks.test.ts`, `src/runtime/hubPlanner.test.ts`.

  **Acceptance Criteria**:
  - [ ] `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts` exits 0.
  - [ ] `npx jest --config jest.config.cjs src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/hubPlanner.test.ts` exits 0.
  - [ ] `npx tsc --noEmit` exits 0.
  - [ ] `npm run test` exits 0.
  - [ ] `npm run build` exits 0.
  - [ ] Grep confirms blocked incoming filter remains.
  - [ ] Grep confirms terminal cap constant remains `250_000`.
  - [ ] Grep confirms no default `terminalEnergyReserve: 50_000` remains.

  **QA Scenarios**:
  ```
  Scenario: Full correction verification
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/resourceControl.test.ts src/runtime/logistics/resourceTransferTasks.test.ts src/runtime/hubPlanner.test.ts && npx tsc --noEmit && npm run test && npm run build`.
    Expected: All commands exit 0.
    Evidence: .sisyphus/evidence/task-3-full-correction-verification.log

  Scenario: Scope preservation audit
    Tool: Grep / Bash
    Steps: Search for `terminalEnergyReserve: 50_000`, `TERMINAL_TOTAL_STORAGE_CAP = 250_000`, and `BLOCKING_ERRORS` in the expected files.
    Expected: No 50k energy default; terminal cap and blocked incoming filter preserved.
    Evidence: .sisyphus/evidence/task-3-scope-preservation.txt
  ```

  **Commit**: NO | Message: `fix(resource): treat terminal reserve as capacity not energy` | Files: [`src/runtime/resourceControl.ts`, `src/runtime/resourceControl.test.ts`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- One correction commit after final verification: `fix(resource): treat terminal reserve as capacity not energy`.
- Deploy with `npm run push` only after review approval, matching user request.

## Success Criteria
- Terminal energy reserve default is back to 20k.
- Terminal used capacity cap remains 250k and includes energy.
- Terminal still preserves 50k free capacity for send/receive through overflow offload behavior.
- Blocked incoming resources are still excluded from hub planning availability.

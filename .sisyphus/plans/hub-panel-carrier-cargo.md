# Plan: Hub Panel & Planner Count Carrier Cargo

## Overview
Hub panel and hub planner inventory don't count non-energy resources being carried by carriers in the hub room. This causes:
1. **Panel display**: progress percentage underestimates actual resources
2. **Chain planning**: hub planner may over-plan (issue duplicate import/reaction tasks) when cargo is already in transit within the room

## Root Cause
- `hubProgress.ts` `buildCompactInventory()` (L282) merges storage + terminal only
- `hubPlanner.ts` `runHubPlanner()` (L687) merges storage + terminal + lab/factory/power-spawn only
- Cross-room in-transit is already tracked via `getIncomingResourceTransferAmount()` → `incomingResources`
- Missing: room-internal carrier cargo (carrier creeps with non-energy resources in `creep.store`)

## Scope
- **IN**: Count carrier non-energy cargo in hubInventory for both hubProgress and hubPlanner; tests
- **OUT**: Synthesis control, carrier execution logic, resource transfer tasks, remote carriers

## Tasks

- [x] 1. Add carrier cargo counting to hub inventory (hubProgress.ts + hubPlanner.ts)

  **What to do**:
  - Create a shared exported function in `src/runtime/hubProgress.ts` named `collectCarrierCargoInventory(hubRoomName: string): Record<string, number>`:
    - Iterate `Object.values(Game.creeps)`
    - Filter: `creep.memory.role === "carrier"` AND `getAssignedCarrierRoomName` logic (check `creep.memory.configName` → roomName via `getCreepConfigService().get(configName)?.roomName || creep.room.name`) matches `hubRoomName`
    - For each matching creep, iterate `Object.entries(creep.store as Record<string, number>)`, skip energy, add to result record
    - Return the aggregated `Record<string, number>`
  - Export this function so `hubPlanner.ts` can import it
  - In `collectHubProgressSnapshot()` (hubProgress.ts L484), after building `hubLabInventory` (L496-509):
    - Call `collectCarrierCargoInventory(hubRoomName)` and pass the result as a new `hubCarrierCargo` field into `buildHubProgressSnapshot()`
  - In `buildHubProgressSnapshot()` and `buildCompactInventory()`:
    - Add parameter `hubCarrierCargo: Record<string, number>` to `buildCompactInventory()`
    - After merging storage + terminal, also merge `hubCarrierCargo` entries (skip energy)
    - Thread the parameter from `buildHubProgressSnapshot` through `buildCompactInventory`
  - In `runHubPlanner()` (hubPlanner.ts L687), after building hubInventory from structures (L717):
    - Import and call `collectCarrierCargoInventory(cfg.hubRoomName)` from hubProgress
    - Merge carrier cargo into `hubInventory` (skip energy)
  - Update `HubProgressSnapshot` interface to include `hubCarrierCargo: Record<string, number>` field
  - Update `collectHubProgressSnapshot` return path to include the carrier cargo data

  **Must NOT do**:
  - Do not change carrier execution logic
  - Do not change synthesis control
  - Do not count energy (only non-energy minerals/compounds)
  - Do not count remote carriers (role "remoteCarrier") — they are different logistics
  - Do not change any visual rendering logic (the silent merge approach means the panel just shows higher numbers)

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: adding a helper function and merging into existing records in 2 files
  - Skills: [] - no extra skill needed
  - Omitted: [`screeps-game-data`] - no live data needed for deterministic code change

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2 | Blocked By: none

  **References** (executor has NO interview context - be exhaustive):
  - Pattern: `src/runtime/hubProgress.ts:282` - `buildCompactInventory()` merges storage + terminal → add carrier cargo merge here
  - Pattern: `src/runtime/hubProgress.ts:439` - `buildCompactInventory()` call site inside `buildHubProgressSnapshot()`
  - Pattern: `src/runtime/hubProgress.ts:484` - `collectHubProgressSnapshot()` entry point where carrier scan should be added
  - Pattern: `src/runtime/hubProgress.ts:496-509` - lab inventory collection pattern (follow this style for carrier cargo)
  - Pattern: `src/runtime/hubPlanner.ts:687-717` - `hubInventory` built from structures → add carrier cargo merge after L717
  - Pattern: `src/runtime/synthesisControl.ts:392-405` - `countInFlightSynthesisCargo()` is the existing pattern for iterating Game.creeps and summing store contents
  - API: `src/runtime/creepAssignmentState.ts` - `CreepAssignmentState` interface, `getCreepAssignmentState()` accessor
  - API: `src/roles/carrier.ts:338-345` - `getAssignedCarrierRoomName()` pattern for resolving which room a carrier belongs to (use `creep.memory.configName` → `getCreepConfigService().get(configName)?.roomName || creep.room.name`)
  - Filter: `creep.memory.role === "carrier"` is the established pattern (see spawnPlanner.ts:21, productionMonitor.ts:121)
  - API: `src/runtime/hubProgress.ts:25-100` - `HubProgressSnapshot` interface and related types need `hubCarrierCargo` field
  - Import: `getCreepConfigService` from `src/runtime/creepConfig.ts`, `Game.creeps` from Screeps API
  - Test file: `src/runtime/hubProgress.test.ts` has existing tests for `buildHubProgressSnapshot`, `collectHubProgressSnapshot`, `buildHubVisualModel`, etc.

  **Acceptance Criteria** (agent-executable only):
  - [ ] `collectCarrierCargoInventory(hubRoomName)` exported from `hubProgress.ts`
  - [ ] Function iterates Game.creeps, filters role=carrier + assigned to hubRoom, sums non-energy store
  - [ ] `buildCompactInventory()` accepts and merges carrier cargo parameter
  - [ ] `collectHubProgressSnapshot()` calls carrier cargo scanner and passes to snapshot builder
  - [ ] `runHubPlanner()` in hubPlanner.ts imports and merges carrier cargo into hubInventory
  - [ ] `HubProgressSnapshot` includes `hubCarrierCargo` field
  - [ ] No files outside hubProgress.ts, hubPlanner.ts modified (test file edits ok)

  **QA Scenarios** (MANDATORY - task incomplete without these):
  ```
  Scenario: TypeScript compilation
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: Exit 0.
    Evidence: .sisyphus/evidence/task-1-tsc.txt

  Scenario: Hub progress tests pass
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubProgress.test.ts`.
    Expected: Exit 0.
    Evidence: .sisyphus/evidence/task-1-hub-progress-tests.txt

  Scenario: Hub planner tests pass
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubPlanner.test.ts`.
    Expected: Exit 0.
    Evidence: .sisyphus/evidence/task-1-hub-planner-tests.txt
  ```

  **Commit**: NO | Message: `fix(hub): count carrier cargo in hub inventory` | Files: [`src/runtime/hubProgress.ts`, `src/runtime/hubPlanner.ts`]

- [x] 2. Add carrier cargo tests and run full verification

  **What to do**:
  - In `src/runtime/hubProgress.test.ts`, add a test for `collectCarrierCargoInventory`:
    - Set up hub room with `Memory.cfg.hub = { enabled: true, hubRoomName: "W8N1" }`
    - Create 2 mock creeps in `Game.creeps`:
      - Carrier A: role="carrier", configName→roomName="W8N1", store contains `{ [RESOURCE_UTRIUM]: 500, [RESOURCE_ENERGY]: 100 }`
      - Carrier B: role="carrier", configName→roomName="W8N2" (different room), store contains `{ [RESOURCE_KEANIUM]: 300 }` (should be excluded)
      - Carrier C: role="worker", configName→roomName="W8N1", store contains `{ [RESOURCE_UTRIUM]: 200 }` (should be excluded - not a carrier)
    - Assert `collectCarrierCargoInventory("W8N1")` returns `{ [RESOURCE_UTRIUM]: 500 }` (energy excluded, other room excluded, worker excluded)
  - In the same test file, add a test verifying `buildCompactInventory` includes carrier cargo:
    - Create storage store with `{ [RESOURCE_UTRIUM]: 1000 }`, terminal store with `{ [RESOURCE_KEANIUM]: 2000 }`, carrier cargo with `{ [RESOURCE_UTRIUM]: 500 }`
    - Assert `buildCompactInventory(storageStore, terminalStore, ["U"], null, [], [], carrierCargo)` includes `U: 1500` (1000 + 500)
  - Add a test in `hubPlanner.test.ts` or verify existing tests still pass after the hubPlanner change
  - Run `npx tsc --noEmit && npx jest --config jest.config.cjs` (full suite)

  **Must NOT do**:
  - Do not modify carrier or synthesisControl source files
  - Do not weaken existing test expectations

  **Recommended Agent Profile**:
  - Category: `quick` - Reason: focused test additions in known test file
  - Skills: [] - no extra skill needed

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: F1-F4 | Blocked By: 1

  **References** (executor has NO interview context - be exhaustive):
  - Test: `src/runtime/hubProgress.test.ts` - existing tests for all hubProgress exports, use same mock patterns
  - Pattern: `src/runtime/hubProgress.test.ts` mock setup for `Game.creeps`, `Memory`, `Game.rooms`, `Game.time`
  - Constants: `RESOURCE_UTRIUM`, `RESOURCE_KEANIUM`, `RESOURCE_ENERGY` from Screeps constants
  - Filter pattern: `creep.memory.role === "carrier"` (see spawnPlanner.ts:21)
  - Room assignment pattern: `getCreepConfigService().get(configName)?.roomName` (see carrier.ts:344)

  **Acceptance Criteria** (agent-executable only):
  - [ ] Test proves carrier in hub room with non-energy cargo is counted
  - [ ] Test proves carrier in non-hub room is excluded
  - [ ] Test proves non-carrier creep is excluded
  - [ ] Test proves energy is excluded
  - [ ] Test proves carrier cargo merges with storage in buildCompactInventory
  - [ ] Full test suite passes

  **QA Scenarios** (MANDATORY):
  ```
  Scenario: New hub progress carrier cargo tests
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs src/runtime/hubProgress.test.ts -t "carrier cargo"`.
    Expected: Exit 0, new tests pass.
    Evidence: .sisyphus/evidence/task-2-carrier-cargo-tests.txt

  Scenario: Full test suite
    Tool: Bash
    Steps: Run `npx jest --config jest.config.cjs`.
    Expected: Exit 0.
    Evidence: .sisyphus/evidence/task-2-full-suite.txt

  Scenario: TypeScript clean
    Tool: Bash
    Steps: Run `npx tsc --noEmit`.
    Expected: Exit 0.
    Evidence: .sisyphus/evidence/task-2-tsc.txt
  ```

  **Commit**: NO | Message: `test(hub): cover carrier cargo inventory` | Files: [`src/runtime/hubProgress.test.ts`]

## Final Verification Wave

- [x] F1. Plan compliance audit
  Verify all task checkboxes are completed and code matches plan specification.

- [x] F2. Code quality review
  Review for code smells, anti-patterns, edge cases (empty Game.creeps, no hub room, etc.)

- [x] F3. Manual QA review
  Read every changed file, verify logic matches requirements, no stubs or TODOs.

- [x] F4. Scope fidelity check
  Confirm no files outside scope were modified. Confirm carrier/synthesis behavior unchanged.

## Parallelization Map

| Wave | Tasks | Category |
|------|-------|----------|
| 1 | 1 | quick |
| 2 | 2 | quick |

## Dependency Graph

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | none | 2 |
| 2 | 1 | F1-F4 |

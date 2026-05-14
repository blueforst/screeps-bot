# Learnings

## Auto-OH Plan Interference
- `getAutoOhPlan()` auto-generates OH synthesis plans when logistics rooms have < 2000 OH total
- Tests MUST include `[RESOURCE_HYDROXIDE]: 2000` in storage to suppress auto-OH plan
- Without this, `chooseActivePlan` returns the OH plan instead of null, bypassing the null branch entirely

## Stranded Recovery Guard Condition
- Stranded recovery should ONLY fire when `(!unloadProduct || !unloadTarget)` — i.e., when runtime state is missing product info
- If we fire on all null `productUnloadTask` cases, it breaks existing tests where transferable >= target (correct no-op)

## Lab Topology in Tests
- `pos.inRangeTo: () => true` mock means all 3 labs are in range → topology picks first pair (labs[0], labs[1]) as reagents, [labs[2]] as product
- `resolveLabTopology` falls to brute-force search when `roomCfg.reagentLabIds` is empty (default in tests)

## Hub Auto-Plan Flow
- `runSynthesisControl()` calls `getAutoOhPlan()` → `getLogisticsRooms()` → `getTickContextService().getMyRooms()` filtered by `controller.my && terminal`
- Tests that set `Game.rooms["W1N1"]` with a terminal will be picked up as logistics rooms

### Task 3: Hub visual model batch mode (2026-05-13)

- `buildHubVisualModel()` uses 3-way branching: idle (no activeProduct), batch mode (activeProduct + synthesisTargetAmount), fallback stock (activeProduct only)
- `stageOrStatus = stageLabel ?? statusLabel` — stage overrides status in progressText for batch mode
- Default status in tests from `makeSnapshot()` helper is "acquiring", not "synthesizing"
- `hubLabInventory` and `hubInventory` are summed in batch mode for currentAmount
- `formatEnergy()` is NOT used in batch mode text — raw numbers display (e.g. "110/106")

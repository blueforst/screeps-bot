
## Terminal Feed Reserve-Aware Fix (Wave 1)

### Problem
Native mineral auto-sell staging creates `terminal_feed` tasks that push terminal total over `TERMINAL_TOTAL_STORAGE_CAP = 250_000`, causing overflow offload to immediately remove the same resource → carrier storage↔terminal oscillation.

### Fix
In `syncTerminalFeedTasks()` (resourceControl.ts ~line 920), after overflow offload drafts are computed:
1. Calculate effective terminal total = current terminal used - offload amounts from drafts
2. `feedCapacity = max(0, 250k - effectiveTerminalTotal)`
3. Each non-energy feed draft is capped by remaining `feedCapacity` before being added
4. `feedCapacity` decremented by actual feed amount per draft
5. Energy feed drafts are NOT affected (handled separately before overflow section)

### Key design decisions
- No cross-tick cooldown/hysteresis — single-pass cap per tick is sufficient
- `TERMINAL_TOTAL_STORAGE_CAP` unchanged at 250k
- Pending transfer feeds are also capped by the same mechanism (they share terminal capacity)
- Feed drafts are iterated sequentially; first resource gets priority for limited capacity

## Synthesis Reagent Supply Deficit-Bounded Fix (Wave 1)

### Problem
`generateSupplyTask()` filled reagent labs to default batchSize 500 regardless of actual product deficit. E.g. UO target 106 → reagent labs got 500 U and 500 O each, causing 390 leftover U and O after producing only 106 UO.

### Root cause
Two issues:
1. `generateSupplyTask()` used `desiredLabAmount = min(LAB_MINERAL_CAPACITY, max(LAB_REACTION_AMOUNT, batchSize))` — always 500 with default batch
2. `hubPlanner.writeSynthesisConfig()` omitted `batchSize` in reaction config, so `normalizeReactionPlan` fell back to default 500

### Fix
1. Added `roundUpReactionAmount(amount)`: `ceil(amount/5)*5` — rounds up to nearest LAB_REACTION_AMOUNT multiple
2. `generateSupplyTask()` now computes `productDeficit = max(0, targetAmount - roomResourceAmount(room, product))`, then `desiredLabAmount = min(LAB_MINERAL_CAPACITY, batchSize, roundUpReactionAmount(productDeficit))`
3. Partial top-up: when lab has some correct reagent, allows sub-LAB_REACTION_AMOUNT transfer if it completes the desired amount
4. `writeSynthesisConfig()` now includes `batchSize: roundUpReactionAmount(targetAmount)` capped to [5, 3000]

### Key constraints preserved
- `roomResourceAmount()` still counts storage + terminal + all labs (not changed)
- `planHubChains()` deficit computation untouched
- Minimum supply is LAB_REACTION_AMOUNT (5) when product deficit is positive

## lab_product_unload implementation (Wave 1 Task 3)

### Key Findings
- `chooseActivePlan` falls through to `getAutoOhPlan()` when all configured reactions meet target. Auto-oh plan returns OH with target = logisticsRooms.length * 2000. This means when UO target is met, the active plan switches to OH — so product-unload for UO must work in the `activePlan` branch, not just `!activePlan`.
- `prevProductUnloadTask` needed: when activePlan changes product (e.g. UO→OH via autoPlan), reagent labs are "contaminated" for the new product. Product-unload for the old product must be generated even during contamination cleanup, since cleanup only handles reagent labs and product-unload handles product labs.
- `createStore` mock: `getFreeCapacity(resource)` tracks per-resource, not total. Override with `() => 0` to simulate full stores.
- `roomResourceAmount` includes lab contents. `roomTransferableAmount` only counts storage+terminal. This is the core gap: hubPlanner uses transferable, synthesis uses total.
- carrier.ts needs NO changes: generic lab-withdraw + storage/terminal-transfer handles `lab_product_unload` automatically.

### Files Modified
- `src/runtime/carrierTaskBoard.ts`: Added `"lab_product_unload"` to CarrierTaskType union, priority 180
- `src/runtime/synthesisControl.ts`: Added `generateProductUnloadTask`, `resolveProductUnloadTargetStructure`, wired into both activePlan and !activePlan branches
- `src/runtime/synthesisControlStateMachine.test.ts`: 5 new tests for product-unload task generation
- `src/roles/carrier.test.ts`: 1 new test for carrier lab_product_unload delivery flow

## Product Unload + Synthesis State Machine Integration (Wave 2)

### Problem (E4N58 Stall)
When product (UO) was in product lab (110) satisfying target (106) but not yet in storage+terminal (0), synthesisControl would set `needsPlan=true` every tick during the product-unload phase (stage="unloading"). This caused hubPlanner to re-run every tick, see UO=0 in storage+terminal, and rewrite the same UO reaction — an infinite needsPlan loop.

### Root Cause
In `!activePlan` branch of `handleRoom()`, the condition `roomState.stage !== "idle"` would trigger needsPlan for ANY non-idle previous stage, including "unloading" (product-unload). During product-unload, hubPlanner inventory hasn't changed (product still in labs, not storage), so re-planning is wasted work and causes the loop.

### Fix
Changed the condition at line ~1056 from:
```typescript
if (roomState.stage !== "idle" && ...)
```
to:
```typescript
if (roomState.stage !== "idle" && roomState.stage !== "unloading" && ...)
```

This ensures needsPlan is only set when transitioning from active synthesis (synthesizing/loading/acquiring/blocked) to having no plan — NOT during product-unload or contamination cleanup.

### Key Flow (Correct)
1. Tick T: synthesizing → product meets target → `!activePlan` → product-unload generated → stage="unloading", needsPlan=true (transition from synthesizing)
2. Tick T+1: hubPlanner runs (needsPlan=true), writes next step config, needsPlan=false
3. Tick T+2: synthesisControl runs, stage was "unloading" → needsPlan NOT set (loop broken)
4. Carrier delivers product to storage → next cadence: hubPlanner sees product in inventory → advances chain

### Metadata Distinction
- Product-unload: stage="unloading", lastError=undefined
- Contamination: stage="unloading", lastError="lab_contaminated_waiting_clear"

### Test Coverage
- 5 new tests in synthesisControlStateMachine.test.ts (E4N58 stall regression)
- 2 new tests in hubPlanner.test.ts (chain advancement after product unload)

### Hub Planner Test Gotcha
- `planHubChains()` always targets ALL 5 default T3 compounds, ignoring config's `targetCompounds`
- To make UO the first step, ALL preceding intermediates (OH, ZK, UL, G, UH) must be met in storage
- Store mock with spread `...storageEntries` creates a shallow copy; adding to `storageEntries` after creation requires also updating the store object directly

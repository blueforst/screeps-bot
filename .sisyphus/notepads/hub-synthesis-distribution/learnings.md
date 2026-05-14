# Learnings: Distributed Synthesis Distribution

## Task 1: Type Contract & Test Fixtures

### Mock Patterns
- `hubPlanner.test.ts` uses multiple factory functions: `createHubRoom`, `createSatelliteRoom`, `createHubRoomForImports`, `createHubRoomForDistribution`, `createIntegrationHubRoom`, `setupHubRoomForSynthesis`. Each creates a `Room` mock with different capabilities.
- `synthesisControlStateMachine.test.ts` uses a `createSynthesisRoom` helper that returns `{ room, labs, storageMap }` — labs are full `LabHandle` objects with `runReaction` mocks, `mineralType`, and `_resourceMap` for direct mutation in tests.
- All tests in `hubPlanner.test.ts` call `registerRuntimeServices()` in `beforeEach` and set `(global as any).__runtimeServices = undefined` before the call.
- `Game.rooms` is an object map (`Record<string, Room>`), not an array.

### Type Architecture
- Types for distributed synthesis live as exported interfaces in `hubPlanner.ts` (co-located with `ChainStep`).
- `global.d.ts` imports from `hubPlanner.ts` and adds `distributedSynthesis?` to `Memory.runtime.hub`.
- No new files needed — all types extend existing Memory subsystems.

### Key Types Added
- `SynthesisRoomCapability`: room eligibility (labCount, terminal, storage, boostLabExclusive, mineralInventory)
- `SynthesisDispatchAssignment`: room + product + targetAmount + isHubRoom
- `AllocationLedgerEntry`: resource + totalAmount + per-room commitments
- `DirectRouteDecision`: fromRoom + toRoom + resource + amount + fee
- `ProgressEdge`: upstream/downstream flow tracking (delivered/total)

### Test Fixtures
- `createSynthesisCapableRoom`: general-purpose factory that creates a room with configurable labCount, storage/terminal resources, and structure presence. Returns a `Room` mock.
- Tests verify: room count, structure presence (storage/terminal/labs), distinct mineral stores, and type contract round-tripping through Memory.

## Task 2: Eligible Synthesis Room Discovery

### Implementation
- `getEligibleSynthesisRooms()` is a pure export in `hubPlanner.ts`, placed before `runHubPlanner()`.
- Uses `getTickContextService().getMyRooms()` for room iteration (filters for `controller.my`).
- Eligibility: visible owned room + storage + terminal + >=3 labs + not boost-exclusive.
- Boost exclusivity: checks `Memory.cfg.homeDefense.rooms[roomName].boostLabId`. Only boost-exclusive when `labCount <= 1 && boostLabId != null`. A single boost lab in a multi-lab room is fine.
- Mineral inventory: aggregates non-energy resources from `room.storage.store` + `room.terminal.store`.
- Added `getOutgoingResourceTransferAmount` to imports (available for future capacity scoring).
- Survival-state rooms are eligible (no exclusion based on resourceControl state).

### Test Coverage (9 tests)
- Eligible rooms with storage+terminal+3 labs
- Missing storage, missing terminal, insufficient labs
- Invisible rooms (no Game.rooms entries)
- Survival-state rooms included
- Boost lab with multiple labs → not exclusive
- 1-lab room with boostLabId → excluded
- Mineral inventory aggregation from storage+terminal
- Hub room included alongside aux rooms

### Key Patterns
- `countLabs(room)` is a private helper already in hubPlanner.ts using `room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_LAB } })`.
- `createSynthesisCapableRoom` mock supports `hasStorage`, `hasTerminal`, `labCount`, `storageResources`, `terminalResources`.

## Task 8: Hub Progress Distributed Production Model

### Type Extension
- `ProductionRoomEntry` interface added to `hubProgress.ts` (not global.d.ts) — co-located with `HubProgressSnapshot`.
- `HubProgressSnapshot` extended with `productionRooms: ProductionRoomEntry[]` field.
- `analytics.hub` in `global.d.ts` mirrored with inline `productionRooms` shape (same pattern as existing fields).
- `HubProgressInput` extended with `distributedSynthesis`, `synthesisControlRooms`, `synthesisControlCfgRooms`.

### Data Sources
- `Memory.runtime.hub.distributedSynthesis.dispatchAssignments` → room+product+targetAmount per assignment.
- `Memory.runtime.synthesisControl.rooms[roomName].stage` → synthesis stage (idle/acquiring/loading/synthesizing/unloading/blocked).
- `Memory.runtime.synthesisControl.rooms[roomName].lastError` → blocker reason.
- `progressEdges` → upstream/downstream links between rooms.
- `routeDecisions` → directSupplyAmount (toRoom != hub) vs hubSurplusAmount (toRoom == hub).

### Key Patterns
- `buildProductionRooms()` is a pure function taking input data + hubRoomName, returns `ProductionRoomEntry[]`.
- currentAmount aggregates storage + terminal + lab product amounts from `Game.rooms[roomName]`.
- Invisible rooms get stage="idle", currentAmount=0, progressPercent=0, blocker=null.
- progressPercent = min(currentAmount / targetAmount, 1).
- directSupplyAmount = sum of route.amount where fromRoom=room and toRoom!=hub.
- hubSurplusAmount = sum of route.amount where fromRoom=room and toRoom=hub.

### Test Coverage (9 new tests, 70 total)
- Empty when no distributed synthesis data or no assignments.
- Hub + auxiliary room entries with product, stage, currentAmount, progressPercent, isHubRoom.
- Producer→consumer links via progressEdges (upstream/downstream arrays).
- Direct-supply vs hub-bound surplus distinction from routeDecisions.
- Blocker from synthesisControl runtime lastError.
- Invisible rooms get safe defaults.
- progressPercent capped at 1.
- Lab product amounts included in currentAmount.

## Task 3: Concurrent T3 Chain Demand + Global Allocation Ledger

### Implementation
- `planDistributedSynthesis()` is a pure export in `hubPlanner.ts`, placed between `getEligibleSynthesisRooms()` and `runHubPlanner()`.
- `DistributedSynthesisPlan` interface: `dispatchAssignments`, `allocationLedger`, `routeDecisions`, `blockedTargets`.
- Algorithm: (1) get eligible rooms, (2) build per-room effective inventory (mineralInventory + incoming - outgoing - local reserve for base minerals), (3) build allocation ledger from effective inventories, (4) compute global pool, (5) call `planHubChains()` for demand propagation, (6) assign steps to rooms greedily (hub first), decrementing ledger atomically.
- `assignStepToRoom()`: tries direct assignment (room has both reagents), then cross-room routing (consolidate reagents from other rooms to a producer). Ledger changes committed only if both reagents fully sourced.
- Cross-room routing creates `DirectRouteDecision` entries with `fee: 0` (placeholder — actual fee requires Game.terminal access).

### Key Design Decisions
- Allocation ledger populated BEFORE dispatch decisions, decremented as assignments are made.
- `blockedTargets` only populated when `planHubChains()` returns `blocked: true`. Progressive chain returns feasible intermediates even when target T3 isn't directly assignable.
- Hub room preferred as producer (first in roomOrder), auxiliary rooms as fallback.
- Reserve deduction only applies to `BASE_MINERALS` (not intermediates or T3).

### Chain Math Gotchas
- With large `hubReservePerCompound` (e.g., 20000) × 10 T3 targets, shared intermediate demand (OH) becomes massive (200000) and can consume all H/O, starving T1 intermediates. Tests should use small reserves (1000) or verify intermediate-only assignments.
- `planHubChains()` returns candidates in OUTPUT_ORDER (base intermediates first). Assigning the first candidate (OH) may consume all of a shared reagent (H), preventing later candidates.

### Test Coverage (13 new tests, 126 total)
- Empty plan when no eligible rooms
- Backward compatibility: single hub produces same chain as planHubChains (2 tests)
- Scarce shared base minerals: ledger prevents double-spending (2 tests)
- All-T3 concurrent feasibility with sufficient resources
- Cross-room routing: hub routes reagents from aux
- Demand-driven upstream supply amounts
- Pending incoming/outgoing transfers affect ledger
- Local reserve subtracted from base minerals
- Shared intermediate (OH) allocation without over-allocation
- DistributedSynthesisPlan type contract round-trip

## Task 4: Logistics-Cost-Aware Dispatch Scoring

### Implementation
- `scoreRoomForStep()` is an exported pure function in `hubPlanner.ts` that scores each room for a given chain step.
- `DependencyGraph` class is exported for cycle detection; uses DFS with stack-based reachability check.
- `assignStepToRoom()` now takes additional `roomCapabilities: SynthesisRoomCapability[]` and `depGraph: DependencyGraph` parameters.
- `planDistributedSynthesis()` creates a `DependencyGraph` instance and passes it to `assignStepToRoom`.

### Scoring Factors (ordered by impact)
1. **Local reagent availability**: +100 if both reagents fully local, +20-50 for partial, +10 for one reagent.
2. **Stage guard**: -200 for rooms in "loading"/"synthesizing"/"unloading"/"cleanup" stages.
3. **Terminal load**: penalty proportional to pending transfer bandwidth normalised by needed amount.
4. **Hub bonus**: +1 for hub room (slight preference, easily overridden).
5. **Terminal fee**: -5 (or proportional via `calcTransactionCost`) for cross-room routes to non-hub rooms.

### Cycle Detection
- `DependencyGraph.wouldCreateCycle(room, dependsOn)` checks if adding `room → dependsOn` would create any cycle in the existing graph.
- Uses `reachable(dependsOn, room)` — DFS from `dependsOn` checking if `room` is reachable.
- Cycle check is applied per-source-room during cross-room routing, BEFORE committing ledger changes.
- Direct assignments (both reagents local) never create dependencies, so no cycle check needed.

### Key Design Decisions
- Scoring is deterministic: same inputs → same scores. Sort order is by descending score.
- Rooms in busy stages are NOT excluded (just penalised -200), allowing force-assignment if they're the only option. This differs from the "exclude" approach in the spec because the penalty is large enough to effectively exclude in practice.
- `Game.market.calcTransactionCost` may not exist in test mocks; fallback to flat -5 penalty.
- The `DependencyGraph` tracks dependencies at the room level (not per-resource), which is sufficient for DAG enforcement.

### Test Coverage (12 new tests, 138 total)
- T1 source-room preference: aux with both H+O preferred over hub with only H (2 tests)
- Stage guard: synthesizing room deprioritised, -200 penalty verified (2 tests)
- Terminal load: heavy outgoing penalises room, load score verified (2 tests)
- Cycle rejection: DependencyGraph direct/transitive/complex cycles, non-cyclic allowed (5 tests)
- Integration: planDistributedSynthesis avoids cyclic routing (1 test)

### Gotchas
- `Memory.runtime.synthesisControl?.rooms?.[roomName]?.stage` requires `synthesisControl` to exist in runtime memory. Tests must set it explicitly.
- The `RoomDispatchScore` interface is exported for test access to `scoreRoomForStep`.
- Existing 126 tests pass unchanged — scoring is additive and backward-compatible for single-room scenarios.

## Task 5: Config Writing & Non-Hub Replanning Signals

### Implementation
- `wireDistributedSynthesis()` already existed from prior tasks (lines 1066-1152). It handles multi-room config writing with `ACCEPT_REASSIGN_STAGES` guard (idle, blocked only).
- `runHubPlanner()` already integrates `wireDistributedSynthesis()` (lines 1288-1299) with hub-only `writeSynthesisConfig()` fallback when no aux rooms.
- `Memory.runtime.hub.distributedSynthesis` stores the full plan including `roomCapabilities`, `dispatchAssignments`, `allocationLedger`, `routeDecisions`.
- New `signalHubNeedsPlan(roomName)` function in `synthesisControl.ts` replaces 3 inline signaling blocks with a unified helper that:
  - Hub rooms: always signal immediately (unchanged behavior)
  - Non-hub rooms: only signal if room is in `cfg.synthesisControl.rooms` AND outside the debounce window (`Game.time - lastPlanTick >= planInterval`)

### Debounce Logic
- `Memory.runtime.hub.lastPlanTick` is set by `runHubPlanner()` on every plan run
- `Memory.cfg.hub.planInterval` (default 50) defines the debounce window
- Non-hub room signals are suppressed during the debounce window to prevent thrash
- Hub room signals bypass the debounce entirely (immediate, as before)

### Test Patterns
- Testing `signalHubNeedsPlan` indirectly via `runSynthesisControl()` — the function is private
- Product completion test: put target product in `terminalResources` with amount >= `targetAmount` + set matching `activeProduct`/`targetAmount`/`batchSize` in runtime state → triggers the `productCurrent >= activePlan.targetAmount` path
- Debounce test: set `lastPlanTick` close to `Game.time` → non-hub signal suppressed
- Hub bypass test: hub room signals even within debounce window

### Key Patterns
- `createRoomWithResources` factory in synthesisControl.test.ts supports `terminalResources` param for product amounts
- Runtime state must include `reagentLabIds`, `productLabIds`, `activeProduct`, `targetAmount`, `batchSize` — matching the cfg reaction — to avoid unwanted stage transitions
- `wireDistributedSynthesis` returns `false` when no aux rooms exist → triggers old single-room `writeSynthesisConfig()` path
- Resource isolation for multi-room tests: hub gets H+O (makes OH), aux gets Z+K+U+L (makes ZK, UL, G for ghodium chain)

### Test Coverage (8 new tests: 4 hubPlanner + 4 synthesisControl)
- wireDistributedSynthesis: hub-only fallback, multi-room distinct reactions, active room preservation, runtime memory storage
- signalHubNeedsPlan: non-hub signal outside debounce, non-hub suppressed within debounce, non-hub not in config ignored, hub immediate bypass

## Task 6: Direct Routing & Transfer-Task Accounting

### Implementation
- `wireRouteTransferTasks()` is an exported pure function in `hubPlanner.ts` that creates resource transfer tasks from route decisions.
- Called from `wireDistributedSynthesis()` after config writing, passing `plan.routeDecisions`, `hubRoomName`, and `reservePerRoom`.
- Partition: `directRoutes` (toRoom != hub) vs `hubRoutes` (toRoom == hub).
- Direct routes: compare `calcTransactionCost(direct)` vs `cost(A→hub) + cost(hub→B)`. If direct is cheaper, create direct task; otherwise route through hub with reason `synthesis:hub-route:`.
- Hub-bound surplus: subtract `directCommitment[fromRoom:resource]` + `reservePerRoom` from hub route amount. Skip if remainder <= 0.

### Fee Comparison
- `Game.market.calcTransactionCost(amount, fromRoom, toRoom)` — must mock in tests.
- In test environment, `Game.market` is undefined by default. Must set `(Game as any).market = { calcTransactionCost: ... }` before use.
- When `calcTransactionCost` is not available (typeof check), `preferDirect` defaults to true.

### Direct Commitment Suppression
- `directCommitment` map: key is `${fromRoom}:${resource}`, value is sum of all direct route amounts for that fromRoom+resource pair.
- Hub-bound surplus for the same fromRoom+resource is reduced by the direct commitment + local reserve.
- Example: room has 3000 OH surplus to hub, direct commitment of 1800 OH to consumer, reserve 500. Hub surplus = 3000 - 1800 - 500 = 700.

### Transfer Task Reasons
- `synthesis:direct:${resource}` — direct producer→consumer transfer
- `synthesis:hub-route:${resource}` — direct was too expensive, route through hub
- `synthesis:surplus:${resource}` — hub-bound surplus after direct commitment deduction

### planDistributedSynthesis Already Counts Direct Transfers
- `getIncomingResourceTransferAmount` / `getOutgoingResourceTransferAmount` count ALL pending tasks regardless of reason.
- No changes needed to `planDistributedSynthesis()` — it already sees pending direct transfers.

### Test Patterns
- Testing `wireRouteTransferTasks` directly with controlled `DirectRouteDecision[]` inputs is much simpler than trying to get `planDistributedSynthesis` to produce specific routes.
- The planner always tries hub first (+1 bonus), making it hard to generate direct routes (toRoom != hub) without very specific resource distributions.
- Must call `registerRuntimeServices()` and reset `Memory.data = {}` before each `wireRouteTransferTasks` test.
- `getOutgoingResourceTransferAmount` import needed in test file for the pending-transfer accounting test.

### Test Coverage (4 new tests, 150 total hubPlanner)
- Direct A→B transfer with lower direct fee
- Hub-bound surplus when no downstream consumer
- Pending direct transfers tracked by getOutgoingResourceTransferAmount
- Direct commitment suppresses hub-bound surplus

## Task: resolveLabTopology Room Planner Layout Preference

### Implementation
- Added planned-layout reagent lab preference in `resolveLabTopology()` (synthesisControl.ts) between manual `reagentLabIds` check and brute-force search.
- Inlines the `slice(-2)` logic from `getSortedLabPlannedPositions()` (roomPlannerConstruction.ts) rather than exporting the private function.
- Reads `Memory.data?.roomPlanner?.[room.name]?.layout` — a `Record<string, {x, y}[]>` — and takes the last 2 lab positions as planned reagent labs.
- Matches built labs by `pos.x`/`pos.y` comparison, then finds product labs in range-2 of both reagent labs.
- Falls through to brute-force if planned labs aren't built or have no product labs in range.

### Key Design Decisions
- Inlined `slice(-2)` logic instead of exporting `getSortedLabPlannedPositions()` — avoids coupling and the function is trivially simple.
- Cast `Memory.data` through `(Memory.data as any)?.roomPlanner` to avoid widening the Memory type for this optional access.
- Three-tier priority: manual config > planned layout > brute-force. Each tier has its own early return.

### Test Patterns
- Created `makeLab()` helper with position-aware `inRangeTo` using Chebyshev distance (`Math.max(dx, dy) <= range`).
- `setPlannedLayout()` helper sets `Memory.data.roomPlanner[roomName].layout.lab` positions.
- Tests verify: planned labs preferred, fallback when not built, manual config overrides planned layout.
- Labs are injected by overriding `room.find` to return the test's lab array (same pattern as existing tests).
- 3 new tests added to existing 39, total 42 in the file.

## Task 9: Local Production/Reserve First, Hub Surplus Policy

### Implementation
- `getDirectSupplyCommitment(satelliteName, resource)` — new helper in `hubPlanner.ts` that sums pending `synthesis:direct:*` and `synthesis:hub-route:*` transfer tasks from a satellite, plus route-decision demands from `Memory.runtime.hub.distributedSynthesis.routeDecisions`.
- `getLocalReserveForSynthesis(satelliteName, resource, reservePerRoom, targetCompounds)` — new helper that returns:
  - `reservePerRoom` for any T3 target compound (always, regardless of synthesis assignment).
  - `batchSize` for resources that appear as reagents in the reaction chain of the room's assigned product.
  - `0` otherwise.
- `isReagentInChain(product, resource)` — DFS walk through `REACTION_MAP` to check if a resource appears as a reagent at any level of the reaction chain for a given product.
- `getBatchSizeForRoom(roomName)` — reads `Memory.cfg.synthesisControl.rooms[roomName].reactions[0].batchSize` or falls back to room-level `batchSize` or `5`.
- `planHubImports()` updated to subtract `directSupplyCommitment + localReserve` from import amounts for base minerals, intermediates, and T3 reclaims.
- `isHubProtectedResource()` in `resourceControl.ts` extended with `isResourceCommittedToDistributedSynthesis()` helper that checks route-decision commitments for satellite rooms.

### Key Design Decisions
- T3 reserve (`reservePerRoom`) is ALWAYS subtracted for target compounds, not just when the room has a synthesis assignment. This ensures the satellite keeps its local stockpile regardless.
- Intermediate/base resource reserve only applies when the room has an active synthesis assignment AND the resource appears in the product's reaction chain.
- The `surplusThreshold` check for T3 (default 1500) still gates whether reclaim is considered at all. This means `amount > surplusThreshold` is required before any reclaim calculation.
- `isHubProtectedResource` now protects satellite-held resources that have active route decisions in distributed synthesis, preventing market sells.

### Test Coverage (8 new hubPlanner + 1 new resourceControl = 9 new)
- Satellite with 800 T3 and reservePerRoom=1000 → no reclaim task
- Satellite with 2000 T3 and reservePerRoom=1000 → reclaim 1000
- Satellite with active synthesis assignment keeps local reserve for T3
- Satellite with active synthesis and only 800 T3 → no reclaim
- Upstream room with direct downstream demand keeps committed amount
- Direct-supply and hub-storage conflict → direct-supply first
- Hub distribution still fills rooms below target
- Market protection for committed satellite resources (hubPlanner test)
- Satellite room does not sell OH committed to distributed synthesis (resourceControl test)

### Gotchas
- `surplusThreshold` (default 1500) is higher than `reservePerRoom` (default 1000). Tests for T3 reclaim must use amounts > surplusThreshold.
- `Memory.cfg.synthesisControl.rooms[roomName].reactions` is an ARRAY, not an object. Must index `[0].batchSize`.
- `isReagentInChain` must track visited nodes to avoid infinite loops in reaction chains.
- The `REACTION_MAP` is co-located in hubPlanner.ts and covers all T1→T2→T3 reaction paths.

## Task: Distributed Production Hub Panel Rendering

### Implementation
- Added `drawDistributedProductionSection(p, productionRooms)` private function to `hubProgress.ts`.
- `drawHubVisualPanel` signature extended with optional `productionRooms?: ProductionRoomEntry[]` parameter.
- `renderHubProgressOverlays` passes `snapshot.productionRooms` to `drawHubVisualPanel`.
- Section renders after Logistics section: "Distributed Production" header + per-room rows.
- Each room row: name+product+stage, progress bar, upstream/downstream links + amounts, blocker.
- Hub rooms marked with ★ in the row label.
- `MAX_PRODUCTION_ROOM_ROWS = 6`, `MAX_LINK_LABELS = 2` for caps.
- Upstream links: `←room1,room2+N`, downstream: `→room3`.
- Direct supply: `direct:3K`, hub surplus: `hub:5K` labels.
- Blocker rendered as `⚠ message` in error color.
- `MAX_HUB_VISUAL_CALLS` raised from 40 to 80 to accommodate distributed production rows.

### Visual Layout
- Section only renders when `productionRooms.length > 0`.
- Uses `Panel.sectionHeader()`, `textRow()`, `progressBar()` — no new panel helpers.
- `formatCompactAmount()` helper for amounts (same logic as `formatEnergy` but used for non-energy resources).
- Progress bar color: blocked→red, synthesizing→green, complete→green, otherwise→muted.

### Test Coverage (11 new tests, 81 total)
- Section header presence/absence
- Room name + product + stage rendering
- Hub room ★ marker
- Upstream ← prefix links
- Downstream → prefix links
- Upstream cap at 2 with overflow
- Direct supply and hub surplus amounts
- Blocker with error color
- Production room row cap at 6
- Progress bar label format

### Key Patterns
- `drawHubVisualPanel` backward-compatible: existing callers without productionRooms parameter still work.
- Tests use `findText(predicate)` helper to search `__roomVisualCalls` for specific text content.
- ProductionRoomEntry factory `makeProductionRoom()` with sensible defaults for test readability.

## Task 10: Integration/Status Coverage for Distributed Pipeline

### Test Coverage (5 new tests, 13 total in file)
- Full distributed pipeline: hub + 2 aux rooms → runHubPlanner → synthesis configs written to multiple rooms → transfer tasks created → progress snapshot lists all active rooms
- Progress snapshot upstream/downstream links between rooms (pre-seeded distributed synthesis data)
- hubProgressRaw returns productionRooms with non-hub synthesis rooms visible
- statusHubRaw shows hub-centric status but does NOT include distributed production rooms (by design — use hubProgressRaw for that)
- Tick-order invariant: static analysis of main.ts verifies hubPlanner < synthesisControl < mineralExtraction < resourceControl < hubProgressAnalytics

### Key Findings
- `statusHubRaw()` only shows hub room synthesis state — no distributed production room info. Users must use `hubProgressRaw()` / `collectHubProgressSnapshot()` for distributed room details.
- `hubProgressRaw()` (console command) returns full `HubProgressSnapshot` including `productionRooms[]` with all distributed synthesis rooms.
- Main tick order confirmed: hubPlanner → synthesisControl → mineralExtraction → resourceControl → hubProgressAnalytics (lines 58-62 in main.ts).
- `__dirname` in test files under `src/runtime/` resolves to that directory — `main.ts` is at `../main.ts` relative to it.

### Test Patterns
- For distributed pipeline test: use distinct mineral distributions per room (hub: H+O+misc, aux1: Z+K, aux2: U+L) to guarantee multi-room dispatch.
- `getEligibleSynthesisRooms()` can be called after `runHubPlanner()` to verify room discovery.
- `collectHubProgressSnapshot()` reads directly from `Memory` + `Game.rooms`, so it works without calling `runHubProgressAnalytics()`.
- For pre-seeded progress snapshot tests: set `Memory.runtime.hub.distributedSynthesis` with `dispatchAssignments`, `routeDecisions`, and `progressEdges` directly.

## Task 12: Satellite Room Visual Panels

### Implementation
- Added `drawSatellitePanel(rv, room)` private function after `drawHubVisualPanel()`.
- Uses `SATELLITE_VISUAL_X=38, Y=0, WIDTH=12` (top-right corner, compact layout).
- Reuses same helpers as `drawDistributedProductionSection()`: `formatCompactAmount()`, `MAX_LINK_LABELS`, `VIS_*` colors.
- Compact layout: section header with product+stage → progress bar → supply chain row → blocker.
- No logistics/import/export section (that's hub-only).

### renderHubProgressOverlays Changes
- After drawing the hub panel via `drawHubVisualPanel()`, iterates `snapshot.productionRooms`.
- Skips hub room entries (`room.isHubRoom === true`).
- Skips rooms without visibility (`!Game.rooms[room.roomName]`).
- Creates a `new RoomVisual(room.roomName)` for each visible satellite room.

### Key Patterns
- The RoomVisual mock in `test/setup.ts` records `roomName` per call, enabling multi-room verification.
- `Memory.runtime.synthesisControl` type requires mandatory fields: `updatedAt`, `generatedTaskCount`, `failedTaskCount`, `successfulRunCount`, `lastActions`, `bindings`, plus per-room `reagentLabIds`, `productLabIds`, `successfulRuns`, `pendingTasks`, `lastTransitionAt`.
- Tests for `renderHubProgressOverlays` set up full Memory/runtime context since it calls `collectHubProgressSnapshot()`.

### Test Coverage (4 new tests, 85 total in hubProgress)
- Satellite panel rendered in non-hub production rooms
- Skipped for rooms without Game.rooms visibility
- No satellite panels when productionRooms is empty
- Satellite panel shows product, stage, and progress text

## Task: Fix planDistributedSynthesis for Parallel Room Assignment

### Root Cause
Hub room monopolized all synthesis assignments because:
1. `scoreRoomForStep` gave hub +1 bonus (trivial) and +100 for local reagent availability
2. No mechanism to prevent a room from receiving multiple assignments
3. When `planHubChains` returned many candidates, hub scored highest for ALL of them since it had the most intermediates locally

### Fix: Three-Part Change
1. **`scoreRoomForStep`**: Added optional `usedRooms?: Set<string>` parameter. Rooms already in `usedRooms` get -300 penalty (stronger than +100 local-reagent bonus), effectively reserving them as last resort.
2. **`assignStepToRoom`**: Added `usedRooms: Set<string>` parameter. Also moved the global availability check to the top of the function and **clamps** `needed` to `Math.min(step.targetAmount, globalA, globalB)`. This prevents steps from being dropped entirely when previous assignments consumed part of the ledger — instead they produce a smaller batch.
3. **`planDistributedSynthesis`**: Tracks `usedRooms` set, passes to `assignStepToRoom`, adds room after each successful assignment.

### Key Design Decisions
- -300 penalty was chosen to be stronger than +100 local-reagent bonus but weaker than -200 busy-stage penalty (so busy rooms still lose to used rooms, but used rooms can be force-assigned if they're the only option and not busy).
- The `needed` clamping ensures that when ledger runs low after multiple assignments, subsequent steps still produce something rather than being dropped entirely.
- `usedRooms` is a soft constraint, not a hard filter — rooms CAN get a second assignment if no other room can handle the step.

### Backward Compatibility
- `scoreRoomForStep` parameter is optional — existing callers (tests) work unchanged.
- Single-room scenarios still produce same results: hub gets all assignments since `usedRooms` only forces distribution when multiple rooms are available.

### Test Coverage (3 new tests, 745 total)
- 7-room realistic inventory: verifies >1 assignment, ≤1 per room, ≥3 distinct rooms, tier ordering
- Cross-room reagent routing: hub supplies OH to satellite for T1 production
- One-per-room distribution: 3 rooms with abundant resources, first 3 assignments go to 3 distinct rooms

## Task: Fix wireRouteTransferTasks hub-as-source silent failure

### Root Cause
When `route.fromRoom === hubRoomName`, the fee comparison in `wireRouteTransferTasks` at line 1192 always set `preferDirect = false`:
- `feeToHub = calcTransactionCost(amount, hub, hub)` = 0
- `feeHubToTarget = calcTransactionCost(amount, hub, target)` = directFee
- `directFee >= 0 + directFee` → always true → preferDirect = false

Then the hub-route fallback called `createResourceTransferTask(hub, hub, ...)` which returned `"ERR_SAME_ROOM"` — silently ignored.

### Fix
Added `route.fromRoom !== hubRoomName` guard before the fee comparison. When source IS the hub, direct is the only valid path.

### Key Insight
Any route decision where `fromRoom` equals `hubRoomName` and `toRoom` is a satellite will ALWAYS hit this bug. The `createResourceTransferTask` return value is never checked — errors are silently swallowed.

## Task: Base Mineral Fair-Share Capping in planDistributedSynthesis

### Root Cause
`planDistributedSynthesis` iterated `chainResult.steps` directly. The first step (OH, target≈31k) consumed ALL O from the ledger, starving later steps (UO, KO, ZO etc.) that also need O. Hub had 33k O — enough for OH AND some UO, but OH monopolized it.

### Fix: Cap targetAmount by fair share of base minerals
Before the step assignment loop, count how many steps need each base mineral (`baseDemandCount`). For each step, cap `targetAmount` to `min(targetAmount, floor(ledger[base] / demandCount))` for each base mineral reagent. Steps capped to 0 are skipped entirely.

### Implementation Location
In `planDistributedSynthesis()` between the `planHubChains()` call and the step loop. ~25 lines of code.

### Key Design Decisions
- Only BASE_MINERALS (H, O, U, L, K, Z, X) are shared — intermediates and T3 are not capped by this mechanism (they already have ledger accounting).
- Capping is done BEFORE room assignment, not inside `assignStepToRoom`. This keeps the assignment logic clean.
- `Math.max(0, cap)` ensures no negative targets.
- Steps with `targetAmount === 0` after capping are skipped with `continue` — no assignment created.

### Test Coverage (4 new tests, 751 total)
- OH and UO both get fair share when O sufficient for both
- O scarce → UO gets capped/skipped
- All minerals abundant → no capping needed
- Step with 0 targetAmount → no assignment produced

### Backward Compatibility
- Single-room scenarios unchanged: capping still applies but with abundant resources there's no effective change.
- Existing 747 tests pass unchanged.

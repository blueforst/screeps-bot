# Learnings

## [2026-05-08] Task: plan-generation
- carrierTaskBoard uses `global.__carrierTaskBoard` (runtime global, not Memory). Tests must call `clearCarrierTaskBoardForTest()` in `beforeEach`.
- resourceTransferTasks use `Memory.data.resourceControl.tasks` (persistent). Task IDs are auto-generated as `{tick}:{seq}:{resource}:{from}->{to}`.
- transfer tasks can be merged: if a pending task with same from/to/resource/reason exists, amount is added.
- flagControl processors array is the single registration point (line 22).
- `createRoom` factory pattern: takes `{name, storageResources, terminalResources, nativeMineralType, hasExtractor}`.
- Terminal store mock needs `getUsedCapacity` and `getFreeCapacity` for resource checks.
- `Memory.cfg.resourceControl.rooms[name].terminalEnergyReserve` is per-room config.
- `Memory.cfg.resourceControl.rooms[name].mineralFloor` is per-resource per-room floor.

## [2026-05-09] Task 3: transfer-task tracking primitives
- `productionHub.ts` was a stub from earlier task (25 lines). Task 3 added ~180 lines of helpers.
- `createResourceTransferTask` returns `{ok: true, task}` on success (with merge support) or string error. The task ID is on `result.task.id`.
- `cancelResourceTransferTask` returns `{ok: true, taskId, previousStatus}` or string like `ERR_TASK_NOT_FOUND:xxx`. Safe to ignore string returns.
- `ensureResourceTransferTaskStore()` returns `Memory.data.resourceControl.tasks` — the live object. No need to re-read after mutations.
- Task reason format: `hub:inbound:{resource}` for imports, `hub:outbound:{resource}:{destRoom}` for exports.
- `HubState` interface defined locally in productionHub.ts since Task 2 (global.d.ts types) hasn't run yet.
- Test file (`productionHub.test.ts`) has pre-existing type errors from Task 1 scaffolding — `pos` shape mismatch and `disabledReactionsBackup` type mismatch. These are NOT caused by Task 3 changes.
- No bulk cancel helper was needed in `resourceTransferTasks.ts` — individual cancel in a loop is sufficient since `cancelAllHubTransferTasks` just iterates and clears.

## [2026-05-09] Task: TDD specification (productionHub.test.ts)
- `Memory.data.hubControl` is a SINGLE object (not Record<string, HubState>) per global.d.ts line 597. Shape: `{ roomName, flagName, pos, createdAt, updatedAt, taskIds, disabledReactionsBackup?, lastWarning?, lastSummary? }`.
- There is no `RESOURCE_CATALYZED_LEMERGIUM_HYDRIDE` constant. The 6 T3 boosts are: CATALYZED_UTRIUM_ACID, CATALYZED_KEANIUM_ALKALIDE, CATALYZED_LEMERGIUM_ALKALIDE, CATALYZED_GHODIUM_ALKALIDE, CATALYZED_ZYNTHIUM_ALKALIDE, CATALYZED_LEMERGIUM_ACID.
- `disabledReactionsBackup` is optional in the hubControl type — tests that set it must include it for completeness.
- The `createRoom` factory from resourceControl.test.ts needs a `labCount` option addition + `FIND_MY_STRUCTURES` handling for labs.
- When writing large test files via Edit tool, the oldString/newString replacement can leave trailing duplicates if the old content is very long. Truncate with `head -n N` to clean up.
- Test result: 13 fail (stub returns empty/null), 6 pass (no-op cases naturally pass). All compile cleanly.

## [2026-05-09] Task: chain-data-helpers
- `Memory.data.hubControl` is a single optional object (not a Record keyed by room name). The test assigns it directly.
- `RESOURCE_CATALYZED_LEMERGIUM_HYDRIDE` does NOT exist in `@types/screeps` or `@screeps/common`. The test from Task 1 references it as the 6th T3 target but the correct Screeps constant is `RESOURCE_CATALYZED_LEMERGIUM_ACID` ("XLH2O"). Polyfilled in global.d.ts + test mock.
- Screeps REACTIONS constant (in `@types/screeps/index.d.ts` line 443) maps `(mineral1) → (mineral2) → product`. Source minerals: H, O, U, L, K, Z, X. G is produced from ZK+UL, not a source mineral.
- Chain ordering matters for `getHighestReachable`: must process steps bottom-up so produced intermediates become available for subsequent steps.
- `RESOURCE_GHODIUM = "G"` is NOT a source mineral for XGHO2 chain — source minerals are H, O, Z, K, U, L, X.

## [2026-05-09] Task 4: runProductionHub() core planning pass
- `HubState.disabledReactionsBackup` type in local interface didn't match `global.d.ts` (line 597). Fixed to `Record<string, Array<{product?, targetAmount?, batchSize?, donorRoomNames?}>>`.
- `runProductionHub()` reads from `Memory.data?.hubControl` (single optional object). Returns early if undefined.
- Inbound planning: for each T3 target, gets `getSourceMinerals()`, checks HUB buffer (2000), finds donor rooms with surplus above mineral floor in storage+terminal, calls `createHubInboundTransfer`.
- `createHubInboundTransfer` validates terminal energy reserve and mineral floor on its own — planning pass just needs to determine surplus and call it.
- Outbound planning: only storage T3 counts toward safe reserve (1000). Pending inbound transfers (`getIncomingResourceTransferAmount`) counted to avoid overfill. HUB must have surplus above 1000 production reserve.
- Terminal offload uses `replaceCarrierTasksForProducerRoom("productionHub", roomName, drafts)` with `CarrierTaskDraft` from carrierTaskBoard. Priority 90 (same as resourceControl).
- `countPendingHubTasksForRoom` checks `reason?.startsWith("hub:")` — tasks with reason `"hub"` (no colon) are NOT counted. This is intentional: hub prefix format is `hub:inbound:{res}` or `hub:outbound:{res}:{dest}`.
- All 9 remaining test failures depend on `runProductionHubByFlag()` being a stub. Once implemented, they should pass.
- Test results: 10 pass, 9 fail (was 6 pass, 13 fail before).

## [2026-05-09] Task 5: updateHubSynthesisConfig — synthesis orchestration
- `updateHubSynthesisConfig(hubState, hubRoom, ownedRooms)` writes ordered reaction plans to `Memory.cfg.synthesisControl.rooms[hubRoom].reactions`.
- HUB-managed products set is the union of all intermediates across 6 chains (22 unique products). Built by iterating `getChainForTarget()` for each target in `HUB_T3_TARGETS`.
- Non-HUB rooms: reactions whose `product` is in the HUB-managed set are removed and backed up to `hubState.disabledReactionsBackup[roomName]`. Unrelated reactions are preserved.
- Lab check: need ≥3 labs for T3 synthesis. If insufficient, set `enabled=false`, clear reactions, log `[hub]` warning.
- Available resources: checked by scanning all 7 source minerals + all 22 chain products against HUB storage + terminal. Any resource with amount > 0 is added to the `available` set.
- `getHighestReachable(target, available)` determines the highest product that can be synthesized from available resources. Chain is truncated at that point.
- Reaction config format: `{ product, targetAmount: 1000, batchSize: defaultBatchSize, donorRoomNames: [] }`.
- Preserves unrelated reactions in HUB room: filters out HUB-managed products, appends new chain steps, then re-adds unrelated ones.
- File had duplicate code in `runProductionHubByFlag()` (lines 488-516 were duplicated after an earlier edit). Cleaned up.
- Debug `console.log` statements removed from `runProductionHubByFlag()`.
- Pre-existing test failures (2): inbound/outbound transfer tests fail because `createHubInboundTransfer` checks only terminal stock against floor, not storage+terminal. Planning pass uses total (storage+terminal) but transfer function enforces terminal-only floor. These are NOT synthesis-related.
- Synthesis tests (3/3 pass): lab shortage, idempotent double-run, backlog cap.
- `Memory.cfg.synthesisControl` structure (from global.d.ts): all fields optional, rooms keyed by name, each room has optional `enabled`, `reactions[]` with optional `product/targetAmount/batchSize/donorRoomNames`.

## [2026-05-09] Task 5: runProductionHubByFlag() flag lifecycle
- Flag naming pattern is `hub_` prefix (e.g., `hub_W1N1`), NOT exact `"HUB"`. Tests create flags like `Game.flags["hub_W1N1"]`.
- `runProductionHubByFlag()` collects ALL `hub_*` flags. If >1, warns about duplicate. Uses first flag found.
- Cleanup helper (`cleanupHubState`) cancels tasks, clears carrier tasks via `replaceCarrierTasksForProducerRoom("hubControl", room, [])`, restores `disabledReactionsBackup` to synthesis configs, then deletes `Memory.data.hubControl`.
- Lab count check: `room.find(FIND_MY_STRUCTURES, { filter: lab }).length < 3` → warn `[hub]`.
- Jest 29.7.0: `mockRestore()` clears spy call history. Must assert BEFORE `mockRestore()`, not after. Test file had this bug in 2 tests (duplicate HUB + lab shortage) — fixed by moving `expect()` before `mockRestore()`.
- `createHubInboundTransfer` and `createHubOutboundTransfer` return strings for BOTH success (task ID like `"100:1:U:W2N2->W1N1"`) and error (`"ERR_*"`). Cannot use `typeof result !== "string"` to distinguish. Use `!result.startsWith("ERR_")` instead.
- Inbound planning needed `inboundPlanned` accumulator to avoid duplicate mineral requests across multiple T3 chains that share source minerals (e.g., U is needed by both XUH2O and XGHO2 chains).
- `createHubInboundTransfer` was checking only terminal mineral for floor, not storage+terminal total. Fixed to check combined amount matching planner's logic.
- `createHubOutboundTransfer` was checking terminal energy reserve on HUB room, blocking outbound when HUB terminal energy was below 20000. HUB should distribute T3 without this check. Removed the energy reserve gate for outbound.

## Task 7: HUB main loop + flag control wiring (2026-05-09)

- `runProductionHub` inserted in main loop as `cpuProfiler.measure("hubControl", ...)` between `resourceControl` and `externalTelemetryExport` (line 59).
- `runProductionHubByFlag` added to `flagControl.ts` processors array, placed before `runScoutByFlag`.
- Carrier task producer renamed from `"productionHub"` → `"hubControl"` in `replaceCarrierTasksForProducerRoom` call (line 430) to match cleanup logic.
- Only one producer reference existed — the rename was a single-point change.
- All 278 tests pass, tsc clean, build succeeds.

## Task 8: HUB cleanup in memoryCleanup.ts (2026-05-09)

- `cleanupHubControlMemory(ownedRooms)` added to `memoryCleanup.ts`. Two behaviors: (1) delete entire `Memory.data.hubControl` if room no longer owned, (2) prune stale task IDs from `hubControl.taskIds` where the task in `Memory.data.resourceControl.tasks` is no longer pending.
- Placement: `cleanupHubControlMemory` called AFTER `cleanupResourceControlTaskMemory` — this is intentional because resourceControl cleanup deletes stale tasks first, then hub cleanup prunes the now-missing IDs from `hubControl.taskIds`.
- Test gotcha: tasks with `fromRoomName` not in owned rooms get deleted by `cleanupResourceControlTaskMemory` before hub cleanup runs. Tests need both from/to rooms owned to test the "stale status but room still owned" pruning path.
- 3 new tests added (room lost, room kept, stale task ID pruning). Total: 281 tests pass.

## Post-implementation fixes: flag naming + double execution (2026-05-09)

- Flag naming changed from `hub_` prefix scanning to exact `Game.flags["HUB"]` lookup — follows the same pattern as `SP` flag in flagControl.ts.
- With exact name matching, duplicate flags are impossible (object key uniqueness). Room mismatch detection replaces duplicate flag detection.
- `runProductionHubByFlag()` removed its internal `runProductionHub()` call — main.ts line 60 already calls it directly. This eliminates double execution per tick.
- Tests that called both functions (`runProductionHub()` then `runProductionHubByFlag()`) had to swap order: `runProductionHubByFlag()` first (creates state), then `runProductionHub()` (uses state for planning).
- All flag references changed from `hub_W1N1` to `HUB` in tests — `createFlag("HUB", "W1N1")`, `Game.flags["HUB"]`, `flagName: "HUB"`.

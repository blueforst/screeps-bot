# Hub Flag Full-Chain Production - Learnings

## Session: ses_1ee56479dffe110XR6FuFd1RyO (2026-05-10)

### Architecture
- hubPlanner runs BEFORE synthesisControl in main.ts tick pipeline
- synthesisControl is the sole lab executor; hubPlanner only writes config
- resourceTransferTasks handles all cross-room terminal transfers; no raw terminal.send()
- carrierTaskBoard is tick-local (global scope, regenerated each tick)
- Flag processors run AFTER synthesis in flagControl; HUB flag is one-shot setup only

### Key Files
- src/global.d.ts: Memory type definitions (hub config at cfg section, runtime at runtime section)
- src/main.ts: Tick order is behavior-critical
- src/runtime/flagControl.ts: Flag processor registration
- src/runtime/synthesisControl.ts: Lab reaction state machine executor
- src/runtime/resourceControl.ts: Terminal transfer executor, market, energy states
- src/runtime/logistics/resourceTransferTasks.ts: Persistent cross-room transfer task CRUD
- src/runtime/carrierTaskBoard.ts: Tick-local carrier task producer/consumer
- src/runtime/memoryCleanup.ts: Stale memory cleanup
- src/runtime/memoryService.ts: ensureCfg/ensureRuntime/ensureData helpers

### Screeps Constraints
- Terminal send cooldown: 10 ticks, sender pays energy cost
- Terminal capacity: 300k, storage: 1M
- Lab: range 2, one mineral type, 5 units per reaction, 3-10 labs depending on RCL
- T3 requires Catalyst(X) + T2 compound; all 7 base minerals needed
- 19 sequential reactions for 5 T3 compounds (OH shared)

### Task 5: Import/Reclaim Planning
- `planHubImports()` scans eligible satellites (controller.my + storage + terminal)
- BASE_MINERAL_SAFETY_FLOOR = 500 (keep in satellite for base minerals)
- surplusThreshold = reservePerRoom + 500 = 1500 (trigger for T3 reclaim)
- T3 reclaim amount = satellite_amount - reservePerRoom (drain to 1000, never below)
- Duplicate prevention: check existing pending hub-bound tasks by `fromRoom:resource:reason` key
- Survival economy rooms skipped via Memory.runtime.resourceControl.rooms[name].state
- Hub storage free capacity check uses store.getFreeCapacity() (total free, not per-resource)
- Runtime services must be cleared between tests: `(global as any).__runtimeServices = undefined` before `registerRuntimeServices()` — tick context service caches by Game.time and stale snapshots cause wrong rooms
- INTERMEDIATE_COMPOUNDS: 14 items (OH, ZK, UL, G, UH, UO, LO, GH, GO, UH2O, UHO2, LHO2, GHO2, GH2O)

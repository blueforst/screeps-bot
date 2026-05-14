
## Task 1: Primary disabled-room lab cargo cleanup

### Key findings:
- `generateStrandedProductUnloadTask()` returns `{ task, product, targetAmount } | null`, NOT just the task. Must extract `.task` from result.
- `countPendingToRoom()` counts inter-room terminal transfers (from `resourceControl.tasks`), NOT carrier tasks. In test scenarios with no terminal transfers, it returns 0. Don't assert > 0.
- `reactions: []` in config causes `normalizeRoomConfig()` to set `enabled = false` — this is the standard way to disable a room.
- `resolveLabTopology()` works independently of `enabled` flag — just needs 3+ labs in room.
- Lab topology `reagentLabIds` defaults to `[]` when not set in config, causing the brute-force topology search path.
- The `const room = Game.rooms[roomName]` inside the `if (!roomCfg.enabled)` block is block-scoped, so no conflict with the outer-scope `const room` declaration that comes after the early return.

### Implementation pattern:
- Product unload takes priority over reagent cleanup (same pattern as no-activePlan branch).
- `stage: "unloading"` only when a cleanup task exists; otherwise `"blocked"`.
- `lastError: "room_config_disabled"` in ALL disabled-branch paths for diagnostic consistency.
- The disabled branch must handle 3 sub-cases: room/terminal unavailable, no topology, cleanup tasks.

## Task 2: Edge-case regression tests

### Key findings:
- `createStore()` closure captures the `resourceMap` object reference, NOT `_resourceMap`. Setting `_resourceMap = {}` breaks the mock because the store still reads from the old map. Must mutate in-place: `delete _resourceMap[resource]`.
- The disabled branch handles 4 sub-cases: room not visible → `room_or_terminal_unavailable`, <3 labs → `lab_topology_unavailable`, no cargo → `room_config_disabled` with stage "blocked", has cargo → "unloading" with cleanup task.
- `lab_topology_unavailable` path sets `reagentLabIds` and `productLabIds` to empty arrays.
- Product unload always takes priority over reagent cleanup in the disabled branch (same pattern as enabled no-activePlan branch).
- When creating rooms with fewer than 3 labs, must use manual room construction (not `createSynthesisRoom` which defaults to 3 labs).

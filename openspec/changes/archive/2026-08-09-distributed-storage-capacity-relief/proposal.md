## Why

Owned rooms currently have extreme storage skew: several storages and terminals are full while other rooms still have hundreds of thousands of free capacity. The existing resource controller classifies rooms mainly by storage energy and has no capacity-relief planner, so blocked transfer tasks and saturated terminals can stall logistics indefinitely.

## What Changes

- Add hysteresis-based capacity states that are independent of the existing energy survival/balanced/export state.
- Plan bounded internal transfers from pressured rooms to eligible receiver rooms, prioritizing survival energy and immediately movable terminal stock before storage surplus.
- Protect energy floors, terminal energy reserves, active production inputs, boost/factory reservations, valid outgoing commitments, and per-room T3 reserves from relief exports.
- Extend automatic resource-transfer tasks with explicit blocker/progress state, recovery behavior, and finite no-progress cleanup while preserving manual tasks.
- Reconcile stale automatic tasks after rollout so source-depleted and superseded work stops reserving phantom capacity.
- Expose real storage/terminal occupancy, capacity state, all pending transfer tasks, blocker age, and recent relief routes to runtime analytics and the monitor service.
- Keep market liquidation outside this change; capacity relief uses owned-room terminal transfers only.

## Capabilities

### New Capabilities

- `distributed-storage-capacity-relief`: Detect room capacity pressure and safely route bounded internal transfers with hysteresis, reservation protection, deterministic priorities, and receiver safety buffers.
- `resource-transfer-task-health`: Track automatic transfer progress and blockers, distinguish healthy reservations from phantom incoming supply, and retire stalled automatic work without deleting manual tasks.
- `resource-logistics-observability`: Report complete capacity and transfer-task health data through runtime memory and the monitor service.

### Modified Capabilities

None. The repository does not currently contain baseline OpenSpec capability specs for resource logistics.

## Impact

- Primary runtime changes: `src/runtime/resourceControl.ts` and `src/runtime/logistics/resourceTransferTasks.ts`.
- Integration changes: Hub, synthesis, boost, factory, and terminal carrier-task reservation reads must use the same task-health semantics.
- Type and configuration changes: `src/global.d.ts` and `Memory.cfg.resourceControl.capacityBalancing`.
- Monitoring changes: `scripts/monitor-service.mjs` and persisted `Memory.runtime.resourceControl` data.
- Test changes: focused resource-control/task-lifecycle coverage plus live-like saturated-room fixtures; no new dependency or external API is required.

## 1. Transfer Task Health Foundation

- [x] 1.1 Add failing task-store tests for explicit origin, progress timestamps, blocker transitions, healthy reservation semantics, automatic timeouts, manual retention, and idempotent legacy migration.
- [x] 1.2 Extend `ResourceTransferTask` and Memory types with origin/progress/blocker fields, add manual and automatic creation paths, and implement blocker helpers plus v2 reconciliation.
- [x] 1.3 Update Hub, synthesis, compatibility synthesis, power-bank boost, and other generated transfer producers to use the automatic task path while keeping console APIs manual.
- [x] 1.4 Replace legacy incoming/outgoing health checks and cleanup rules with the tested blocker-aware semantics without changing terminal-record retention.

## 2. Capacity State and Protected Stock

- [x] 2.1 Add failing resource-control tests for configuration normalization, emergency/pressure/normal transitions, persisted hysteresis, and independent energy/capacity states.
- [x] 2.2 Implement capacity-balancing configuration, snapshot occupancy fields, hysteretic capacity-state calculation, and runtime persistence.
- [x] 2.3 Add failing tests for protected energy/mineral/T3/production/outgoing amounts and total-energy survival donors.
- [x] 2.4 Implement the shared protected/movable stock calculation and update survival energy balancing to preserve all donor safety amounts and transaction cost.

## 3. Capacity Relief Planning and Execution

- [x] 3.1 Add failing planner tests for receiver admission, safety-buffer send caps, terminal-first selection, storage staging, deterministic receiver ranking, per-source/global bounds, retargeting, and no-receiver behavior.
- [x] 3.2 Implement `capacity:relief:<resource>` planning before queued execution with one healthy route per source, 50,000-unit task caps, five-task planning bounds, and atomic retargeting.
- [x] 3.3 Add failing execution tests for automatic priority order, shared five-send budget, blocker marking/recovery, and successful progress updates.
- [x] 3.4 Integrate capacity priority and blocker transitions into task execution while preserving existing carrier feed/offload behavior and market isolation.
- [x] 3.5 Add a live-like regression fixture covering multiple full source rooms, eligible low-occupancy receivers, stale automatic tasks, protected resources, and repeated cycles without ping-pong.

## 4. Logistics Observability

- [x] 4.1 Add runtime analytics assertions for occupancy, capacity state, actual terminal reserve, complete pending-task aggregates, blocker ages, and recent relief routes.
- [x] 4.2 Extend the bounded resource-control runtime projection and global Memory types with the required room/task health aggregates.
- [x] 4.3 Update `scripts/monitor-service.mjs` to project the complete task store, accurate terminal reserve, capacity state, blocker/progress ages, and relief actions; verify its syntax and fixture projection.

## 5. Verification and Rollout

- [x] 5.1 Run focused task-store/resource-control/Hub/synthesis/power-bank suites and fix regressions.
- [x] 5.2 Run the full Jest suite, `npx tsc --noEmit`, `npm run build`, and `node --check scripts/monitor-service.mjs` with clean results.
- [x] 5.3 Review the implementation against every OpenSpec scenario, task-store CPU bounds, and the diff; fix all actionable findings.
- [x] 5.4 Deploy with `npm run push`, verify the active Screeps branch/deploy tag, and observe at least two resource-control cycles for stale-task reduction, relief progress, capacity recovery, and intact receiver/protection buffers.

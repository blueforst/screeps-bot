## Context

The current resource controller has two independent shortcomings that combine into a logistics deadlock:

- Room state is derived from storage energy (`survival`, `balanced`, or `export`), not from structure occupancy. A room can therefore have a full storage while still being classified as `survival`.
- Every transfer applies fixed receiver buffers (100,000 storage free and 40,000 terminal free), but a task that cannot satisfy those buffers is silently skipped. The task records no receiver-capacity blocker and only one existing blocker can expire.

A read-only live snapshot before this change found four 1,000,000-capacity storages, two full terminals, 50 pending transfer tasks, 45 receiver-capacity-blocked tasks, 33 tasks older than 10,000 ticks, and 18 tasks whose source had no remaining stock. Meanwhile several owned rooms retained 300,000-600,000 storage free capacity. The monitor exposed none of this backlog because it only counted a subset of Hub tasks.

The implementation must preserve existing terminal transfer tasks, carrier staging, synthesis/Hub planning, room energy safety, and the main-loop phase order. It must also remain bounded enough for Screeps CPU and Memory limits.

## Goals / Non-Goals

**Goals:**

- Relieve storage or terminal pressure through safe owned-room transfers whenever an eligible receiver exists.
- Stop relief at recovery watermarks instead of continuously equalizing every room.
- Preserve local safety stock and all valid production or outgoing reservations.
- Make automatic transfer tasks self-healing and observable without auto-cancelling user-created tasks.
- Make rollout safe, reversible, and measurable against the live shard.

**Non-Goals:**

- Equalize room inventories or assign a globally optimal resource distribution.
- Sell resources to the market because a room is full.
- Add a creep role or replace the existing carrier-task staging system.
- Rewrite Hub or synthesis planning, or reorder unrelated main-loop phases.
- Move resources from a room that cannot satisfy its protected amount.

## Decisions

### 1. Add a persisted capacity state beside the energy state

Each snapshot gains `capacityState: "normal" | "pressure" | "emergency"`, storage/terminal used and free capacity, and the prior persisted capacity state. Capacity state does not change `state: "survival" | "balanced" | "export"`.

Default configuration lives under `Memory.cfg.resourceControl.capacityBalancing`:

| Field | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Enable planning while the parent resource controller is enabled |
| `storagePressureFreeCapacity` | `100_000` | Enter pressure at or below this storage free capacity |
| `storageReliefTargetFreeCapacity` | `200_000` | Storage recovery watermark |
| `receiverStorageMinFreeCapacity` | `300_000` | Minimum storage free capacity for a new receiver route |
| `terminalPressureFreeCapacity` | `40_000` | Enter pressure at or below this terminal free capacity |
| `terminalReliefTargetFreeCapacity` | `80_000` | Terminal recovery watermark |
| `receiverTerminalMinFreeCapacity` | `50_000` | Minimum terminal free capacity for a new receiver route |
| `maxPlannedAmountPerTask` | `50_000` | Maximum amount committed by one relief task |
| `maxNewTasksPerRun` | `5` | Global bound on new/replacement relief tasks per planning run |
| `automaticTaskNoProgressTtl` | `5_000` | Cancel an automatic pending task with no successful send |
| `sourceDepletedGraceTicks` | `100` | Grace before cancelling an automatic source-depleted task |
| `t3ReservePerRoom` | `5_000` | Per-room protected amount for each T3 boost compound |

State transitions use hysteresis:

- Any full storage or terminal is `emergency`.
- A previously normal room enters `pressure` when either pressure threshold is crossed.
- A pressured/emergency room remains non-normal until storage free is at least 200,000 **and** terminal free is at least 80,000.
- An emergency room becomes `pressure`, not `normal`, after the full condition clears but before both recovery watermarks are met.

Persisting the state prevents oscillation in the 100,000-200,000 storage and 40,000-80,000 terminal bands.

**Alternatives considered:** continuous equalization would create terminal churn, transaction cost, and ping-pong. A single threshold without persisted hysteresis would repeatedly start and stop routes near the boundary.

### 2. Plan bounded relief routes, not direct sends

`runResourceControl` keeps its existing outer phase and adds capacity planning before queued task execution:

1. collect snapshots and reconcile task health;
2. attempt survival energy support;
3. plan or retarget capacity-relief tasks;
4. execute queued transfer tasks;
5. synchronize terminal carrier feed/offload tasks;
6. run existing market operations.

The planner creates normal resource-transfer tasks with reason `capacity:relief:<resource>`. It never calls `terminal.send` and never creates a market order/deal. A source may have at most one healthy pending capacity-relief task, and each planning run may create or replace at most one task per source and five globally.

For a new route, a receiver must:

- own both storage and terminal;
- have `capacityState === "normal"`;
- have at least 300,000 storage free and 50,000 terminal free.

Existing routes can continue below those admission watermarks, but execution still caps each send so the receiver retains the configured storage and terminal buffers. Because pressure entry is inclusive at the threshold, capacity-relief sends keep one additional unit of headroom; a receiver admitted at exactly 50,000 terminal free therefore stops at 40,001 instead of immediately becoming pressured. A pressure/emergency room is never a relief receiver.

Receiver ranking is deterministic: greatest safe receivable capacity first, then lowest current stock of the selected resource, then lowest transaction energy cost, then room name. This favors meaningful relief without turning transaction cost into the only objective.

When the source terminal is below its recovery watermark, the planner first selects the largest movable non-energy resource already in the terminal; movable surplus energy is a fallback only after energy protection. When terminal recovery is satisfied and storage still needs relief, it selects the largest movable storage surplus and lets the existing terminal-feed carrier task stage that resource. If terminal pressure returns while a storage-only relief route is pending, carrier staging stops and the route is atomically replaced by a terminal-resident candidate; when none is movable, the stale automatic route is cancelled so it cannot occupy the source's only relief lane. If both structures are pressured, terminal relief comes first so a staging lane is restored.

Planned amount is the minimum of:

- the relevant structure's recovery gap;
- movable source stock;
- receiver safe receivable capacity;
- `maxPlannedAmountPerTask`.

Execution remains batched by the source room's existing `transferBatchSize` (10,000 by default). A shared internal-send budget retains the configured maximum of five owned-room terminal sends per resource-control run. A terminal-resident task can progress in the same planning run; a storage-resident task progresses after carrier staging.

If an existing relief receiver becomes unsafe, the task remains a reservation while blocked. When a different eligible receiver exists, the planner cancels and atomically replaces that automatic task instead of adding a duplicate. Otherwise it waits for receiver recovery or normal automatic-task expiry.

**Alternatives considered:** direct terminal sends would bypass the established task log, task priorities, batching, carrier staging, and console inspection. Market-first liquidation would free space faster but makes an irreversible pricing decision and is explicitly excluded from v1.

### 3. Compute a single protected amount before exporting a resource

For each source/resource pair, movable stock is:

`storage + terminal - protected - healthy pending outgoing commitments`

clamped to zero and to the amount actually present in the selected structure.

The protected amount is the maximum/aggregate required by the existing authoritative systems:

- energy: room `energyFloor` plus `terminalEnergyReserve`; transaction energy must also remain payable without crossing the terminal reserve;
- base minerals: configured `mineralFloor`;
- T3 boost compounds: `t3ReservePerRoom`;
- active production: unexpired resource reservations and current synthesis, boost, or factory commitments;
- pending outgoing tasks: remaining amounts of healthy pending work, excluding the capacity task currently being evaluated.

Survival energy support also uses total room energy rather than storage energy alone. A donor is eligible when total energy exceeds its energy floor, terminal reserve, production reservations, outgoing commitments, and send cost. This allows terminal-heavy rooms to help a survival receiver without draining their own safety stock.

The implementation centralizes this calculation so relief planning, energy support, and terminal staging cannot disagree about exportable stock.

### 4. Give transfer tasks explicit origin, blocker, and progress state

`ResourceTransferTask` gains:

```ts
origin: "manual" | "automatic";
blockedReason?: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee";
blockedSince?: number;
lastProgressAt: number;
```

`lastError` remains for command cancellation, invalid routes, and terminal return codes; normal retry conditions use `blockedReason`. A new automatic-task creation wrapper marks Hub, synthesis, power-bank boost, energy-support, and capacity tasks as automatic. Legacy `auto:synthesis:` compatibility tasks are also recognized as generated. Existing console APIs keep creating manual tasks by default.

Health transitions are explicit:

- zero visible source stock marks `source_depleted` before receiver-capacity evaluation;
- no safe receiver capacity marks `receiver_capacity`;
- source stock exists but cannot be staged/sent or cannot pay the fee marks `insufficient_terminal_resource_or_fee`;
- the first occurrence sets `blockedSince`; repeated checks do not reset it;
- a successful send clears blocker fields and updates `lastProgressAt` and `updatedAt`;
- restored conditions clear the blocker and allow execution without recreating the task.

Blocker health is reevaluated for every pending task even after the shared send budget is exhausted. This health-only pass never sends, and a terminal return-code failure retains any pre-existing supply blocker until either its condition is independently observed as restored or a send succeeds.

Reservation semantics deliberately differ by blocker:

- `receiver_capacity` and `insufficient_terminal_resource_or_fee` remain healthy incoming/outgoing reservations, preventing duplicate planning;
- `source_depleted` is excluded from healthy incoming supply after the 100-tick grace, so Hub and synthesis do not see phantom inventory;
- all pending tasks remain visible in the raw operational list.

Automatic tasks are cancelled when source depletion lasts 100 ticks or no successful send occurs for 5,000 ticks. Manual tasks are never cancelled by these liveness rules. Terminal (`done`, `cancelled`, `failed`) record retention keeps its existing short cleanup behavior.

**Alternatives considered:** deriving all lifecycle behavior from `lastError` conflates retry state with failures and cannot represent capacity blocking. Expiring every old task would delete intentional manual work.

### 5. Persist complete operational analytics

`Memory.runtime.resourceControl` persists for every controlled room:

- energy state and capacity state;
- storage/terminal used and free capacity;
- configured energy floor and terminal energy reserve;
- pending incoming/outgoing counts and blocked counts by reason;
- recent capacity-relief actions/routes.

The monitor reads the complete transfer-task store, not only Hub progress tasks. It reports origin, reason, remaining amount, age, blocker, blocker age, and last-progress age. `roomTerminalBlockers.reserve` uses the actual `terminalEnergyReserve`, not `energyFloor`.

Action logs remain bounded through the existing log limiter; task aggregates are computed in one pass to avoid recreating the previous Hub task-scan CPU regression.

### 6. Migrate legacy tasks conservatively and idempotently

`Memory.data.resourceControl.taskSchemaVersion` gates a one-time v2 reconciliation:

- infer `automatic` only for known generated reason prefixes (`hub:`, `synthesis:`, `auto:synthesis:`, `powerBankBoost`, `energy-support`, and `capacity:`); unknown or absent reasons become `manual`;
- initialize `lastProgressAt` from `updatedAt`, falling back to `createdAt`;
- translate the legacy insufficient-terminal blocking error into the explicit blocker;
- evaluate already-stale automatic tasks against the 100/5,000 tick rules;
- preserve every manual or unknown legacy task.

The migration is safe to rerun and does not require a separate console command. Newly cancelled legacy tasks remain visible until normal terminal-record cleanup.

## Risks / Trade-offs

- **[Receiver capacity is temporary]** → Every send rechecks safety buffers; blocked routes can be atomically retargeted without duplicate reservations.
- **[Relief competes with production]** → Central protected-stock calculation and explicit automatic priorities prevent moving active inputs.
- **[A protected-only full terminal cannot be relieved]** → Keep the room blocked and observable rather than violate reserves; no unsafe market fallback is introduced.
- **[Large rooms take multiple cycles to recover]** → 50,000-task and 10,000-send bounds intentionally trade speed for CPU, cooldown, and rollback safety.
- **[Legacy task origin is ambiguous]** → Only known prefixes are automatic; ambiguity defaults to manual preservation.
- **[Monitoring adds Memory/CPU cost]** → Persist aggregates and bounded recent actions, and scan the task store once per resource-control run.

## Migration Plan

1. Ship task schema/type changes and tests with capacity planning behind `capacityBalancing.enabled`.
2. On the first live run, execute the idempotent v2 reconciliation before any planner reads task reservations.
3. Enable capacity balancing by default with the bounded thresholds above; no live config rewrite is required.
4. Verify locally with focused suites, the full Jest suite, `tsc --noEmit`, and the production bundle.
5. Deploy through the existing Screeps push flow and verify the active branch/deploy tag separately from the local Git commit.
6. Observe at least two planning cycles: stale automatic tasks decrease, eligible relief tasks progress, full rooms gain free capacity, and receiver buffers/reserves remain intact.

Rollback is `Memory.cfg.resourceControl.capacityBalancing.enabled = false` followed by the previous code bundle if necessary. Disabling planning does not delete tasks or alter market settings; already-created capacity tasks can be cancelled through the existing task API.

## Open Questions

None for v1. Thresholds are configurable so live evidence can tune them without changing the state machine.

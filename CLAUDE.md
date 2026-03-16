# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript only (no upload)
npm run push           # Compile + upload to Screeps server (requires .secret.json)
npm run local          # Compile + copy to local scripts folder
npm run watch          # Compile in watch mode
npm run test           # Run Jest tests
npm run test-c         # Run Jest with coverage
npx tsc --noEmit       # Type-check only (no eslint configured)
```

`.secret.json` holds deploy credentials (`main.token`, `local.copyPath`). Never commit it.

## Architecture

Single-bundle TypeScript bot. Rollup bundles `src/` into `dist/main.js`. Each game tick runs `gameLoop()` in `src/main.ts`.

### Tick Execution Order (`src/main.ts`)

Order is **behavior-critical** — do not reorder phases casually:

1. Deploy announcement
2. Production monitoring
3. Resource/mineral management
4. Telemetry + memory cleanup
5. Infrastructure (portals, flags, cross-shard, defenses, tower, links)
6. Task management (worker tasks, bootstrap configs)
7. Spawn execution
8. Creep execution (`.work()` on each creep)
9. CPU profiler flush

### Creep Execution Pattern

Creeps and spawns are called via **prototype extension** (`src/mount/`). `main.ts` never calls role logic directly — it calls `spawn.work()` / `creep.work()`, which dispatch to role factories registered in `src/roles/index.ts`.

### Role Lifecycle

Each role is a state machine with two phases:
- `source` phase — acquires energy; returns `true` to switch to target
- `target` phase — consumes energy (build/deliver/upgrade); returns `true` to switch to source

The mount layer handles the immediate second-phase call on switch to avoid one-tick idle.

### Config-Driven Spawning

`CreepConfig` objects are stored in `Memory.creepConfig` (managed by `src/runtime/creepApi.ts`). Config names are canonical IDs: `<room>:<role>:<index-or-sourceId>`. `bootstrapRooms()` reconciles source counts → harvester/miner configs. `scheduleSpawnTasks()` queues them per priority. Both depend on `global.creepApi` being initialized before mounts run.

### Memory Layout

| Key | Purpose |
|-----|---------|
| `Memory.cfg` | User/operator config |
| `Memory.runtime` | Ephemeral per-tick state |
| `Memory.data` | Persistent bot data |
| `Memory.analytics` | Metrics/telemetry |

### Key Service Locations

| Task | File |
|------|------|
| Worker count policy | `src/runtime/roomWorkforce.ts` |
| Worker task creation/assignment | `src/runtime/workerTaskPool.ts` |
| Spawn queue policy | `src/runtime/spawnPlanner.ts` |
| Emergency carrier spawning | `src/runtime/emergencySpawning.ts` |
| Energy pickup/store targeting | `src/roles/energyTargets.ts` |
| Pickup reservation lifecycle | `src/runtime/energyPickupReservation.ts` |
| Tower behavior | `src/runtime/towerControl.ts` |
| Room bootstrap (source → config reconciliation) | `src/runtime/bootstrap.ts` |
| Console API commands | `src/runtime/consoleCommands.ts` |

## Critical Conventions

- **Worker tasks** use string-prefixed IDs (`build:`, `repair:`, `upgrade:`) stored in room memory. Do not bypass `maxAssignees` checks.
- **Reservation pattern**: any reservation-like structure needs explicit release + stale-entry cleanup. Do not weaken release paths.
- **Emergency rampart repair** is tower-led; worker repair is normal-tier only. Do not make it a worker task.
- **Energy targeting** is centralized in `src/roles/energyTargets.ts`. Movement/travel helpers stay in `src/roles/shared.ts`. Do not merge these concerns.
- **`refreshWorkerTasks()`** is cadence-gated; consumers must tolerate stale task windows.
- Do not delete configs still referenced by live creeps.
- Do not add new global exports unless needed for console ops.
- `src/modules/autoplanner/` is mixed JS/TS with non-strict typing; avoid touching its internals unless integration requires it.

## Testing

Jest with ts-jest. Mock globals are set up in `test/setup.ts`; Screeps API mocks in `test/mock/index.ts`. No browser environment — pure Node.

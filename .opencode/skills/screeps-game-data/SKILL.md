---
name: screeps-game-data
description: Use when diagnosing this Screeps bot with live in-game Game, Memory, room, creep, task, hub, CPU, telemetry, monitor, shard, or RawMemory data instead of relying only on code inspection.
compatibility: opencode
metadata:
  project: screeps
---

# Screeps Game Data

## Overview

Live Screeps state is the source of truth for runtime bugs. Before changing scheduling, hauling, synthesis, hub, spawn, or role logic based on assumptions, read current in-game data through this project's monitor/API path and compare observed state with the expected code path.

## Required First Check

Run from the repository root:

```bash
npm run monitor:once
```

This uses `.secret.json` or `SCREEPS_TOKEN`, auto-selects the active shard, fetches `Memory.analytics`, prints a JSON snapshot, and appends it to `monitor-data/snapshots.jsonl`.

Confirm these fields before reasoning from the snapshot:

| Field | Why it matters |
| --- | --- |
| `memory.summary.latestTick` | Data is fresh enough for the issue being diagnosed |
| `memory.selectedShard` | You are looking at the active shard, not an empty one |
| `memory.summary.rooms` | Room-level production, worker, carrier, source, and storage signals |
| `memory.moduleCpu` | CPU profiler data, when enabled in game |
| `memory.hub` | Hub progress and logistics state, when enabled in game |

## Long-Running Monitor

Use server mode when you need repeated reads while debugging behavior across ticks:

```bash
npm run monitor:serve
```

Then query read-only endpoints:

```bash
curl http://127.0.0.1:3131/health
curl http://127.0.0.1:3131/state
curl http://127.0.0.1:3131/rooms
curl http://127.0.0.1:3131/history
curl http://127.0.0.1:3131/cpu
curl http://127.0.0.1:3131/hub
```

Stop the monitor when finished. Do not commit `monitor-data/`; it is ignored generated output.

## Segment Telemetry

Use RawMemory segment polling only when `Memory.analytics` lacks the needed detail and segment export is already enabled in game:

```bash
SCREEPS_MONITOR_SEGMENT_ID=90 npm run monitor:once
```

Common console helpers exposed by the bot include `startTelemetry()`, `stopTelemetry()`, `statusTelemetry()`, `startCpuProfiler()`, `stopCpuProfiler()`, and `statusCpuProfiler()`. These modify in-game config, so do not enable or disable them silently when the user only asked for read-only diagnosis.

## Game Console API

Use the console API when monitor data is insufficient and you need to run a Screeps console expression such as `Game.time`, `statusTelemetry()`, `hubProgressRaw()`, or a focused `Memory` inspection.

First verify which shard is actually executing console commands. `monitor:once` may show stale `Memory.analytics` from an older shard, so do not trust the selected shard until a console probe succeeds:

```bash
node .opencode/skills/screeps-game-data/console-api.mjs --probe
```

The probe temporarily writes `Memory.__opencodeSkillProbe`, waits until it can read that key back through the memory API, then enqueues cleanup on all probed shards. A passing result looks like this:

```json
{
  "consoleMemoryProbe": true,
  "observed": {
    "requestShard": "shard1",
    "tick": 70923100,
    "shard": "shard1"
  }
}
```

Then enqueue a specific console expression on the observed shard:

```bash
node .opencode/skills/screeps-game-data/console-api.mjs --shard shard1 --expr "Game.time"
```

Important: `POST /api/user/console` confirms that the command was accepted, not that its return value was captured. For reliable agent-readable results, prefer `npm run monitor:once` or API memory reads. Use console expressions for built-in console helpers, state probes not exported by telemetry, or temporary diagnostics.

## Safety Rules

- Treat `.secret.json` and tokens as secrets; never print, copy, or commit them.
- Prefer read-only monitor/API access. Do not mutate `Memory`, create flags, spawn creeps, or run console write helpers unless the user explicitly approves that action.
- Treat console expressions as production actions. `Game.*` reads and status helpers are safe; `Memory` writes, flag operations, spawn operations, market operations, and telemetry toggles require explicit user approval except for the temporary `--probe` cleanup flow above.
- If a runtime issue persists after a code fix, read live `Memory`/monitor state again before guessing. Compare actual assignments, task board entries, creep memory, room state, and selected shard against the assumed path.
- If console commands enqueue successfully but no state changes, probe multiple shards. A stale high tick in old `Memory.analytics` can beat a currently active shard with a lower absolute tick.
- If monitor data is stale or missing, report the exact missing field and check shard/telemetry configuration before changing code.
- If the issue depends on a specific creep/room/resource, capture the concrete IDs and tick from live data and mention them in the diagnosis.

## Common Mistakes

| Mistake | Correct behavior |
| --- | --- |
| Guessing from source code only | Run `npm run monitor:once` first for live state |
| Debugging the wrong shard | Verify `memory.selectedShard` and `latestTick` |
| Trusting stale monitor shard choice | Run `console-api.mjs --probe` before console work |
| Assuming telemetry exists | Check `moduleCpu.available`, `hub.available`, or segment presence |
| Using console writes for convenience | Stay read-only unless the user authorizes mutation |
| Sharing command output with secrets | Summarize state; never expose token-bearing config |

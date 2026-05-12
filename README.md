# Screeps Local Dev Setup (Tutorial 1-4)

This repository follows HoPGoldy's Screeps environment series up to section 4:

1. VSCode autocomplete
2. Rollup build and upload
3. TypeScript static checks
4. Jest unit tests

Section 5 (`screeps-server-mockup`) is intentionally skipped.

## Prerequisites

- Node.js >= 16
- npm >= 8

## Setup

1. Install dependencies:

```bash
npm install
```

2. Edit `.secret.json`:

- `main.token`: your Screeps auth token
- `local.copyPath`: your Screeps local scripts directory

Token page: `https://screeps.com/a/#!/account/auth-tokens`

## Project Structure

- `src/main.ts`: game entry, scheduler, spawn/creep work dispatch
- `src/runtime/creepApi.ts`: global `creepApi` config management
- `src/runtime/bootstrap.ts`: room-based default config bootstrap
- `src/runtime/spawnPlanner.ts`: config-driven spawn task scheduling
- `src/mount/`: prototype mounting (`Creep.work`, `Spawn.work/addTask/mainSpawn`)
- `src/roles/`: role lifecycle factories (`source/target/prepare`)
- `src/config/spawnProfiles.ts`: role body templates by room energy capacity
- `src/types/system.ts`: architecture core types
- `src/modules/errorMapper.ts`: source-map based stack trace mapper
- `test/setup.ts`: Jest test environment setup
- `test/mock/index.ts`: basic Screeps global mocks (`Game`, `Memory`, `_`, constants)

## Commands

- `npm run build`: compile only (no upload)
- `npm run local`: compile and copy bundle to local scripts folder
- `npm run push`: compile and upload to Screeps server
- `npm run watch`: compile in watch mode
- `npm run monitor:serve`: run external monitor service (HTTP + polling)
- `npm run monitor:once`: fetch one snapshot and exit
- `npm run test`: run Jest tests
- `npm run test-c`: run Jest coverage report

## Notes

- `.secret.json` is ignored by git. Do not commit tokens.
- If `npm run push` returns `Not Authorized`, check `main.token` in `.secret.json`.
- Rollup output is a single `dist/main.js`, matching Screeps runtime requirements.

## External Monitor (MVP)

This repo includes an external monitor service at `scripts/monitor-service.mjs`.

Note: the monitor service uses native `fetch` and requires Node.js 18+ (Node 24 recommended).

- Primary source: `Memory.analytics.production` (already maintained by `runProductionMonitor`)
- Optional debug source: `RawMemory.segments[segmentId]` produced by `runExternalTelemetryExport`

### 1) Optional: enable segment debug telemetry in game

Run in Screeps console:

```js
Memory.cfg = Memory.cfg || {}
Memory.cfg.telemetry = {
  enabled: true,
  sampleInterval: 10,
  segmentId: 90
}

// Quick global commands
startTelemetry()      // use defaults: sampleInterval=10, segmentId=90
startTelemetry(5, 91) // custom sample interval and segment
stopTelemetry()       // disable export quickly
statusTelemetry()     // inspect current telemetry config

Memory.cfg.cpuProfiler = {
  enabled: true,
  sampleInterval: 10,
  historyLimit: 120
}

startCpuProfiler()          // defaults: sampleInterval=10, historyLimit=120
startCpuProfiler(5, 200)    // custom sample interval and history
stopCpuProfiler()           // disable profiler quickly
statusCpuProfiler()         // inspect current cpu profiler config
```

### 2) Run the monitor

If `.secret.json` has `main.token`, token is loaded automatically.

```bash
npm run monitor:serve
```

With explicit token and segment polling:

```bash
SCREEPS_TOKEN=your-token SCREEPS_MONITOR_SEGMENT_ID=90 npm run monitor:serve
```

If your active room is on a non-default shard (for example `shard2`):

```bash
SCREEPS_MONITOR_SHARD=shard2 SCREEPS_MONITOR_SEGMENT_ID=90 npm run monitor:serve
```

One-shot snapshot mode:

```bash
npm run monitor:once
```

### 3) Read monitor outputs

- HTTP summary: `http://127.0.0.1:3131/`
- Health: `http://127.0.0.1:3131/health`
- Full state: `http://127.0.0.1:3131/state`
- Room list: `http://127.0.0.1:3131/rooms`
- Poll history: `http://127.0.0.1:3131/history`
- Module CPU: `http://127.0.0.1:3131/cpu`
- Hub analytics: `http://127.0.0.1:3131/hub`

Snapshots are appended to `monitor-data/snapshots.jsonl` by default.

When hub is enabled, `npm run monitor:once` includes a hub progress summary under `memory.hub`.

- `SCREEPS_MONITOR_SHARD=<shard>` explicitly selects a shard; if omitted, the service falls back automatically.
- Screeps console: `hubProgressRaw()` returns the raw hub progress snapshot; `hubProgress()` returns pretty-printed JSON.

## RoomPlanner Auto Construction

After you save layout to `Memory.data.roomPlanner[roomName]`, construction sites are queued automatically.

- Trigger planner output to Memory: place `SP` flag, or call `savePlanToMemory('W1N1')`
- Auto builder runs every 5 ticks
- Per room limit: up to 8 new sites per run (default)
- Global soft cap: stops when global construction sites reach 95

Optional runtime config in console:

```js
Memory.cfg = Memory.cfg || {}
Memory.cfg.roomPlannerBuild = {
  enabled: true,
  maxNewSitesPerRoom: 6
}
```

- Set `enabled: false` to pause auto site creation
- Priority order is spawn/extension/tower first, roads/ramparts later

## Energy Pickup Tuning

Carrier/worker energy pickup prefers targets with at least `min(creepCapacity, preferredMin)` energy.

```js
Memory.cfg = Memory.cfg || {}
Memory.cfg.energyPickup = {
  preferredMin: 800
}
```

If no target reaches the threshold, they will fallback to the nearest available energy source.

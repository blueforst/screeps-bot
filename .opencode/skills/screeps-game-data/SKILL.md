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

This uses `.secret.json` or `SCREEPS_TOKEN`, auto-selects the active shard, fetches `Memory.analytics`, prints a JSON snapshot, and appends it to `monitor-data/snapshots.jsonl`. Auto-selection considers hub analytics, `Memory.runtime.lastDeployTag` timestamp, then analytics tick; this avoids choosing old shards whose stale analytics tick is numerically higher than the active shard.

Confirm these fields before reasoning from the snapshot:

| Field | Why it matters |
| --- | --- |
| `memory.summary.latestTick` | Data is fresh enough for the issue being diagnosed |
| `memory.selectedShard` | You are looking at the active shard, not an empty one |
| `memory.shardCandidates[].lastDeployTag` | Confirms which shard received the current deploy |
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

First verify which shard is actually executing console commands when you plan to run console expressions or when monitor candidates disagree. `monitor:once` now prefers the newest deploy tag, but console probing remains the authoritative check for console commands:

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

## Screeps API Rate Limits

Official Screeps docs say regular browser and Steam client requests are not rate limited, but all requests authenticated by auth tokens are rate limited. When the limit is exceeded, Screeps returns HTTP `429 Too Many Requests` with a body like `Rate limit exceeded, retry after 51243ms`.

Relevant official auth-token limits for this project:

| Endpoint | Limit |
| --- | --- |
| Global token limit | 120 / minute |
| `GET /api/user/memory` | 1440 / day |
| `POST /api/user/memory` | 240 / day |
| `GET /api/user/memory-segment` | 360 / hour |
| `POST /api/user/memory-segment` | 60 / hour |
| `POST /api/user/console` | 360 / hour |
| `POST /api/user/code` | 240 / day |

Rate-limit responses include these informational headers:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Window reset time as UTC epoch seconds |

If `npm run monitor:once` prints `"memory": null`, the console probe fails with a non-JSON `Rate limit...` response, or any API helper throws on `429`, stop repeated polling. Re-running monitor/probe consumes more token capacity and can extend operational disruption.

To estimate when the current window resets without printing secrets, run a single header-only probe from the repo root:

```bash
node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(".secret.json","utf8")); const t=process.env.SCREEPS_TOKEN||s.main?.token; fetch("https://screeps.com/api/user/name",{headers:{"X-Token":t,"X-Username":t}}).then(async r=>{const reset=r.headers.get("x-ratelimit-reset"); const now=Math.floor(Date.now()/1000); console.log(JSON.stringify({status:r.status,limit:r.headers.get("x-ratelimit-limit"),remaining:r.headers.get("x-ratelimit-remaining"),reset,secondsUntilReset:reset?Math.max(0,Number(reset)-now):null,body:(await r.text()).slice(0,80)},null,2));})'
```

Use `secondsUntilReset` as the answer when the user asks how long until the limit is lifted. If headers are missing but the body says `retry after Nms`, convert that to seconds/minutes. Do not paste the token into `curl`, logs, chat, or command output.

Screeps also supports a human-only no-rate-limit flow for third-party tools: `https://screeps.com/a/#!/account/auth-tokens/noratelimit?token=XXX` grants the token a 2-hour no-limit window after the user completes the page. It uses Google Invisible reCAPTCHA and must not be automated. Token status, including that unlimited-period timer, can be queried via `https://screeps.com/api/auth/query-token?token=XXX`; if you use it, do so from a script that never prints the token.

Manual no-rate-limit authorization workflow used in this repo:

1. If API reads are rate limited and the user asks for a manual unlock link, first provide the format `https://screeps.com/a/#!/account/auth-tokens/noratelimit?token=XXX` and explain that `XXX` is the Screeps auth token.
2. If the user asks to read the token from the environment, check only expected Screeps token variables (for example `SCREEPS_TOKEN`) and do not print the full environment or token. In this project, helpers fall back to `.secret.json` `main.token` when `SCREEPS_TOKEN` is absent.
3. Prefer copying the completed URL to the local clipboard instead of printing it in chat, because the URL contains the secret token:

```bash
node -e 'const fs=require("node:fs"); const secret=JSON.parse(fs.readFileSync(".secret.json","utf8")); const token=process.env.SCREEPS_TOKEN || secret.main?.token; if (!token) throw new Error("Missing SCREEPS_TOKEN and .secret.json main.token"); process.stdout.write(`https://screeps.com/a/#!/account/auth-tokens/noratelimit?token=${encodeURIComponent(token)}`);' | pbcopy
```

4. Tell the user to paste the copied URL into a browser and click `Proceed`. Do not attempt to automate the page; it relies on Google Invisible reCAPTCHA and requires manual user action.
5. After the user confirms the unlock, run exactly one read-only check such as `npm run monitor:once` or the header-only probe above. Avoid repeated retry loops that consume the token capacity again.

## Safety Rules

- Treat `.secret.json` and tokens as secrets; never print, copy, or commit them.
- Prefer read-only monitor/API access. Do not mutate `Memory`, create flags, spawn creeps, or run console write helpers unless the user explicitly approves that action.
- Treat console expressions as production actions. `Game.*` reads and status helpers are safe; `Memory` writes, flag operations, spawn operations, market operations, and telemetry toggles require explicit user approval except for the temporary `--probe` cleanup flow above.
- If a runtime issue persists after a code fix, read live `Memory`/monitor state again before guessing. Compare actual assignments, task board entries, creep memory, room state, and selected shard against the assumed path.
- If console commands enqueue successfully but no state changes, probe multiple shards. A stale high tick in old `Memory.analytics` can still be misleading if the active shard has no fresh deploy tag or analytics.
- If monitor data is stale or missing, report the exact missing field and check shard/telemetry configuration before changing code.
- If the issue depends on a specific creep/room/resource, capture the concrete IDs and tick from live data and mention them in the diagnosis.

## Common Mistakes

| Mistake | Correct behavior |
| --- | --- |
| Guessing from source code only | Run `npm run monitor:once` first for live state |
| Debugging the wrong shard | Verify `memory.selectedShard` and `latestTick` |
| Trusting shard choice when candidates disagree | Check `lastDeployTag`; run `console-api.mjs --probe` before console work |
| Assuming telemetry exists | Check `moduleCpu.available`, `hub.available`, or segment presence |
| Using console writes for convenience | Stay read-only unless the user authorizes mutation |
| Sharing command output with secrets | Summarize state; never expose token-bearing config |

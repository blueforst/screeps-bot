# E8N58 Remote Path Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow E8N58 road planning and carrier return routing to search beyond Screeps' default pathfinding operation budget.

**Architecture:** Keep existing route selection, exit recovery, and construction throttling unchanged. Supply an explicit 10,000-operation budget at the two multi-room `PathFinder.search` call sites: remote road planning and carrier travel routing.

**Tech Stack:** TypeScript, Screeps API, Jest, Rollup.

## Global Constraints

- Do not change E8N58 task memory, source-container locations, construction throttles, or room routing policy.
- Keep the existing `maxRooms`, terrain-cost, and safety callback behavior intact.
- Verify locally before `npm run push`, then verify the live shard separately.

---

### Task 1: Raise the remote road-planning budget

**Files:**
- Modify: `src/runtime/remoteMining.test.ts`
- Modify: `src/runtime/remoteMining.ts`

**Interfaces:**
- Consumes: `PathFinder.search(origin, goal, options)`.
- Produces: a populated `RemoteMiningTask.roadPlan` when a route needs more than the default operation budget.

- [ ] **Step 1: Write the failing test**

Add this assertion to a successful `processRemoteConstruction` test after the call:

```ts
const searchOptions = (PathFinder.search as jest.Mock).mock.calls[0][2];
expect(searchOptions).toEqual(expect.objectContaining({ maxOps: 10000, maxRooms: 2 }));
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test -- src/runtime/remoteMining.test.ts --runInBand`

Expected: the new assertion fails because `maxOps` is absent.

- [ ] **Step 3: Write the minimal implementation**

Add a named `REMOTE_ROAD_PATH_MAX_OPS = 10000` constant next to `GLOBAL_SITE_SOFT_CAP`, and pass it through the existing search options:

```ts
{ maxRooms: 2, maxOps: REMOTE_ROAD_PATH_MAX_OPS, plainCost: 2, swampCost: 10, roomCallback }
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm run test -- src/runtime/remoteMining.test.ts --runInBand`

Expected: exit code 0.

### Task 2: Raise the multi-room carrier travel budget

**Files:**
- Modify: `src/movement/routing.test.ts`
- Modify: `src/movement/routing.ts`

**Interfaces:**
- Consumes: `moveToTargetRoom(creep, targetRoom, routeRooms, options)`.
- Produces: a complete multi-room `PathFinder.search` request for the E8N58-to-E7N58 return path.

- [ ] **Step 1: Write the failing test**

Extend the existing successful multi-room path assertion:

```ts
expect(PathFinder.search).toHaveBeenCalledWith(
  creep.pos,
  { pos: new MockRoomPosition(25, 25, "W1N3"), range: 1 },
  expect.objectContaining({ maxOps: 10000, maxRooms: 16, plainCost: 2, swampCost: 10 }),
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm run test -- src/movement/routing.test.ts --runInBand`

Expected: the new assertion fails because `maxOps` is absent.

- [ ] **Step 3: Write the minimal implementation**

Add `const MULTI_ROOM_TRAVEL_MAX_OPS = 10000;` beside the routing cache constants, then pass `maxOps: MULTI_ROOM_TRAVEL_MAX_OPS` to the `PathFinder.search` options in `moveAlongMultiRoomPath`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm run test -- src/movement/routing.test.ts --runInBand`

Expected: exit code 0.

### Task 3: Verify and release

**Files:**
- Verify: `src/runtime/remoteMining.test.ts`, `src/movement/routing.test.ts`

- [ ] **Step 1: Run static and full regression checks**

Run:

```bash
npx tsc --noEmit
npm run build
npm run test -- --runInBand
```

Expected: every command exits 0.

- [ ] **Step 2: Commit the scoped change**

Run:

```bash
git add src/runtime/remoteMining.ts src/runtime/remoteMining.test.ts src/movement/routing.ts src/movement/routing.test.ts docs/superpowers/plans/2026-07-14-e8n58-remote-path-budget.md
git commit -m "fix(remote-mining): raise multi-room path budget"
```

- [ ] **Step 3: Deploy and verify live state**

Run `npm run push`, then read `data.remoteMining.E8N58` and room objects on shard1. Confirm the deployed tag is current and E8N58 receives a road plan or road construction sites.

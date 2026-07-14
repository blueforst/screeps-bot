# E8N58 Remote Path Budget Design

## Goal

Make E8N58 external mining generate its missing road plan and make carriers reliably search the full E8N58-to-E7N58 return route.

## Evidence

- The live task is active with `sourceRoom: E7N58`, `targetRoom: E8N58`, two source containers at `(31,30)` and `(31,34)`, and no road plan.
- E8N58 has two built containers but no roads or construction sites.
- An obstacle-aware read-only search found a walkable 90-step route from E7N58 storage to the E8N58 sources through `(49,17) -> (0,17)`.
- Both `generateRoadPlan` and the multi-room branch of `moveToTargetRoom` call `PathFinder.search` without `maxOps`; Screeps therefore applies its 2,000-operation default.

## Design

Use a named 10,000-operation budget only for the two relevant multi-room searches:

1. `generateRoadPlan` in `src/runtime/remoteMining.ts` receives `maxOps: 10000`, preserving its existing two-room limit and terrain costs.
2. `moveAlongMultiRoomPath` in `src/movement/routing.ts` receives `maxOps: 10000`, preserving route safety, exit recovery, and existing fallback-to-exit behavior.

No task state migration, fixed route, construction-site mutation, or container replanning is needed. After deployment, the existing construction loop will create road sites incrementally under its current per-run cap.

## Verification

- Add one regression test per call site to assert the raised `PathFinder.search` budget is supplied.
- Run both focused Jest suites, TypeScript checking, the production build, and the full test suite.
- Deploy only after local verification, then re-read the active shard's task and room objects to confirm a road plan and/or E8N58 road sites appear.

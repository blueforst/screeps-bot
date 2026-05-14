
## Task 1: Depleted-mineral pre-spawn guard (2026-05-12)

- `shouldQueueConfig()` uses a shared branch for harvester/miner/mineralHarvester/colonizerHarvester → splitting mineralHarvester out was the right call to avoid affecting other roles.
- `getMineralIdFromConfig()` returns `undefined` when config has no mineral ID in `args[0]`.
- `Game.getObjectById<Mineral>()` returns `null` when the object doesn't exist (e.g. room not visible).
- The missing-mineral test already passed without code changes because `getSourceWorkerWorkPos` returns null → threshold 0 → TTL not ≤ 0 → no queue. But the guard is still needed for clarity and explicit protection.
- Pre-existing test failures in `resourceControl.test.ts` (terminal energy jitter) are unrelated.

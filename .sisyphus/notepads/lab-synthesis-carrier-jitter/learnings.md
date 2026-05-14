# Learnings

## 2026-05-13T09:00 - Session Start
- Metis review confirmed two mandatory sub-problems: scheduler jitter AND orphaned carrier delivery
- Generic carrier target delivery only handles energy; mineral-cargo carrier with cleared board task is permanently stuck
- In-flight cargo counts toward target lab effective current, NOT source availability
- Source depletion is real (carrier withdrew), but the carried amount is committed to the lab
- Dead creeps must not contribute to in-flight count; only iterate Object.values(Game.creeps)

## 2026-05-13 - In-flight cargo edge-case tests
- `countInFlightSynthesisCargo` iterates `Object.values(Game.creeps)` — dead creeps are auto-excluded
- Dead-creep assignment state in `__creepAssignmentState` does NOT affect in-flight counting since the function only checks `Game.creeps`
- Lab store mock: `_resourceMap` and `store` share the same JS object via closure — must mutate `_resourceMap` in-place (not reassign) for store to see changes
- `MAX_BATCH_SIZE = 3000` clamps `desiredLabAmount` — test values must account for this (not assume LAB_MINERAL_CAPACITY=5000)
- Partial top-up: `isPartialTopUp` allows deficit < LAB_REACTION_AMOUNT when `effectiveCurrentAmount > 0` — verified with in-flight cargo contributing to effectiveCurrentAmount

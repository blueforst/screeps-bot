# Decisions

## [2026-05-08] Architecture: Single HUB flag
- Use exactly one `HUB` flag; reject duplicates with console warning.
- HUB state lives in `Memory.data.hubControl` following `flagHauling` pattern.
- Use existing `resourceTransferTasks` for inter-room movement (terminal sends).
- Use existing `carrierTaskBoard` with producer `"hubControl"` for in-room terminal→storage offload.
- Use existing `synthesisControl` by writing ordered reaction configs.
- Reaction chains are hardcoded for 6 military T3 compounds + XLH2O.
- Highest-reachable intermediate fallback when source minerals incomplete.
- Intermediate fallback cap: 1000 per compound at HUB.
- Strategic reserve: 1000 per T3 per owned room, counted only in storage (not terminal).

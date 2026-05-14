# Learnings

## [2026-05-12] Task: plan-generation
- Offset bug root cause: `drawProgressBar()` return value discarded at hubProgress.ts:245; `y += HUB_VISUAL_ROW` used instead of actual bar stride (0.6 vs 0.7 = 0.1 drift).
- Screeps `text()` y is baseline; `rect()` y is top-left. Need explicit baseline compensation.
- `RoomVisualMock` in `test/setup.ts` records to `global.__roomVisualCalls`; sufficient for coordinate assertions.
- Hub palette constants: VIS_TEXT="#c9c9c9", VIS_HEADER_FILL="#1a1a2e", VIS_PANEL_STROKE="#c9c9c9", VIS_MUTED="#888888".
- No VIS_PANEL_FILL exists yet; palette.ts will define it.
- Autoplanner visual code is JS prototype extensions; excluded from first version.

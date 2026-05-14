# Hub Progress Overlay - Learnings

## Session: ses_1e55eb2fcffe8nzzdjh6YD4IZZ
- Date: 2026-05-12
- Plan: .sisyphus/plans/hub-progress-overlay.md
- User request: implement, review, push to game

## Conventions
- TDD: tests first, implementation second
- Console commands follow Raw+Command pattern (statusHubRaw/statusHubCommand style)
- Analytics writes follow productionMonitor.ts pattern (sample interval, Memory.analytics sub-key)
- RoomVisual guard: typeof RoomVisual === "undefined"
- Overlay uses pure draw-command generation, RoomVisual adapter is thin and untested directly
- Monitor: Memory.analytics path, not RawMemory segments

## Key References
- resourceControl.ts:667-695 createTerminalFeedTask caps by storage/terminal capacity
- resourceControl.ts:732-843 staged energy, fee budget, gate
- resourceControl.ts:846-898 syncTerminalFeedTasks
- productionMonitor.ts:83-91 ensurePersistentStore pattern
- productionMonitor.ts:293-308 runProductionMonitor sample interval pattern
- consoleCommands.ts:80-99 Raw+Command pattern
- consoleCommands.ts:117-124 registerConsoleCommands
- global.d.ts:666-709 Memory.analytics type
- main.ts:56-88 game loop phases
- test/setup.ts:3-23 RoomVisualMock no-op stub

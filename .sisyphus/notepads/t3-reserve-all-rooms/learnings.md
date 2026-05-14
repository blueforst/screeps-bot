## Learnings (Wave 1 Task 1: TDD tests)

### Test Infrastructure
- hubPlanner.test.ts uses `registerRuntimeServices()` in beforeEach for distribution/import tests
- `createSatelliteRoom(name, storageResources, terminalResources?)` helper at line 508
- `createHubRoomForDistribution(t3Resources)` helper at line 1246
- resourceControl.test.ts uses `createRoom()` with `createRoom({name, storageResources, terminalResources, nativeMineralType})` pattern
- Both files use `clearCarrierTaskBoardForTest()` and `resetRuntimeServices()` in beforeEach for market tests

### RED Test Results (8 failures as expected)
- Tests A,B (all-10 targets, hubReservePerCompound): fail because defaults only have 5 compounds
- Tests D (normalizeHubConfig x3): fail because function doesn't exist
- Test E (chain resolvability): fails for XKH2O, XKHO2, XLH2O, XZH2O, XZHO2 — REACTION_MAP missing their T2 intermediates
- Tests C (reserve floor x2): fail because planHubDistribution has no hub reserve floor
- Test F (market protection): PASSES — isHubProtectedResource uses targetCompounds.includes() which works with any list length

### Key Insight
- The resourceControl market protection test passes already because the mechanism is list-based, not hardcoded to 5 compounds
- The real policy gaps are: (1) DEFAULT_TARGET_COMPOUNDS only has 5, (2) REACTION_MAP missing 5 new T3 chains, (3) no hubReservePerCompound field, (4) no reserve floor in planHubDistribution, (5) no normalizeHubConfig for migration

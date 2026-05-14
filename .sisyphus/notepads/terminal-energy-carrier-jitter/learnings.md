
## Task 1: Terminal Energy Deadband and Reserve Protection

### Key Finding: Tick Context Caching
The `TickContextService` caches `myRooms` per `Game.time`. When writing multi-step tests that simulate sequential ticks, you MUST advance `Game.time` AND call `resetRuntimeServices()` between runs. Otherwise the cached room mocks from the first run are reused.

### Implementation
- `createEnergyTerminalTask()` now uses `protectedTerminalEnergy = terminalEnergyReserve + reservedTerminalEnergy` instead of just `reservedTerminalEnergy`
- Offload requires BOTH: `storageDeficit > transferBatchSize` AND `trueOffloadableTerminalEnergy >= transferBatchSize`
- One existing test fixture updated: room W7N2 terminal energy 12000→35000 to have true surplus above protected amount

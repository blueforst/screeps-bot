## Learnings

### Test patterns in carrier.test.ts
- `createCreep()` returns a creep with empty store (getUsedCapacity returns 0 for all). Override via `(creep.store as unknown as { getUsedCapacity: jest.Mock }).getUsedCapacity = jest.fn(...)`
- `createRoom()` creates room with terminal and storage by default, each with 10k free capacity. Override storage by passing `{ storage: customStorage }` or just use `room.storage as StructureStorage`
- `CarrierTaskDraft` type does NOT include `createdAt`/`updatedAt` fields - omit them when calling `replaceCarrierTasksForProducerRoom()`
- For target-only tests, manually set `ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId` instead of going through `source()` phase
- The `getUsedCapacity` type in Screeps TS definitions uses overloaded conditional return types that don't directly accept `jest.fn()` - must cast through `unknown`

### Bug confirmed
- `deliverSynthesisCarrierResource()` at line 571: when storage is full (`getFreeCapacity(resource) === 0`), `target` becomes null → function returns false
- `target()` at line 676-720: falls through to `getEnergyStoreTarget()` when creep has energy and no synthesis task delivers
- This causes carriers with terminal_offload tasks to deliver energy to spawn/extension/tower instead of waiting for storage capacity

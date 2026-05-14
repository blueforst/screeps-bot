# Terminal Reserve & Terminal→Storage Logistics Investigation

## 1. Terminal Energy Reserve Configuration

### Default Value
- **`terminalEnergyReserve: 50_000`** (50k)
- File: `src/runtime/resourceControl.ts` line 105
- Defined in `DEFAULT_ROOM_CONFIG`

### Per-Room Override
- Config type: `src/global.d.ts` line 315 (`terminalEnergyReserve?: number`)
- Runtime path: `Memory.cfg.resourceControl.rooms[roomName].terminalEnergyReserve`
- Normalized at `src/runtime/resourceControl.ts` lines 217-222, clamped to [0, 300_000]

### How Reserve Is Used
1. **Send fee budget** (line 385): `getEnergyAvailableForFees = max(0, terminalEnergy - terminalEnergyReserve)`
   - Only energy ABOVE reserve is available for market transfer fees
2. **Inter-room energy transfer** (line 435): `terminalFreeForSend = max(0, from.terminalEnergy - from.terminalEnergyReserve)`
   - Same logic: only surplus above reserve can be sent
3. **Terminal feed task** (line 849): `desiredTerminalEnergy = terminalEnergyReserve + stagedEnergy + feeBudget`
   - Carrier will move energy from storage→terminal to fill up to reserve + pending send needs
4. **Terminal offload decision** (line 834): `protectedTerminalEnergy = terminalEnergyReserve + reservedTerminalEnergy`
   - Energy below reserve is protected from being moved out of terminal

### Current Default is 50k, NOT 120k
- The inherited wisdom mentioned 120k — that's actually the `energyFloor` (line 102), not terminal reserve
- `energyFloor: 120_000` = minimum storage energy before room is considered "in deficit"
- `terminalEnergyReserve: 50_000` = terminal energy kept as fee buffer for sends

## 2. Terminal→Storage Transfer Logic (Offload)

### Carrier Task Types
- File: `src/runtime/carrierTaskBoard.ts` line 1
- Types: `"terminal_feed"` (storage→terminal) and `"terminal_offload"` (terminal→storage)

### When Terminal→Storage Offload Happens
File: `src/runtime/resourceControl.ts` function `createEnergyTerminalTask` (line 827)

**Energy offload** (lines 837-845):
- Condition: `storageDeficit > transferBatchSize AND trueOffloadableTerminalEnergy >= transferBatchSize`
- `storageDeficit = energyTarget - storageEnergy` (wants storage to reach 200k)
- `trueOffloadableTerminalEnergy = terminalEnergy - terminalEnergyReserve - reservedForPendingSends`
- Only offloads `min(batchSize, storageDeficit)` per tick cycle

**Non-energy overflow offload** (lines 898-921):
- Condition: terminal total used > `TERMINAL_TOTAL_STORAGE_CAP` (250k)
- Moves non-energy resources above cap to storage
- Protects resources that have pending outbound sends

### When Storage→Terminal Feed Happens
File: `src/runtime/resourceControl.ts` function `createTerminalFeedTask` (line 668)

- Moves energy from storage to terminal when terminal is below `desiredTerminalEnergy`
- `desiredTerminalEnergy = terminalEnergyReserve + stagedEnergy + feeBudget`
- Priority: 80 (feed) vs 90 (offload) — feed is higher priority

### Carrier Task IDs
- Feed: `resourceControl:terminal_feed:{roomName}:{resource}`
- Offload: `resourceControl:terminal_offload:{roomName}:{resource}`

## 3. Key Constants Summary

| Constant | Value | Location |
|----------|-------|----------|
| `terminalEnergyReserve` | 50,000 (default) | resourceControl.ts:105 |
| `energyFloor` | 120,000 | resourceControl.ts:102 |
| `energyTarget` | 200,000 | resourceControl.ts:103 |
| `energyExportStart` | 250,000 | resourceControl.ts:104 |
| `TERMINAL_TOTAL_STORAGE_CAP` | 250,000 | resourceControl.ts:99 |
| `transferBatchSize` | 10,000 | resourceControl.ts:106 |
| `FEED priority` | 80 | resourceControl.ts:97 |
| `OFFLOAD priority` | 90 | resourceControl.ts:98 |

## 4. Answer to User's Question

The hub terminal reserve is **50k** by default (not 120k — 120k is `energyFloor` for storage).
Per-room override is available via `Memory.cfg.resourceControl.rooms[roomName].terminalEnergyReserve`.

Terminal→storage offload only triggers when:
- Storage is below `energyTarget` (200k) AND terminal has energy above reserve + pending sends
- OR terminal total exceeds 250k cap for non-energy resources

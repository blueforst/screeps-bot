import { POWER_BANK_STATUS, isPowerBankPatrolRoom } from "@/runtime/powerBankConstants";

export function ensureDiscoveryStore(): Record<string, PowerBankHarvestTask> {
  if (!Memory.data) {
    (Memory as any).data = {};
  }
  if (!Memory.data.powerBankHarvest) {
    Memory.data.powerBankHarvest = {};
  }
  return Memory.data.powerBankHarvest;
}

export function countFreeAdjacentTiles(pos: RoomPosition): number {
  const terrain = Game.map.getRoomTerrain(pos.roomName);
  let count = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const tx = pos.x + dx;
      const ty = pos.y + dy;
      if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;
      const t = terrain.get(tx, ty);
      // 0 = plains, 1 = wall, 2 = swamp
      if (t !== 1) {
        count++;
      }
    }
  }

  return count;
}

export function recordPowerBankDiscovery(bank: StructurePowerBank): void {
  if (!isPowerBankPatrolRoom(bank.pos.roomName)) {
    return;
  }

  const store = ensureDiscoveryStore();
  const existing = store[bank.id];

  if (existing) {
    existing.lastSeenTick = Game.time;
    existing.hits = bank.hits;
    existing.power = bank.power;
    existing.ticksToDecay = bank.ticksToDecay;
    return;
  }

  store[bank.id] = {
    id: bank.id,
    status: POWER_BANK_STATUS.DISCOVERED,
    sourceRoom: "",
    targetRoom: bank.pos.roomName,
    bankId: bank.id,
    bankPos: { x: bank.pos.x, y: bank.pos.y },
    hits: bank.hits,
    power: bank.power,
    ticksToDecay: bank.ticksToDecay,
    freeTiles: countFreeAdjacentTiles(bank.pos),
    discoveredTick: Game.time,
    lastSeenTick: Game.time,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
  };
}

const STALE_DISCOVERY_THRESHOLD = 500;

export function cleanupStaleDiscoveries(): void {
  const store = ensureDiscoveryStore();
  const now = Game.time;

  for (const id of Object.keys(store)) {
    const task = store[id];
    if (
      task.status === POWER_BANK_STATUS.DISCOVERED &&
      now - task.lastSeenTick > STALE_DISCOVERY_THRESHOLD
    ) {
      delete store[id];
    }
  }
}

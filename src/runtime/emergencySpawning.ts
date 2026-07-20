import { isSpawnActive } from "@/runtime/tickContext";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

export interface SpawnMaxCarrierResult {
  ok: true;
  roomName: string;
  spawnName: string;
  configName: string;
  energyAvailable: number;
  bodyParts: number;
  pairCount: number;
  queueTop: string[];
}

function ensureConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function buildCarrierBodyByEnergy(energyAvailable: number): BodyPartConstant[] {
  const pairCount = Math.max(1, Math.min(16, Math.floor(energyAvailable / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE]))));
  const body: BodyPartConstant[] = [];

  for (let i = 0; i < pairCount; i++) {
    body.push(CARRY, MOVE);
  }

  return body;
}

function resolveSpawnByRoom(roomName: string): StructureSpawn | null {
  const spawns = getTickContextService().getSpawnsByRoom(roomName);
  if (spawns.length === 0) {
    return null;
  }

  const activeSpawns = spawns.filter(isSpawnActive);
  const candidates = activeSpawns.length > 0 ? activeSpawns : spawns;
  return [...candidates].sort((left, right) => {
    const leftBusy = left.spawning ? 1 : 0;
    const rightBusy = right.spawning ? 1 : 0;
    if (leftBusy !== rightBusy) {
      return leftBusy - rightBusy;
    }

    const leftLoad = (left.memory.spawnList?.length ?? 0) + leftBusy;
    const rightLoad = (right.memory.spawnList?.length ?? 0) + rightBusy;
    if (leftLoad !== rightLoad) {
      return leftLoad - rightLoad;
    }

    return left.name.localeCompare(right.name);
  })[0];
}

function enqueueAtFront(spawn: StructureSpawn, configName: string): void {
  const queue = spawn.memory.spawnList || [];
  spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
}

export function spawnMaxCarrier(roomName: string): SpawnMaxCarrierResult | string {
  const spawn = resolveSpawnByRoom(roomName);
  if (!spawn) {
    return `ERR_NO_SPAWN:${roomName}`;
  }

  const energyAvailable = spawn.room.energyAvailable;
  if (energyAvailable < BODYPART_COST[CARRY] + BODYPART_COST[MOVE]) {
    return `ERR_NOT_ENOUGH_ENERGY:${energyAvailable}`;
  }

  const body = buildCarrierBodyByEnergy(energyAvailable);
  const pairCount = body.length / 2;
  const configName = `${roomName}:manual:maxcarrier:${Game.time}`;

  ensureConfigStore()[configName] = {
    role: "carrier",
    args: [],
    roomName,
    body,
  };

  enqueueAtFront(spawn, configName);

  return {
    ok: true,
    roomName,
    spawnName: spawn.name,
    configName,
    energyAvailable,
    bodyParts: body.length,
    pairCount,
    queueTop: (spawn.memory.spawnList || []).slice(0, 5),
  };
}

export function spawnMaxCarrierRaw(roomName: string): SpawnMaxCarrierResult | string {
  return spawnMaxCarrier(roomName);
}

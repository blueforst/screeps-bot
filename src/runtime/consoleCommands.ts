import type { CreepConfig } from "@/types/system";

interface SpawnMaxCarrierResult {
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
  Memory.data = Memory.data || {};
  if (!Memory.data.creepConfigs) {
    Memory.data.creepConfigs = {};
  }

  return Memory.data.creepConfigs;
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
  const spawn = Object.values(Game.spawns).find((item) => item.room.name === roomName);
  return spawn || null;
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

  const store = ensureConfigStore();
  store[configName] = {
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

export function registerConsoleCommands(): void {
  global.spawnMaxCarrier = spawnMaxCarrier;
}

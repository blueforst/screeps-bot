import { getSafeZone } from "@/runtime/safeZone";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";

const DANGEROUS_BODY_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, WORK];

let defenseModeCacheTick = -1;
const defenseModeCache = new Map<string, boolean>();

export function getPlayerHostiles(room: Room): Creep[] {
  const tickContext = getTickContextService();
  const hostiles = tickContext.getRoomContext?.(room)?.getHostileCreeps() || room.find(FIND_HOSTILE_CREEPS);
  return hostiles.filter(
    (creep) =>
      creep.owner.username !== "Source Keeper" &&
      (creep.owner.username !== "Invader" || creep.getActiveBodyparts(WORK) > 0) &&
      DANGEROUS_BODY_PARTS.some((part) => creep.getActiveBodyparts(part) > 0),
  );
}

function computeDefenseState(room: Room): boolean {
  const safeZone = getSafeZone(room.name);
  if (safeZone.size === 0) return false;

  const hostiles = getPlayerHostiles(room);
  return hostiles.length > 0;
}

export function runDefenseMode(): void {
  if (defenseModeCacheTick !== Game.time) {
    defenseModeCache.clear();
    defenseModeCacheTick = Game.time;
  }

  const tickContext = getTickContextService();
  for (const room of tickContext.getMyRooms()) {
    if (!defenseModeCache.has(room.name)) {
      defenseModeCache.set(room.name, computeDefenseState(room));
    }
  }
}

export function isDefenseMode(roomName: string): boolean {
  return defenseModeCache.get(roomName) ?? false;
}

export function isOffensiveWarCreep(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) return false;

  const config = getCreepConfigService().get(configName);
  if (!config) return false;

  return config.role === "meleeAttacker" || config.role === "healer";
}

export function clearDefenseModeCacheForTest(): void {
  defenseModeCache.clear();
  defenseModeCacheTick = -1;
}

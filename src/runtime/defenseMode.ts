import { getSafeZone, getSafeZonePlanRevision } from "@/runtime/safeZone";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";

const DANGEROUS_BODY_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, WORK, HEAL];

interface DefenseModeSnapshot {
  game: Game;
  tick: number;
  planRevisions: ReadonlyMap<string, number | null>;
  states: ReadonlyMap<string, boolean>;
}

let defenseModeSnapshot: DefenseModeSnapshot | undefined;

export function getPlayerHostiles(room: Room): Creep[] {
  const tickContext = getTickContextService();
  const hostiles = tickContext.getRoomContext?.(room)?.getHostileCreeps() || room.find(FIND_HOSTILE_CREEPS);
  return hostiles.filter(
    (creep) =>
      creep.owner.username !== "Source Keeper" &&
      (creep.owner.username !== "Invader" || creep.getActiveBodyparts(WORK) > 0 || creep.getActiveBodyparts(HEAL) > 0) &&
      DANGEROUS_BODY_PARTS.some((part) => creep.getActiveBodyparts(part) > 0),
  );
}

function computeDefenseState(room: Room): boolean {
  const safeZone = getSafeZone(room.name);
  if (safeZone.size === 0) return false;

  const hostiles = getPlayerHostiles(room);
  return hostiles.length > 0;
}

function haveSafeZonePlanRevisionsChanged(snapshot: DefenseModeSnapshot): boolean {
  for (const [roomName, revision] of snapshot.planRevisions) {
    if (getSafeZonePlanRevision(roomName) !== revision) return true;
  }
  return false;
}

function ensureCurrentDefenseSnapshot(checkPlanRevisions = false): DefenseModeSnapshot {
  try {
    const currentGame = Game;
    const currentTick = currentGame.time;
    if (defenseModeSnapshot?.game === currentGame && defenseModeSnapshot.tick === currentTick) {
      if (!checkPlanRevisions || !haveSafeZonePlanRevisionsChanged(defenseModeSnapshot)) {
        return defenseModeSnapshot;
      }
    }

    const planRevisions = new Map<string, number | null>();
    const states = new Map<string, boolean>();
    const tickContext = getTickContextService();
    for (const room of tickContext.getMyRooms()) {
      planRevisions.set(room.name, getSafeZonePlanRevision(room.name));
      states.set(room.name, computeDefenseState(room));
    }

    const nextSnapshot: DefenseModeSnapshot = {
      game: currentGame,
      tick: currentTick,
      planRevisions,
      states,
    };
    defenseModeSnapshot = nextSnapshot;
    return nextSnapshot;
  } catch (error) {
    defenseModeSnapshot = undefined;
    throw error;
  }
}

export function runDefenseMode(): void {
  ensureCurrentDefenseSnapshot(true);
}

export function isDefenseMode(roomName: string): boolean {
  return ensureCurrentDefenseSnapshot().states.get(roomName) ?? false;
}

export function isOffensiveWarCreep(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) return false;

  const config = getCreepConfigService().get(configName);
  if (!config) return false;

  return config.role === "meleeAttacker" || config.role === "healer";
}

export function clearDefenseModeCacheForTest(): void {
  defenseModeSnapshot = undefined;
}

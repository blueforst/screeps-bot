import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { getPositionAtDirection, isExitTile } from "@/movement/common";
import type { RoleFactory } from "@/types/system";
import type { RemoteDefenseReason } from "@/runtime/remoteMining";

const SOURCE_KEEPER_USERNAME = "Source Keeper";
const INVADER_USERNAME = "Invader";
const NPC_INVADER_COMBAT_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL, WORK];
const FLEE_DIRECTIONS: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

function getTargetRoomFromConfig(creep: Creep): string | null {
  const parts = creep.memory.configName?.split(":");
  if (!parts || parts.length < 3) return null;
  return parts[2];
}

function getSourceRoomFromConfig(creep: Creep): string | null {
  const parts = creep.memory.configName?.split(":");
  if (!parts || parts.length < 1) return null;
  return parts[0];
}

function getDefenseReason(targetRoom: string): RemoteDefenseReason | null {
  const task = Memory.data?.remoteMining?.[targetRoom];
  if (!task || task.status !== "defending") return null;
  return task.defenseReason ?? null;
}

function isTaskDefending(targetRoom: string): boolean {
  const task = Memory.data?.remoteMining?.[targetRoom];
  return task?.status === "defending";
}

function getUsername(creep: Creep): string {
  return (creep.owner as { username: string } | undefined)?.username ?? "";
}

function hasBodyPart(creep: Creep, partType: BodyPartConstant): boolean {
  if (typeof creep.getActiveBodyparts === "function") {
    return creep.getActiveBodyparts(partType) > 0;
  }
  return creep.body?.some((bp: BodyPartDefinition) => bp.type === partType && bp.hits > 0) ?? false;
}

function isEligibleTarget(hostile: Creep, defenseReason: RemoteDefenseReason | null): boolean {
  const username = getUsername(hostile);
  if (username === SOURCE_KEEPER_USERNAME) return false;
  if (username === INVADER_USERNAME) {
    return hasNpcInvaderCombatParts(hostile);
  }
  return defenseReason === "player_aggression";
}

function hasNpcInvaderCombatParts(creep: Creep): boolean {
  for (const part of NPC_INVADER_COMBAT_PARTS) {
    if (hasBodyPart(creep, part)) return true;
  }
  return false;
}

function targetPriorityScore(hostile: Creep): number {
  const healParts = typeof hostile.getActiveBodyparts === "function"
    ? hostile.getActiveBodyparts(HEAL) : 0;
  const rangedParts = typeof hostile.getActiveBodyparts === "function"
    ? hostile.getActiveBodyparts(RANGED_ATTACK) : 0;
  const attackParts = typeof hostile.getActiveBodyparts === "function"
    ? hostile.getActiveBodyparts(ATTACK) : 0;
  if (healParts > 0) return 3;
  if (rangedParts > 0) return 2;
  if (attackParts > 0) return 1;
  return 0;
}

function pickTarget(creep: Creep, eligible: Creep[]): Creep | null {
  if (eligible.length === 0) return null;
  let best: Creep | null = null;
  let bestScore = -1;
  let bestRange = Infinity;
  for (const hostile of eligible) {
    const score = targetPriorityScore(hostile);
    const range = creep.pos.getRangeTo(hostile.pos);
    if (score > bestScore || (score === bestScore && range < bestRange)) {
      bestScore = score;
      bestRange = range;
      best = hostile;
    }
  }
  return best;
}

function isFriendlyRemoteCreep(creep: Creep, sourceRoom: string, targetRoom: string): boolean {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  return creep.my && !!creep.memory.configName?.startsWith(prefix);
}

function getFleeDirection(creep: Creep, hostile: Creep): DirectionConstant {
  const dir = hostile.pos.getDirectionTo(creep.pos);
  if (dir !== null) return dir;
  const dx = creep.pos.x - hostile.pos.x;
  const dy = creep.pos.y - hostile.pos.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? RIGHT : LEFT;
  }
  return dy >= 0 ? BOTTOM : TOP;
}

function isSafeFleeDirection(creep: Creep, hostile: Creep, direction: DirectionConstant, currentRange: number): boolean {
  const nextPos = getPositionAtDirection(creep.pos, direction);
  if (!nextPos || isExitTile(nextPos)) {
    return false;
  }
  return nextPos.getRangeTo(hostile.pos) > currentRange;
}

function getSafeFleeDirection(creep: Creep, hostile: Creep, currentRange: number): DirectionConstant | null {
  const preferred = getFleeDirection(creep, hostile);
  if (isSafeFleeDirection(creep, hostile, preferred, currentRange)) {
    return preferred;
  }

  let bestDirection: DirectionConstant | null = null;
  let bestRange = currentRange;
  for (const direction of FLEE_DIRECTIONS) {
    if (!isSafeFleeDirection(creep, hostile, direction, currentRange)) {
      continue;
    }
    const nextPos = getPositionAtDirection(creep.pos, direction);
    if (!nextPos) {
      continue;
    }
    const range = nextPos.getRangeTo(hostile.pos);
    if (range > bestRange) {
      bestRange = range;
      bestDirection = direction;
    }
  }

  if (bestDirection !== null) {
    return bestDirection;
  }

  return null;
}

export const remoteDefenderRole: RoleFactory = (...args: string[]) => {
  const targetRoom = args[0];
  return {
    target: (creep: Creep): boolean => {
      const resolvedTargetRoom = targetRoom || getTargetRoomFromConfig(creep);
      if (!resolvedTargetRoom) return false;

      if (creep.room.name !== resolvedTargetRoom) {
        moveToTargetRoom(creep, resolvedTargetRoom, undefined, {
          plainCost: 2,
          swampCost: 10,
          travelRange: 3 as const,
          reusePath: 10,
        });
        return false;
      }

      const sourceRoom = getSourceRoomFromConfig(creep) ?? resolvedTargetRoom;
      const defenseReason = getDefenseReason(resolvedTargetRoom);
      const defending = isTaskDefending(resolvedTargetRoom);

      const hostiles: Creep[] = creep.room.find(FIND_HOSTILE_CREEPS);
      const eligible = hostiles.filter((h) => isEligibleTarget(h, defenseReason));

      if (eligible.length === 0) {
        if (!defending) {
          if (creep.room.name !== sourceRoom) {
            moveToTargetRoom(creep, sourceRoom, undefined, { reusePath: 5 });
          } else {
            moveToTarget(creep, new RoomPosition(25, 25, sourceRoom), 3, { reusePath: 5 });
          }
          if (creep.pos.roomName === sourceRoom) {
            creep.suicide();
          }
        }
        return false;
      }

      const target = pickTarget(creep, eligible);
      if (!target) return false;

      if (creep.hits < creep.hitsMax * 0.5) {
        creep.heal(creep);
        if (creep.room.name !== sourceRoom) {
          moveToTargetRoom(creep, sourceRoom, undefined, { reusePath: 5 });
        } else {
          moveToTarget(creep, new RoomPosition(25, 25, sourceRoom), 3, { reusePath: 5 });
        }
        return false;
      }

      if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
      } else {
        let healed = false;
        const friendlies = Object.values(Game.creeps).filter(
          (c) => c.name !== creep.name && isFriendlyRemoteCreep(c, sourceRoom, resolvedTargetRoom) && c.hits < c.hitsMax,
        );
        const adjacent = friendlies.filter((f) => creep.pos.getRangeTo(f.pos) <= 1);
        if (adjacent.length > 0) {
          const mostDamaged = adjacent.reduce((a, b) =>
            (a.hitsMax - a.hits) > (b.hitsMax - b.hits) ? a : b,
          );
          creep.heal(mostDamaged);
          healed = true;
        }
        if (!healed) {
          const inRangedRange = friendlies.filter((f) => creep.pos.getRangeTo(f.pos) <= 3);
          if (inRangedRange.length > 0) {
            const mostDamaged = inRangedRange.reduce((a, b) =>
              (a.hitsMax - a.hits) > (b.hitsMax - b.hits) ? a : b,
            );
            creep.rangedHeal(mostDamaged);
          }
        }
      }

      const targetRange = creep.pos.getRangeTo(target.pos);

      if (targetRange <= 3) {
        const eligibleInRange3 = eligible.filter((h) => creep.pos.getRangeTo(h.pos) <= 3);
        if (eligibleInRange3.length >= 3) {
          creep.rangedMassAttack();
        } else {
          creep.rangedAttack(target);
        }
      } else {
        moveToTarget(creep, target, 3, { reusePath: 5, avoidExitTiles: true });
      }

      if (hasBodyPart(target, ATTACK) && targetRange < 3) {
        const fleeDir = getSafeFleeDirection(creep, target, targetRange);
        // Tactical directional move — not destination pathfinding
        if (fleeDir !== null) {
          creep.move(fleeDir);
        }
      }

      return false;
    },
  };
};

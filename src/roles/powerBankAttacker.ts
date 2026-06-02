import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8 } as const;

type PowerBankAttackerRuntimeMemory = CreepMemory & { taskId?: string; powerBankReinforcementStage?: PowerBankReinforcementStage };

const BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "preparing_boosts",
  "spawning",
  "renewing",
  "boosting",
]);

const RETIRE_STATUSES: ReadonlySet<string> = new Set([
  "hauling",
  "complete",
]);

const REINFORCEMENT_BLOCKED_STAGES: ReadonlySet<string> = new Set(["spawning", "renewing", "boosting"]);

function isTOUGHLayerBroken(creep: Creep): boolean {
  return creep.body.every((p) => p.type !== TOUGH || p.hits <= 0);
}

function getTaskForCreep(creep: Creep): PowerBankHarvestTask | null {
  const taskId = (creep.memory as PowerBankAttackerRuntimeMemory).taskId;
  if (!taskId) return null;
  return Memory.data?.powerBankHarvest?.[taskId] ?? null;
}

function isReinforcementBlocked(creep: Creep): boolean {
  const stage = (creep.memory as PowerBankAttackerRuntimeMemory).powerBankReinforcementStage;
  return !!stage && REINFORCEMENT_BLOCKED_STAGES.has(stage);
}

function retireIfOrphanedPowerBankCreep(creep: Creep): boolean {
  if (!creep.memory.configName?.includes(":powerbank:")) return false;
  creep.suicide();
  return true;
}

function retireAfterBankDestroyed(creep: Creep, task: PowerBankHarvestTask): void {
  if (task.status === "attacking") {
    task.status = "hauling";
  }
  creep.suicide();
}

function findPairedHealer(creep: Creep): Creep | null {
  const configPaired = findConfigPairedHealer(creep);
  if (configPaired) return configPaired;

  const taskId = (creep.memory as PowerBankAttackerRuntimeMemory).taskId;
  if (!taskId) return null;
  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "powerBankHealer") continue;
    if ((candidate.memory as PowerBankAttackerRuntimeMemory).taskId !== taskId) continue;
    return candidate;
  }
  return null;
}

function findConfigPairedHealer(creep: Creep): Creep | null {
  const configName = creep.memory.configName;
  if (!configName) return null;

  const healerConfigName = configName.replace(":attacker:", ":healer:");
  if (healerConfigName === configName) return null;

  const taskId = (creep.memory as PowerBankAttackerRuntimeMemory).taskId;
  for (const name of Object.keys(Game.creeps)) {
    const candidate = Game.creeps[name];
    if (candidate === creep) continue;
    if (candidate.memory.role !== "powerBankHealer") continue;
    if (candidate.memory.configName !== healerConfigName) continue;
    if (taskId && (candidate.memory as PowerBankAttackerRuntimeMemory).taskId !== taskId) continue;
    return candidate;
  }
  return null;
}

function isExitTile(pos: RoomPosition): boolean {
  return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function moveOffTargetRoomExit(creep: Creep): boolean {
  let horizontal: DirectionConstant | null = null;
  let vertical: DirectionConstant | null = null;

  if (creep.pos.x <= 0) horizontal = RIGHT;
  else if (creep.pos.x >= 49) horizontal = LEFT;

  if (creep.pos.y <= 0) vertical = BOTTOM;
  else if (creep.pos.y >= 49) vertical = TOP;

  let direction: DirectionConstant | null = null;
  if (horizontal && vertical) {
    if (horizontal === RIGHT && vertical === BOTTOM) direction = BOTTOM_RIGHT;
    else if (horizontal === RIGHT && vertical === TOP) direction = TOP_RIGHT;
    else if (horizontal === LEFT && vertical === BOTTOM) direction = BOTTOM_LEFT;
    else direction = TOP_LEFT;
  } else {
    direction = horizontal ?? vertical;
  }

  if (!direction) return false;
  measureCreepIntent(() => creep.move(direction));
  return true;
}

export const powerBankAttackerRole: RoleFactory = (targetRoom?: string, encodedRouteRooms?: string) => ({
  source: (creep): boolean => {
    if (isReinforcementBlocked(creep)) return false;

    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;
    if (task?.status && RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    if (task?.status === "travelling") {
      const healer = findPairedHealer(creep);
      if (!healer) return false;

      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
        return false;
      }

      if (healer.room.name !== creep.room.name) {
        if (creep.room.name === task.targetRoom && isExitTile(creep.pos)) {
          moveOffTargetRoomExit(creep);
        }
        return false;
      }
    }

    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    if (isReinforcementBlocked(creep)) return false;

    const task = getTaskForCreep(creep);
    if (task?.status && BLOCKED_STATUSES.has(task.status)) return false;
    if (task?.status && RETIRE_STATUSES.has(task.status)) {
      creep.suicide();
      return false;
    }

    if (task?.status === "travelling") {
      const healer = findPairedHealer(creep);
      if (!healer) return false;

      if (targetRoom && creep.room.name !== targetRoom) {
        moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
        return false;
      }

      if (healer.room.name !== creep.room.name) {
        if (creep.room.name === task.targetRoom && isExitTile(creep.pos)) {
          moveOffTargetRoomExit(creep);
        }
        return false;
      }
    }

    if (!task) {
      retireIfOrphanedPowerBankCreep(creep);
      return false;
    }

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    const bank = Game.getObjectById(task.bankId as Id<StructurePowerBank>);

    if (!bank) {
      retireAfterBankDestroyed(creep, task);
      return false;
    }

    if (isTOUGHLayerBroken(creep)) {
      return false;
    }

    const code = measureCreepIntent(() => creep.attack(bank));
    if (code === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, bank, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
    }

    return false;
  },
});

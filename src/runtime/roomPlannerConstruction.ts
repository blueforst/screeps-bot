import { isColonizationBootstrapRoom } from "@/runtime/colonization";

const CONSTRUCTION_PRIORITY: BuildableStructureConstant[] = [
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_TOWER,
  STRUCTURE_STORAGE,
  STRUCTURE_LINK,
  STRUCTURE_TERMINAL,
  STRUCTURE_CONTAINER,
  STRUCTURE_EXTRACTOR,
  STRUCTURE_LAB,
  STRUCTURE_FACTORY,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_OBSERVER,
  STRUCTURE_NUKER,
  STRUCTURE_ROAD,
  STRUCTURE_RAMPART,
];

const RUN_INTERVAL = 5;
const DEFAULT_MAX_NEW_SITES_PER_ROOM = 8;
const GLOBAL_SITE_SOFT_CAP = 95;

type PlannedLayout = { [structureType: string]: { x: number; y: number }[] };
type TargetOverrideMap = Partial<Record<BuildableStructureConstant, number>>;

function canBuildAtControllerLevel(structureType: BuildableStructureConstant, level: number): boolean {
  const maxByLevel = CONTROLLER_STRUCTURES[structureType];
  return maxByLevel[level] > 0;
}

function getAllowedCount(structureType: BuildableStructureConstant, level: number): number {
  return CONTROLLER_STRUCTURES[structureType][level] ?? 0;
}

function getPlannedCount(layout: PlannedLayout, structureType: BuildableStructureConstant): number {
  return layout[structureType]?.length ?? 0;
}

function isComplete(room: Room, structureType: BuildableStructureConstant, targetCount: number): boolean {
  if (targetCount <= 0) {
    return true;
  }

  return countExisting(room, structureType) >= targetCount && countSites(room, structureType) === 0;
}

function getBuildPolicy(room: Room, layout: PlannedLayout, controllerLevel: number): {
  allowedTypes: Set<BuildableStructureConstant>;
  targetOverrides: TargetOverrideMap;
} {
  const targetOverrides: TargetOverrideMap = {};
  const colonizationBootstrap = isColonizationBootstrapRoom(room.name);

  if (controllerLevel <= 1) {
    if (colonizationBootstrap) {
      const spawnTarget = Math.min(getPlannedCount(layout, STRUCTURE_SPAWN), getAllowedCount(STRUCTURE_SPAWN, controllerLevel));
      if (spawnTarget > 0) {
        targetOverrides[STRUCTURE_SPAWN] = spawnTarget;
        return { allowedTypes: new Set([STRUCTURE_SPAWN]), targetOverrides };
      }
    }

    return { allowedTypes: new Set(), targetOverrides };
  }

  if (controllerLevel === 2) {
    const extTarget = Math.min(5, getPlannedCount(layout, STRUCTURE_EXTENSION), getAllowedCount(STRUCTURE_EXTENSION, controllerLevel));
    targetOverrides[STRUCTURE_EXTENSION] = extTarget;
    return { allowedTypes: new Set([STRUCTURE_EXTENSION]), targetOverrides };
  }

  const extTarget = Math.min(getPlannedCount(layout, STRUCTURE_EXTENSION), getAllowedCount(STRUCTURE_EXTENSION, 3));
  if (!isComplete(room, STRUCTURE_EXTENSION, extTarget)) {
    targetOverrides[STRUCTURE_EXTENSION] = extTarget;
    return { allowedTypes: new Set([STRUCTURE_EXTENSION]), targetOverrides };
  }

  const towerTarget = Math.min(getPlannedCount(layout, STRUCTURE_TOWER), getAllowedCount(STRUCTURE_TOWER, 3));
  const containerTarget = Math.min(getPlannedCount(layout, STRUCTURE_CONTAINER), getAllowedCount(STRUCTURE_CONTAINER, 3));
  const towerReady = isComplete(room, STRUCTURE_TOWER, towerTarget);
  const containerReady = isComplete(room, STRUCTURE_CONTAINER, containerTarget);

  if (!towerReady || !containerReady) {
    targetOverrides[STRUCTURE_TOWER] = towerTarget;
    targetOverrides[STRUCTURE_CONTAINER] = containerTarget;
    return { allowedTypes: new Set([STRUCTURE_TOWER, STRUCTURE_CONTAINER]), targetOverrides };
  }

  return { allowedTypes: new Set(CONSTRUCTION_PRIORITY), targetOverrides };
}

function countExisting(room: Room, structureType: BuildableStructureConstant): number {
  return room.find(FIND_STRUCTURES, {
    filter: (structure) => structure.structureType === structureType,
  }).length;
}

function countSites(room: Room, structureType: BuildableStructureConstant): number {
  return room.find(FIND_CONSTRUCTION_SITES, {
    filter: (site) => site.structureType === structureType,
  }).length;
}

function hasStructureOrSiteAt(room: Room, x: number, y: number, structureType: BuildableStructureConstant): boolean {
  const position = new RoomPosition(x, y, room.name);

  const structures = position.lookFor(LOOK_STRUCTURES);
  if (structures.some((structure) => structure.structureType === structureType)) {
    return true;
  }

  const sites = position.lookFor(LOOK_CONSTRUCTION_SITES);
  return sites.some((site) => site.structureType === structureType);
}

function tryPlaceSite(room: Room, structureType: BuildableStructureConstant, x: number, y: number): number {
  const result = room.createConstructionSite(x, y, structureType);
  return result;
}

function queueMissingPlannedRamparts(
  room: Room,
  layout: PlannedLayout,
  controllerLevel: number,
  roomRemaining: number,
  globalRemaining: number,
): { roomAdded: number; globalRemaining: number } {
  if (roomRemaining <= 0 || globalRemaining <= 0) {
    return { roomAdded: 0, globalRemaining };
  }

  if (!canBuildAtControllerLevel(STRUCTURE_RAMPART, controllerLevel)) {
    return { roomAdded: 0, globalRemaining };
  }

  const plannedPositions = layout[STRUCTURE_RAMPART] ?? [];
  if (plannedPositions.length === 0) {
    return { roomAdded: 0, globalRemaining };
  }

  const allowed = Math.min(getAllowedCount(STRUCTURE_RAMPART, controllerLevel), plannedPositions.length);
  const existing = countExisting(room, STRUCTURE_RAMPART);
  const queued = countSites(room, STRUCTURE_RAMPART);
  let remaining = Math.max(0, allowed - existing - queued);
  if (remaining <= 0) {
    return { roomAdded: 0, globalRemaining };
  }

  let added = 0;
  for (const pos of plannedPositions) {
    if (added >= roomRemaining || globalRemaining <= 0 || remaining <= 0) {
      break;
    }

    if (hasStructureOrSiteAt(room, pos.x, pos.y, STRUCTURE_RAMPART)) {
      continue;
    }

    const code = tryPlaceSite(room, STRUCTURE_RAMPART, pos.x, pos.y);
    if (code === OK) {
      added += 1;
      globalRemaining -= 1;
      remaining -= 1;
    } else if (code === ERR_FULL) {
      globalRemaining = 0;
      break;
    }
  }

  return { roomAdded: added, globalRemaining };
}

export function runRoomPlannerConstruction(): void {
  if (Memory.cfg?.roomPlannerBuild?.enabled === false) {
    return;
  }

  if (Game.time % RUN_INTERVAL !== 0) {
    return;
  }

  const currentGlobalSiteCount = Object.keys(Game.constructionSites).length;
  if (currentGlobalSiteCount >= GLOBAL_SITE_SOFT_CAP) {
    return;
  }

  const rooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
  const maxNewSitesPerRoom = Memory.cfg?.roomPlannerBuild?.maxNewSitesPerRoom ?? DEFAULT_MAX_NEW_SITES_PER_ROOM;
  let globalRemaining = GLOBAL_SITE_SOFT_CAP - currentGlobalSiteCount;

  for (const room of rooms) {
    if (globalRemaining <= 0) {
      return;
    }

    const roomPlan = Memory.data?.roomPlanner?.[room.name];
    if (!roomPlan) {
      continue;
    }

    const controllerLevel = room.controller?.level ?? 0;
    const layout = roomPlan.layout;
    const { allowedTypes, targetOverrides } = getBuildPolicy(room, layout, controllerLevel);

    if (allowedTypes.size === 0) {
      continue;
    }

    let newSites = 0;

    for (const structureType of CONSTRUCTION_PRIORITY) {
      if (!allowedTypes.has(structureType)) {
        continue;
      }

      const plannedPositions = layout[structureType] ?? [];
      if (plannedPositions.length === 0) {
        continue;
      }

      if (!canBuildAtControllerLevel(structureType, controllerLevel)) {
        continue;
      }

      const policyTarget = targetOverrides[structureType];
      const allowed = policyTarget ?? Math.min(getAllowedCount(structureType, controllerLevel), plannedPositions.length);
      const existing = countExisting(room, structureType);
      const queued = countSites(room, structureType);
      let remaining = Math.max(0, allowed - existing - queued);

      if (remaining <= 0) {
        continue;
      }

      for (const pos of plannedPositions) {
        if (newSites >= maxNewSitesPerRoom || globalRemaining <= 0) {
          break;
        }

        if (remaining <= 0) {
          break;
        }

        if (!hasStructureOrSiteAt(room, pos.x, pos.y, structureType)) {
          const code = tryPlaceSite(room, structureType, pos.x, pos.y);
          if (code === OK) {
            newSites += 1;
            globalRemaining -= 1;
            remaining -= 1;
          } else if (code === ERR_FULL) {
            globalRemaining = 0;
            break;
          }
        }
      }

      if (newSites >= maxNewSitesPerRoom || globalRemaining <= 0) {
        break;
      }
    }

    if (newSites > 0) {
      Memory.runtime = Memory.runtime || {};
      Memory.runtime.roomPlannerAuto = Memory.runtime.roomPlannerAuto || {};
      Memory.runtime.roomPlannerAuto[room.name] = Game.time;
      console.log(`[roomPlanner] ${room.name} queued ${newSites} construction site(s)`);
    }

    const roomRemainingForRamparts = Math.max(0, maxNewSitesPerRoom - newSites);
    const rampartQueued = queueMissingPlannedRamparts(
      room,
      layout,
      controllerLevel,
      roomRemainingForRamparts,
      globalRemaining,
    );
    if (rampartQueued.roomAdded > 0) {
      globalRemaining = rampartQueued.globalRemaining;
      Memory.runtime = Memory.runtime || {};
      Memory.runtime.roomPlannerAuto = Memory.runtime.roomPlannerAuto || {};
      Memory.runtime.roomPlannerAuto[room.name] = Game.time;
      console.log(`[roomPlanner] ${room.name} queued ${rampartQueued.roomAdded} rampart site(s)`);
    }
  }
}

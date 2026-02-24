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

function canBuildAtControllerLevel(structureType: BuildableStructureConstant, level: number): boolean {
  const maxByLevel = CONTROLLER_STRUCTURES[structureType];
  return maxByLevel[level] > 0;
}

function getAllowedCount(structureType: BuildableStructureConstant, level: number): number {
  return CONTROLLER_STRUCTURES[structureType][level] ?? 0;
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

export function runRoomPlannerConstruction(): void {
  if (Memory.roomPlannerBuild?.enabled === false) {
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
  const maxNewSitesPerRoom = Memory.roomPlannerBuild?.maxNewSitesPerRoom ?? DEFAULT_MAX_NEW_SITES_PER_ROOM;
  let globalRemaining = GLOBAL_SITE_SOFT_CAP - currentGlobalSiteCount;

  for (const room of rooms) {
    if (globalRemaining <= 0) {
      return;
    }

    const roomPlan = Memory.roomPlanner?.[room.name];
    if (!roomPlan) {
      continue;
    }

    const controllerLevel = room.controller?.level ?? 0;
    const layout = roomPlan.layout;
    let newSites = 0;

    for (const structureType of CONSTRUCTION_PRIORITY) {
      const plannedPositions = layout[structureType] ?? [];
      if (plannedPositions.length === 0) {
        continue;
      }

      if (!canBuildAtControllerLevel(structureType, controllerLevel)) {
        continue;
      }

      const allowed = getAllowedCount(structureType, controllerLevel);
      const existing = countExisting(room, structureType);
      const queued = countSites(room, structureType);
      let remaining = Math.max(0, allowed - existing - queued);

      if (structureType === STRUCTURE_ROAD || structureType === STRUCTURE_RAMPART) {
        remaining = plannedPositions.length;
      }

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
      Memory.roomPlannerAuto = Memory.roomPlannerAuto || {};
      Memory.roomPlannerAuto[room.name] = Game.time;
      console.log(`[roomPlanner] ${room.name} queued ${newSites} construction site(s)`);
    }
  }
}

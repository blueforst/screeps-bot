import { runPlannerForRoom, savePlannerForRoom } from "@/modules/autoplanner";
import { getTickContextService } from "@/runtime/runtimeServices";
import { hasSourceAdjacentLink } from "@/runtime/sourceLink";

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

const RUN_INTERVAL = 100;
const DEFAULT_MAX_NEW_SITES_PER_ROOM = 2;
const MAX_NEW_SITES_PER_RUN = 2;
const GLOBAL_SITE_SOFT_CAP = 95;
const MINERAL_CONTAINER_MIN_RCL = 6;

type PlannedLayout = { [structureType: string]: { x: number; y: number }[] };
type TargetOverrideMap = Partial<Record<BuildableStructureConstant, number>>;

const LINK_PRIORITY_STORAGE = 0;
const LINK_PRIORITY_SOURCE = 1;
const LINK_PRIORITY_OTHER = 2;
const LINK_PRIORITY_CONTROLLER = 3;

interface PlannedLinkOrder {
  pos: { x: number; y: number };
  priority: number;
  commuteDistance: number;
  referenceDistance: number;
}

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

function getAdjacentSourceAt(room: Room, x: number, y: number): Source | null {
  const position = new RoomPosition(x, y, room.name);
  const sources = position.findInRange(FIND_SOURCES, 1);
  return sources.length > 0 ? sources[0] : null;
}

function isMineralAdjacentPosition(room: Room, x: number, y: number): boolean {
  const position = new RoomPosition(x, y, room.name);
  return position.findInRange(FIND_MINERALS, 1).length > 0;
}

function shouldDelayMineralContainerPlacement(room: Room, x: number, y: number, controllerLevel: number): boolean {
  return controllerLevel < MINERAL_CONTAINER_MIN_RCL && isMineralAdjacentPosition(room, x, y);
}

function getContainerReferencePosition(room: Room): RoomPosition {
  if (room.storage) {
    return room.storage.pos;
  }

  const roomSpawn = getTickContextService().getPrimarySpawnByRoom(room.name);
  if (roomSpawn) {
    return roomSpawn.pos;
  }

  if (room.controller) {
    return room.controller.pos;
  }

  return new RoomPosition(25, 25, room.name);
}

function getExistingSourceContainerPosition(source: Source): { x: number; y: number } | null {
  const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
  }) as StructureContainer[];
  if (containers.length > 0) {
    return { x: containers[0].pos.x, y: containers[0].pos.y };
  }

  const sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: (site) => site.structureType === STRUCTURE_CONTAINER,
  });
  if (sites.length > 0) {
    return { x: sites[0].pos.x, y: sites[0].pos.y };
  }

  return null;
}

function chooseSourceContainerPosition(source: Source, referencePos: RoomPosition): { x: number; y: number } | null {
  const terrain = source.room.getTerrain();
  let bestPos: { x: number; y: number } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let y = source.pos.y - 1; y <= source.pos.y + 1; y++) {
    for (let x = source.pos.x - 1; x <= source.pos.x + 1; x++) {
      if (x === source.pos.x && y === source.pos.y) {
        continue;
      }

      if (x < 1 || x > 48 || y < 1 || y > 48) {
        continue;
      }

      if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
        continue;
      }

      const position = new RoomPosition(x, y, source.room.name);
      const structures = position.lookFor(LOOK_STRUCTURES);
      if (
        structures.some(
          (structure) =>
            structure.structureType !== STRUCTURE_CONTAINER &&
            structure.structureType !== STRUCTURE_ROAD &&
            structure.structureType !== STRUCTURE_RAMPART,
        )
      ) {
        continue;
      }

      const sites = position.lookFor(LOOK_CONSTRUCTION_SITES);
      if (sites.some((site) => site.structureType !== STRUCTURE_CONTAINER)) {
        continue;
      }

      const score = position.getRangeTo(referencePos);
      if (score < bestScore) {
        bestScore = score;
        bestPos = { x, y };
      }
    }
  }

  return bestPos;
}

function getAutoSourceContainerCandidates(room: Room): { x: number; y: number }[] {
  const referencePos = getContainerReferencePosition(room);
  const sources = room.find(FIND_SOURCES);
  const candidates: { x: number; y: number }[] = [];

  for (const source of sources) {
    if (hasSourceAdjacentLink(source)) {
      continue;
    }

    const existingPos = getExistingSourceContainerPosition(source);
    if (existingPos) {
      candidates.push(existingPos);
      continue;
    }

    const chosenPos = chooseSourceContainerPosition(source, referencePos);
    if (chosenPos) {
      candidates.push(chosenPos);
    }
  }

  return candidates;
}

function getContainerPlannedPositions(room: Room, layout: PlannedLayout, controllerLevel: number): { x: number; y: number }[] {
  const merged = [...(layout[STRUCTURE_CONTAINER] ?? []), ...getAutoSourceContainerCandidates(room)];
  const seen = new Set<string>();
  const result: { x: number; y: number }[] = [];

  for (const pos of merged) {
    const key = `${pos.x}:${pos.y}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (shouldSkipSourceContainerPlacement(room, pos.x, pos.y)) {
      continue;
    }

    if (shouldDelayMineralContainerPlacement(room, pos.x, pos.y, controllerLevel)) {
      continue;
    }

    result.push(pos);
  }

  return result;
}

function getCoreRampartPositions(layout: PlannedLayout): { x: number; y: number }[] {
  return [
    ...(layout[STRUCTURE_SPAWN] ?? []),
    ...(layout[STRUCTURE_STORAGE] ?? []),
    ...(layout[STRUCTURE_TERMINAL] ?? []),
  ];
}

function getPlannedRampartPositions(layout: PlannedLayout): { x: number; y: number }[] {
  const merged = [...(layout[STRUCTURE_RAMPART] ?? []), ...getCoreRampartPositions(layout)];
  const seen = new Set<string>();
  const result: { x: number; y: number }[] = [];

  for (const pos of merged) {
    const key = `${pos.x}:${pos.y}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(pos);
  }

  return result;
}

function getPrimaryRoomAnchor(room: Room, layout: PlannedLayout): RoomPosition {
  if (room.storage) {
    return room.storage.pos;
  }

  const plannedStorage = layout[STRUCTURE_STORAGE]?.[0];
  if (plannedStorage) {
    return new RoomPosition(plannedStorage.x, plannedStorage.y, room.name);
  }

  const roomSpawn = getTickContextService().getPrimarySpawnByRoom(room.name);
  if (roomSpawn) {
    return roomSpawn.pos;
  }

  const plannedSpawn = layout[STRUCTURE_SPAWN]?.[0];
  if (plannedSpawn) {
    return new RoomPosition(plannedSpawn.x, plannedSpawn.y, room.name);
  }

  if (room.controller) {
    return room.controller.pos;
  }

  return new RoomPosition(25, 25, room.name);
}

function getPathDistance(from: RoomPosition, to: RoomPosition): number {
  const path = from.findPathTo(to, { ignoreCreeps: true, swampCost: 2, maxOps: 2000 });
  if (path.length > 0) {
    return path.length;
  }

  return from.getRangeTo(to);
}

function getSortedLinkPlannedPositions(room: Room, layout: PlannedLayout): { x: number; y: number }[] {
  const planned = layout[STRUCTURE_LINK] ?? [];
  if (planned.length <= 1) {
    return planned;
  }

  const storageAnchor = room.storage?.pos ?? (layout[STRUCTURE_STORAGE]?.[0]
    ? new RoomPosition(layout[STRUCTURE_STORAGE][0].x, layout[STRUCTURE_STORAGE][0].y, room.name)
    : null);
  const controllerPos = room.controller?.pos || null;
  const anchor = getPrimaryRoomAnchor(room, layout);
  const sources = room.find(FIND_SOURCES);

  const ordered: PlannedLinkOrder[] = planned.map((pos) => {
    const linkPos = new RoomPosition(pos.x, pos.y, room.name);
    const referenceDistance = anchor.getRangeTo(linkPos);

    if (storageAnchor && linkPos.getRangeTo(storageAnchor) <= 2) {
      return {
        pos,
        priority: LINK_PRIORITY_STORAGE,
        commuteDistance: Number.POSITIVE_INFINITY,
        referenceDistance,
      };
    }

    const nearestSource = linkPos.findClosestByRange(sources);
    const sourceRange = nearestSource ? linkPos.getRangeTo(nearestSource.pos) : Number.POSITIVE_INFINITY;
    if (nearestSource && sourceRange <= 2) {
      return {
        pos,
        priority: LINK_PRIORITY_SOURCE,
        commuteDistance: getPathDistance(anchor, nearestSource.pos),
        referenceDistance,
      };
    }

    if (controllerPos && linkPos.getRangeTo(controllerPos) <= 2) {
      return {
        pos,
        priority: LINK_PRIORITY_CONTROLLER,
        commuteDistance: 0,
        referenceDistance,
      };
    }

    return {
      pos,
      priority: LINK_PRIORITY_OTHER,
      commuteDistance: getPathDistance(anchor, linkPos),
      referenceDistance,
    };
  });

  ordered.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    if (a.priority === LINK_PRIORITY_SOURCE && a.commuteDistance !== b.commuteDistance) {
      return b.commuteDistance - a.commuteDistance;
    }

    if (a.referenceDistance !== b.referenceDistance) {
      return a.referenceDistance - b.referenceDistance;
    }

    if (a.pos.x !== b.pos.x) {
      return a.pos.x - b.pos.x;
    }

    return a.pos.y - b.pos.y;
  });

  return ordered.map((entry) => entry.pos);
}

function getSortedLabPlannedPositions(layout: PlannedLayout): { x: number; y: number }[] {
  const planned = layout[STRUCTURE_LAB] ?? [];
  if (planned.length <= 2) {
    return planned;
  }

  return [...planned.slice(-2), ...planned.slice(0, -2)];
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

  const hasSpawn = countExisting(room, STRUCTURE_SPAWN) > 0;
  if (!hasSpawn) {
    const spawnTarget = Math.min(
      Math.max(getPlannedCount(layout, STRUCTURE_SPAWN), 1),
      getAllowedCount(STRUCTURE_SPAWN, controllerLevel),
    );
    if (spawnTarget > 0) {
      targetOverrides[STRUCTURE_SPAWN] = spawnTarget;
      return { allowedTypes: new Set([STRUCTURE_SPAWN]), targetOverrides };
    }

    return { allowedTypes: new Set(), targetOverrides };
  }

  if (controllerLevel <= 1) {
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
  const containerTarget = Math.min(
    getContainerPlannedPositions(room, layout, controllerLevel).length,
    getAllowedCount(STRUCTURE_CONTAINER, 3),
  );
  const towerReady = isComplete(room, STRUCTURE_TOWER, towerTarget);
  const containerReady = isComplete(room, STRUCTURE_CONTAINER, containerTarget);

  if (!towerReady || !containerReady) {
    targetOverrides[STRUCTURE_TOWER] = towerTarget;
    targetOverrides[STRUCTURE_CONTAINER] = containerTarget;
    return { allowedTypes: new Set([STRUCTURE_TOWER, STRUCTURE_CONTAINER]), targetOverrides };
  }

  if (countExisting(room, STRUCTURE_TOWER) <= 0) {
    return {
      allowedTypes: new Set(CONSTRUCTION_PRIORITY.filter((type) => type !== STRUCTURE_RAMPART)),
      targetOverrides,
    };
  }

  return { allowedTypes: new Set(CONSTRUCTION_PRIORITY), targetOverrides };
}

function countExisting(room: Room, structureType: BuildableStructureConstant): number {
  return room.find(FIND_STRUCTURES, {
    filter: (structure) => {
      if (structure.structureType !== structureType) {
        return false;
      }

      if ("my" in structure) {
        return (structure as { my?: boolean }).my === true;
      }

      return true;
    },
  }).length;
}

function countSites(room: Room, structureType: BuildableStructureConstant): number {
  return room.find(FIND_CONSTRUCTION_SITES, {
    filter: (site) => site.structureType === structureType && site.my,
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

function shouldSkipSourceContainerPlacement(room: Room, x: number, y: number): boolean {
  const source = getAdjacentSourceAt(room, x, y);
  return !!source && hasSourceAdjacentLink(source);
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

  if (countExisting(room, STRUCTURE_TOWER) <= 0) {
    return { roomAdded: 0, globalRemaining };
  }

  if (!canBuildAtControllerLevel(STRUCTURE_RAMPART, controllerLevel)) {
    return { roomAdded: 0, globalRemaining };
  }

  const plannedPositions = getPlannedRampartPositions(layout);
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

  const rooms = getTickContextService().getMyRooms();
  const configuredMaxNewSitesPerRoom = Memory.cfg?.roomPlannerBuild?.maxNewSitesPerRoom ?? DEFAULT_MAX_NEW_SITES_PER_ROOM;
  const maxNewSitesPerRoom = Math.min(configuredMaxNewSitesPerRoom, MAX_NEW_SITES_PER_RUN);
  let globalRemaining = GLOBAL_SITE_SOFT_CAP - currentGlobalSiteCount;
  let runRemaining = Math.min(MAX_NEW_SITES_PER_RUN, globalRemaining);

  for (const room of rooms) {
    if (globalRemaining <= 0 || runRemaining <= 0) {
      return;
    }

    let roomPlan = Memory.data?.roomPlanner?.[room.name];
    if (!roomPlan?.layout) {
      const planned = runPlannerForRoom(room.name);
      if (planned) {
        const saved = savePlannerForRoom(room.name);
        if (saved) {
          roomPlan = Memory.data?.roomPlanner?.[room.name];
          console.log(`[roomPlanner] ${room.name} regenerated missing layout`);
        }
      }
    }

    if (!roomPlan?.layout) {
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

      const plannedPositions =
        structureType === STRUCTURE_CONTAINER
          ? getContainerPlannedPositions(room, layout, controllerLevel)
          : structureType === STRUCTURE_LINK
            ? getSortedLinkPlannedPositions(room, layout)
          : structureType === STRUCTURE_LAB
            ? getSortedLabPlannedPositions(layout)
           : structureType === STRUCTURE_RAMPART
             ? getPlannedRampartPositions(layout)
           : (layout[structureType] ?? []);
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
        if (newSites >= maxNewSitesPerRoom || globalRemaining <= 0 || runRemaining <= 0) {
          break;
        }

        if (remaining <= 0) {
          break;
        }

        if (structureType === STRUCTURE_CONTAINER && shouldSkipSourceContainerPlacement(room, pos.x, pos.y)) {
          continue;
        }

        if (
          structureType === STRUCTURE_CONTAINER &&
          shouldDelayMineralContainerPlacement(room, pos.x, pos.y, controllerLevel)
        ) {
          continue;
        }

        if (!hasStructureOrSiteAt(room, pos.x, pos.y, structureType)) {
          const code = tryPlaceSite(room, structureType, pos.x, pos.y);
          if (code === OK) {
            newSites += 1;
            globalRemaining -= 1;
            runRemaining -= 1;
            remaining -= 1;
          } else if (code === ERR_FULL) {
            globalRemaining = 0;
            runRemaining = 0;
            break;
          }
        }
      }

      if (newSites >= maxNewSitesPerRoom || globalRemaining <= 0 || runRemaining <= 0) {
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
      Math.min(globalRemaining, runRemaining),
    );
    if (rampartQueued.roomAdded > 0) {
      globalRemaining = rampartQueued.globalRemaining;
      runRemaining = Math.max(0, runRemaining - rampartQueued.roomAdded);
      Memory.runtime = Memory.runtime || {};
      Memory.runtime.roomPlannerAuto = Memory.runtime.roomPlannerAuto || {};
      Memory.runtime.roomPlannerAuto[room.name] = Game.time;
      console.log(`[roomPlanner] ${room.name} queued ${rampartQueued.roomAdded} rampart site(s)`);
    }
  }
}

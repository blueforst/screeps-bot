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
const CONTROLLER_LINK_RANGE = 3;

type PlannedLayout = { [structureType: string]: { x: number; y: number }[] };
type TargetOverrideMap = Partial<Record<BuildableStructureConstant, number>>;

const LAYOUT_WORK_POS = 'work_pos';

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


function getContainerPlannedPositions(room: Room, layout: PlannedLayout, controllerLevel: number): { x: number; y: number }[] {
  const plannedLinkPositions = new Set((layout[STRUCTURE_LINK] ?? []).map((pos) => `${pos.x}:${pos.y}`));
  return (layout[STRUCTURE_CONTAINER] ?? []).filter((pos) => {
    const key = `${pos.x}:${pos.y}`;
    if (plannedLinkPositions.has(key)) return false;
    if (shouldSkipSourceContainerPlacement(room, pos.x, pos.y)) return false;
    if (shouldDelayMineralContainerPlacement(room, pos.x, pos.y, controllerLevel)) return false;
    return true;
  });
}

function getAutoExtractorCandidates(room: Room): { x: number; y: number }[] {
  return room.find(FIND_MINERALS).map((mineral) => ({ x: mineral.pos.x, y: mineral.pos.y }));
}

function getExtractorPlannedPositions(room: Room, layout: PlannedLayout): { x: number; y: number }[] {
  const merged = [...(layout[STRUCTURE_EXTRACTOR] ?? []), ...getAutoExtractorCandidates(room)];
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

    if (controllerPos && linkPos.getRangeTo(controllerPos) <= CONTROLLER_LINK_RANGE) {
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

  const blocksPlannedStructure = (existingType: StructureConstant): boolean => {
    if (existingType === structureType) {
      return true;
    }

    const plannedIsOverlay = structureType === STRUCTURE_ROAD || structureType === STRUCTURE_RAMPART;
    const existingIsOverlay = existingType === STRUCTURE_ROAD || existingType === STRUCTURE_RAMPART;
    return !plannedIsOverlay && !existingIsOverlay;
  };

  const structures = position.lookFor(LOOK_STRUCTURES);
  if (structures.some((structure) => blocksPlannedStructure(structure.structureType))) {
    return true;
  }

  const sites = position.lookFor(LOOK_CONSTRUCTION_SITES);
  return sites.some((site) => blocksPlannedStructure(site.structureType));
}

function tryPlaceSite(room: Room, structureType: BuildableStructureConstant, x: number, y: number): number {
  const result = room.createConstructionSite(x, y, structureType);
  return result;
}

function shouldSkipSourceContainerPlacement(room: Room, x: number, y: number): boolean {
  const source = getAdjacentSourceAt(room, x, y);
  return !!source && hasSourceAdjacentLink(source);
}

function destroyContainerAt(room: Room, pos: { x: number; y: number }): void {
  const position = new RoomPosition(pos.x, pos.y, room.name);
  const containers = position.lookFor(LOOK_STRUCTURES).filter(
    (s) => s.structureType === STRUCTURE_CONTAINER,
  ) as StructureContainer[];
  for (const container of containers) {
    container.destroy();
  }
}

export function getPlannedStoragePos(room: Room): RoomPosition | null {
  if (room.storage) return null;
  const layout = Memory.data?.roomPlanner?.[room.name]?.layout;
  if (!layout) return null;
  const pos = layout[STRUCTURE_STORAGE]?.[0];
  if (!pos) return null;
  return new RoomPosition(pos.x, pos.y, room.name);
}

export function getProtoStorageContainer(room: Room): StructureContainer | null {
  if (room.storage) return null;

  const layout = Memory.data?.roomPlanner?.[room.name]?.layout;
  if (!layout) return null;

  const pos = layout[STRUCTURE_STORAGE]?.[0];
  if (!pos) return null;

  const position = new RoomPosition(pos.x, pos.y, room.name);
  const containers = position.lookFor(LOOK_STRUCTURES).filter(
    (s) => s.structureType === STRUCTURE_CONTAINER,
  ) as StructureContainer[];

  return containers.length > 0 ? containers[0] : null;
}

function getControllerLinkPosFromLayout(room: Room, layout: PlannedLayout): { x: number; y: number } | null {
  const controllerPos = room.controller?.pos;
  if (!controllerPos) return null;
  for (const pos of layout[STRUCTURE_LINK] ?? []) {
    if (new RoomPosition(pos.x, pos.y, room.name).getRangeTo(controllerPos) <= CONTROLLER_LINK_RANGE) {
      return pos;
    }
  }
  return null;
}

function isControllerLinkNearStorage(controllerLinkPos: { x: number; y: number }, layout: PlannedLayout, roomName: string): boolean {
  const storagePlannedPos = layout[STRUCTURE_STORAGE]?.[0];
  if (!storagePlannedPos) return false;
  const storageRoomPos = new RoomPosition(storagePlannedPos.x, storagePlannedPos.y, roomName);
  const controllerRoomPos = new RoomPosition(controllerLinkPos.x, controllerLinkPos.y, roomName);
  return storageRoomPos.getRangeTo(controllerRoomPos) <= 5;
}

export function getPlannedControllerLinkPos(room: Room): RoomPosition | null {
  if (room.storage) return null;
  const layout = Memory.data?.roomPlanner?.[room.name]?.layout;
  if (!layout) return null;
  const pos = getControllerLinkPosFromLayout(room, layout);
  if (!pos) return null;
  if (isControllerLinkNearStorage(pos, layout, room.name)) return null;
  return new RoomPosition(pos.x, pos.y, room.name);
}

export function getProtoControllerLinkContainer(room: Room): StructureContainer | null {
  if (room.storage) return null;
  const layout = Memory.data?.roomPlanner?.[room.name]?.layout;
  if (!layout) return null;
  const pos = getControllerLinkPosFromLayout(room, layout);
  if (!pos) return null;
  if (isControllerLinkNearStorage(pos, layout, room.name)) return null;
  const position = new RoomPosition(pos.x, pos.y, room.name);
  const containers = position.lookFor(LOOK_STRUCTURES).filter(
    (s) => s.structureType === STRUCTURE_CONTAINER,
  ) as StructureContainer[];
  return containers.length > 0 ? containers[0] : null;
}

function runProtoStorageManagement(room: Room, layout: PlannedLayout, controllerLevel: number): void {
  const storagePos = layout[STRUCTURE_STORAGE]?.[0];
  if (!storagePos) return;

  // Remove if real storage exists or we've reached the RCL where storage can be built (RCL4)
  if (room.storage || canBuildAtControllerLevel(STRUCTURE_STORAGE, controllerLevel)) {
    destroyContainerAt(room, storagePos);
    return;
  }

  // Don't place if container already exists or is under construction
  if (hasStructureOrSiteAt(room, storagePos.x, storagePos.y, STRUCTURE_CONTAINER)) return;

  // Only place after RCL2 extensions are complete
  if (controllerLevel < 2) return;
  const extTarget = Math.min(5, getPlannedCount(layout, STRUCTURE_EXTENSION), getAllowedCount(STRUCTURE_EXTENSION, 2));
  if (!isComplete(room, STRUCTURE_EXTENSION, extTarget)) return;

  const code = room.createConstructionSite(storagePos.x, storagePos.y, STRUCTURE_CONTAINER);
  if (code === OK) {
    console.log(`[roomPlanner] ${room.name} placed proto-storage container at (${storagePos.x}, ${storagePos.y})`);
  }
}

function runProtoControllerLinkContainerManagement(room: Room, layout: PlannedLayout, controllerLevel: number): void {
  const pos = getControllerLinkPosFromLayout(room, layout);
  if (!pos) return;

  // If within range 5 of storage position, skip — shared with proto-storage container
  if (isControllerLinkNearStorage(pos, layout, room.name)) return;

  // Remove when real storage exists, RCL4 is reached, or a link is already being built there
  if (room.storage || canBuildAtControllerLevel(STRUCTURE_STORAGE, controllerLevel) ||
      hasStructureOrSiteAt(room, pos.x, pos.y, STRUCTURE_LINK)) {
    destroyContainerAt(room, pos);
    return;
  }

  // Don't place if container already exists or is under construction
  if (hasStructureOrSiteAt(room, pos.x, pos.y, STRUCTURE_CONTAINER)) return;

  // Only place after RCL2 extensions are complete (same timing as proto-storage container)
  if (controllerLevel < 2) return;
  const extTarget = Math.min(5, getPlannedCount(layout, STRUCTURE_EXTENSION), getAllowedCount(STRUCTURE_EXTENSION, 2));
  if (!isComplete(room, STRUCTURE_EXTENSION, extTarget)) return;

  const code = room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
  if (code === OK) {
    console.log(`[roomPlanner] ${room.name} placed proto-controller-link container at (${pos.x}, ${pos.y})`);
  }
}

/** Called once when a room plan is saved.  Places a temporary container at each
 *  source work position that has a planned link but no planned container.  The
 *  container gives harvesters a stable work tile until the link is built. */
export function placeProtoSourceContainersForRoom(roomName: string): void {
  const room = Game.rooms[roomName];
  if (!room) return;
  const layout = Memory.data?.roomPlanner?.[roomName]?.layout;
  if (!layout) return;

  const workPositions: { x: number; y: number }[] = layout[LAYOUT_WORK_POS] ?? [];
  const layoutContainerKeys = new Set((layout[STRUCTURE_CONTAINER] ?? []).map((c) => `${c.x}:${c.y}`));

  for (const source of room.find(FIND_SOURCES)) {
    const workPos = workPositions.find(
      (wp) => Math.abs(wp.x - source.pos.x) <= 1 && Math.abs(wp.y - source.pos.y) <= 1,
    );
    if (!workPos) continue;
    if (layoutContainerKeys.has(`${workPos.x}:${workPos.y}`)) continue;
    if (hasSourceAdjacentLink(source) || hasStructureOrSiteAt(room, workPos.x, workPos.y, STRUCTURE_LINK)) continue;
    if (hasStructureOrSiteAt(room, workPos.x, workPos.y, STRUCTURE_CONTAINER)) continue;

    const code = room.createConstructionSite(workPos.x, workPos.y, STRUCTURE_CONTAINER);
    if (code === OK) {
      console.log(`[roomPlanner] ${roomName} placed proto-source container at (${workPos.x}, ${workPos.y})`);
    }
  }
}

/** Runs in the periodic construction loop.  Destroys the proto-source container
 *  once its link has been built (or is under construction). */
function runProtoSourceContainerTeardown(room: Room, layout: PlannedLayout): void {
  const workPositions: { x: number; y: number }[] = layout[LAYOUT_WORK_POS] ?? [];
  const layoutContainerKeys = new Set((layout[STRUCTURE_CONTAINER] ?? []).map((c) => `${c.x}:${c.y}`));

  for (const source of room.find(FIND_SOURCES)) {
    const workPos = workPositions.find(
      (wp) => Math.abs(wp.x - source.pos.x) <= 1 && Math.abs(wp.y - source.pos.y) <= 1,
    );
    if (!workPos) continue;
    if (layoutContainerKeys.has(`${workPos.x}:${workPos.y}`)) continue;

    if (hasSourceAdjacentLink(source) || hasStructureOrSiteAt(room, workPos.x, workPos.y, STRUCTURE_LINK)) {
      destroyContainerAt(room, workPos);
    }
  }
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

export function getSourceContainerPositionsForRoom(roomName: string): { x: number; y: number }[] {
  const layout = Memory.data?.roomPlanner?.[roomName]?.layout;
  if (!layout) return [];
  const room = Game.rooms[roomName];
  if (!room) return [];
  const sources = room.find(FIND_SOURCES);

  // Containers explicitly planned (no link at source).
  const fromContainers = (layout[STRUCTURE_CONTAINER] ?? []).filter((pos) =>
    sources.some((s) => Math.abs(pos.x - s.pos.x) <= 1 && Math.abs(pos.y - s.pos.y) <= 1),
  );

  // Work positions for sources that have a planned link (proto container lives here).
  const containerKeys = new Set(fromContainers.map((p) => `${p.x}:${p.y}`));
  const fromWorkPos = (layout[LAYOUT_WORK_POS] ?? []).filter((wp) => {
    if (containerKeys.has(`${wp.x}:${wp.y}`)) return false;
    return sources.some((s) => Math.abs(wp.x - s.pos.x) <= 1 && Math.abs(wp.y - s.pos.y) <= 1);
  });

  return [...fromContainers, ...fromWorkPos];
}

export function getPlannedSourceContainerPos(source: Source): RoomPosition | null {
  const layout = Memory.data?.roomPlanner?.[source.room.name]?.layout;
  if (!layout) return null;

  // Container explicitly in layout (autoplanner chose no link for this source).
  const containerPos = (layout[STRUCTURE_CONTAINER] ?? []).find(
    (c) => Math.abs(c.x - source.pos.x) <= 1 && Math.abs(c.y - source.pos.y) <= 1,
  );
  if (containerPos) return new RoomPosition(containerPos.x, containerPos.y, source.room.name);

  // Source has a planned link — the autoplanner recorded a work_pos instead.
  // A proto container is placed there until the link is built.
  const workPos = (layout[LAYOUT_WORK_POS] ?? []).find(
    (wp) => Math.abs(wp.x - source.pos.x) <= 1 && Math.abs(wp.y - source.pos.y) <= 1,
  );
  return workPos ? new RoomPosition(workPos.x, workPos.y, source.room.name) : null;
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
          placeProtoSourceContainersForRoom(room.name);
          console.log(`[roomPlanner] ${room.name} regenerated missing layout`);
        }
      }
    }

    if (!roomPlan?.layout) {
      continue;
    }

    const controllerLevel = room.controller?.level ?? 0;
    const layout = roomPlan.layout;

    runProtoSourceContainerTeardown(room, layout);
    runProtoStorageManagement(room, layout, controllerLevel);
    runProtoControllerLinkContainerManagement(room, layout, controllerLevel);

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
          : structureType === STRUCTURE_EXTRACTOR
            ? getExtractorPlannedPositions(room, layout)
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

import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { isOwnedManagedRoom } from "@/runtime/roomTypes";
import { isDefenseMode } from "@/runtime/defenseMode";

export type RemoteMiningStatus = "scouting" | "active" | "suspended" | "abandoned";

export type RemoteSuspendReason =
  | "hostile_creeps"
  | "hostile_reservation"
  | "hostile_owner"
  | "hostile_structures"
  | "source_keeper";

export interface RemoteMiningTask {
  sourceRoom: string;
  targetRoom: string;
  status: RemoteMiningStatus;
  sourceIds: string[];
  assignedAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  suspendReason?: RemoteSuspendReason | string;
  suspendedAt?: number;
  lastThreatAt?: number;
  safeSince?: number;
  abandonedReason?: string;
  nextRetryAt?: number;
  roadPlan?: {
    positions: Array<{ x: number; y: number; roomName: string }>;
    generatedAt: number;
  };
  containerPositions?: Record<string, { x: number; y: number; roomName: string }>;
}

export interface RemoteMiningConfig {
  enabled: boolean;
  scanInterval: number;
  roadInterval: number;
  scoutTimeout: number;
  maxRemoteRoomsPerSourceRoom: number;
  maintenanceReserveEnergy: number;
  maxRemoteSitesPerRun: number;
  remoteSafeTicksToResume: number;
  remoteReservationRenewAt: number;
}

export const REMOTE_MINING_DEFAULTS: RemoteMiningConfig = {
  enabled: true,
  scanInterval: 50,
  roadInterval: 100,
  scoutTimeout: 1500,
  maxRemoteRoomsPerSourceRoom: 1,
  maintenanceReserveEnergy: 100,
  maxRemoteSitesPerRun: 2,
  remoteSafeTicksToResume: 100,
  remoteReservationRenewAt: 3000,
};

// Only cardinal neighbours (1/3/5/7) are candidates — diagonal rooms require multi-hop
// logistics and are excluded to keep CPU and carrier travel time bounded.
const CARDINAL_EXIT_DIRECTIONS = [FIND_EXIT_TOP, FIND_EXIT_RIGHT, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT];

export function getRemoteMiningConfig(): RemoteMiningConfig {
  const overrides = Memory.cfg?.remoteMining;
  if (!overrides) {
    return { ...REMOTE_MINING_DEFAULTS };
  }
  return {
    enabled: overrides.enabled !== false,
    scanInterval: overrides.scanInterval ?? REMOTE_MINING_DEFAULTS.scanInterval,
    roadInterval: overrides.roadInterval ?? REMOTE_MINING_DEFAULTS.roadInterval,
    scoutTimeout: overrides.scoutTimeout ?? REMOTE_MINING_DEFAULTS.scoutTimeout,
    maxRemoteRoomsPerSourceRoom:
      overrides.maxRemoteRoomsPerSourceRoom ?? REMOTE_MINING_DEFAULTS.maxRemoteRoomsPerSourceRoom,
    maintenanceReserveEnergy: overrides.maintenanceReserveEnergy ?? REMOTE_MINING_DEFAULTS.maintenanceReserveEnergy,
    maxRemoteSitesPerRun: overrides.maxRemoteSitesPerRun ?? REMOTE_MINING_DEFAULTS.maxRemoteSitesPerRun,
    remoteSafeTicksToResume: overrides.remoteSafeTicksToResume ?? REMOTE_MINING_DEFAULTS.remoteSafeTicksToResume,
    remoteReservationRenewAt: overrides.remoteReservationRenewAt ?? REMOTE_MINING_DEFAULTS.remoteReservationRenewAt,
  };
}

export function ensureRemoteMiningStore(): Record<string, RemoteMiningTask> {
  const data = getMemoryService().ensureData();
  if (!data.remoteMining) {
    data.remoteMining = {};
  }
  return data.remoteMining;
}

export function getRemoteMiningHarvesterConfigName(
  sourceRoom: string,
  targetRoom: string,
  sourceId: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:harvester:${sourceId}`;
}

export function getRemoteMiningCarrierConfigName(
  sourceRoom: string,
  targetRoom: string,
  index: number,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:carrier:${index}`;
}

export function getRemoteMiningScoutConfigName(
  sourceRoom: string,
  targetRoom: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:scout`;
}

export function getRemoteMiningReserverConfigName(
  sourceRoom: string,
  targetRoom: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:reserver:0`;
}

function isRouteDirect(sourceRoom: string, targetRoom: string): boolean {
  const route = Game.map.findRoute(sourceRoom, targetRoom);
  if (route === ERR_NO_PATH || !Array.isArray(route)) {
    return false;
  }
  return route.length === 1;
}

function isRoomStatusNormal(roomName: string): boolean {
  return Game.map.getRoomStatus(roomName).status === "normal";
}

// WORK indicates competition, not combat danger; only combat/heal parts trigger suspension.
const DANGEROUS_CREEP_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL];

function hasDangerousHostileCreeps(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  for (const creep of hostiles) {
    for (const part of DANGEROUS_CREEP_PARTS) {
      if (typeof creep.getActiveBodyparts === "function") {
        if (creep.getActiveBodyparts(part) > 0) return true;
      } else if (creep.body && Array.isArray(creep.body)) {
        if (creep.body.some((bp: BodyPartDefinition) => bp.type === part && bp.hits > 0)) return true;
      }
    }
  }
  return false;
}

export function getRemoteThreatReason(room: Room): RemoteSuspendReason | null {
  const controller = room.controller;

  if (controller?.owner && !controller.my) {
    return "hostile_owner";
  }

  if (controller?.reservation && controller.reservation.username !== getMyUsername()) {
    return "hostile_reservation";
  }

  if (hasDangerousHostileCreeps(room)) {
    return "hostile_creeps";
  }

  const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) => structure.structureType !== STRUCTURE_CONTROLLER,
  });
  if (hostileStructures.length > 0) {
    return "hostile_structures";
  }

  const keeperLairs = room.find(FIND_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_KEEPER_LAIR,
  });
  if (keeperLairs.length > 0) {
    return "source_keeper";
  }

  return null;
}

function isRemoteRoomSafe(room: Room): boolean {
  return getRemoteThreatReason(room) === null;
}

export function getMyUsername(): string | null {
  const firstSpawn = Object.values(Game.spawns)[0];
  if (firstSpawn) {
    return firstSpawn.owner.username;
  }
  const firstCreep = Object.values(Game.creeps)[0];
  if (firstCreep) {
    return firstCreep.owner.username;
  }
  return null;
}

function countSourceRoomRemotes(store: Record<string, RemoteMiningTask>, sourceRoom: string): number {
  let count = 0;
  for (const task of Object.values(store)) {
    if (task.sourceRoom === sourceRoom && (task.status === "active" || task.status === "scouting")) {
      count++;
    }
  }
  return count;
}

export function upsertScoutConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);
  getCreepConfigService().upsert(configName, "scout", [targetRoom], sourceRoom);
}

function removeScoutConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();
  const liveCreeps = tickContext.getCreepsByConfigName(configName);

  if (liveCreeps.length > 0) {
    const config = creepConfigs.get(configName);
    if (config) {
      delete config.roomName;
    }
  } else {
    creepConfigs.remove(configName);
  }
}

function removeScoutIfVisible(sourceRoom: string, targetRoom: string): void {
  if (!Game.rooms[targetRoom]) return;
  removeScoutConfig(sourceRoom, targetRoom);
  removeScoutFromSpawnQueues(sourceRoom, targetRoom);
}

function removeScoutFromSpawnQueues(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) {
      continue;
    }
    const idx = queue.indexOf(configName);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
  }
}

function abandonTask(
  task: RemoteMiningTask,
  reason: "not_dual_source" | "unsafe" | "not_normal" | "not_direct" | "scout_timeout",
): void {
  task.status = "abandoned";
  task.abandonedReason = reason;
  task.updatedAt = Game.time;
  task.nextRetryAt = Game.time + 5000;
}

function processScoutLifecycle(store: Record<string, RemoteMiningTask>, config: RemoteMiningConfig): void {
  const now = Game.time;

  for (const task of Object.values(store)) {
    if (task.status !== "scouting") {
      continue;
    }

    if (now - task.assignedAt > config.scoutTimeout) {
      abandonTask(task, "scout_timeout");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    upsertScoutConfig(task.sourceRoom, task.targetRoom);

    const visibleRoom = Game.rooms[task.targetRoom];
    if (!visibleRoom) {
      continue;
    }

    if (!isRouteDirect(task.sourceRoom, task.targetRoom)) {
      abandonTask(task, "not_direct");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (!isRoomStatusNormal(task.targetRoom)) {
      abandonTask(task, "not_normal");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    const sources = visibleRoom.find(FIND_SOURCES);
    if (sources.length !== 2) {
      abandonTask(task, "not_dual_source");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (!isRemoteRoomSafe(visibleRoom)) {
      abandonTask(task, "unsafe");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    task.status = "active";
    task.sourceIds = sources.map((s) => s.id);
    task.updatedAt = now;
    task.lastVerifiedAt = now;

    removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
    removeScoutConfig(task.sourceRoom, task.targetRoom);
  }
}

// ─── Remote road/container construction ─────────────────────────────

const GLOBAL_SITE_SOFT_CAP = 95;

function getStartAnchor(sourceRoom: Room): RoomPosition | null {
  if (sourceRoom.storage) {
    return sourceRoom.storage.pos;
  }
  const spawn = getTickContextService().getPrimarySpawnByRoom(sourceRoom.name);
  if (spawn) {
    return spawn.pos;
  }
  if (sourceRoom.controller) {
    return sourceRoom.controller.pos;
  }
  return null;
}

function isWalkableTile(x: number, y: number): boolean {
  return x > 0 && x < 49 && y > 0 && y < 49;
}

function getAdjacentTiles(pos: RoomPosition): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      if (isWalkableTile(nx, ny)) {
        tiles.push({ x: nx, y: ny });
      }
    }
  }
  return tiles;
}

const BLOCKING_STRUCTURE_TYPES: Set<StructureConstant> = new Set([
  STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_WALL,
  STRUCTURE_RAMPART, STRUCTURE_LINK, STRUCTURE_STORAGE, STRUCTURE_TERMINAL,
  STRUCTURE_NUKER, STRUCTURE_FACTORY, STRUCTURE_OBSERVER, STRUCTURE_POWER_SPAWN,
  STRUCTURE_LAB, STRUCTURE_EXTRACTOR,
]);

function isTileBlockedByStructure(room: Room, x: number, y: number): boolean {
  const pos = new RoomPosition(x, y, room.name);
  const structures = pos.lookFor(LOOK_STRUCTURES);
  for (const s of structures) {
    if (BLOCKING_STRUCTURE_TYPES.has(s.structureType)) return true;
  }
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  for (const site of sites) {
    if (BLOCKING_STRUCTURE_TYPES.has(site.structureType)) return true;
  }
  return false;
}

function selectContainerPosition(
  source: Source,
  pathPositions: Array<{ x: number; y: number; roomName: string }>,
): { x: number; y: number; roomName: string } | null {
  const room = source.room;
  const pathSet = new Set(pathPositions.filter(p => p.roomName === room.name).map(p => `${p.x}:${p.y}`));
  const adjacent = getAdjacentTiles(source.pos);
  const terrain = room.getTerrain();

  for (const tile of adjacent) {
    const terrainType = terrain.get(tile.x, tile.y);
    if (terrainType === TERRAIN_MASK_WALL) continue;
    if (isTileBlockedByStructure(room, tile.x, tile.y)) continue;
    if (pathSet.has(`${tile.x}:${tile.y}`)) {
      return { x: tile.x, y: tile.y, roomName: room.name };
    }
  }

  for (const tile of adjacent) {
    const terrainType = terrain.get(tile.x, tile.y);
    if (terrainType === TERRAIN_MASK_WALL) continue;
    if (isTileBlockedByStructure(room, tile.x, tile.y)) continue;
    return { x: tile.x, y: tile.y, roomName: room.name };
  }

  return null;
}

function hasExactRoadOrSite(room: Room, x: number, y: number, structureType: BuildableStructureConstant): boolean {
  const pos = new RoomPosition(x, y, room.name);
  const structures = pos.lookFor(LOOK_STRUCTURES);
  if (structures.some(s => s.structureType === structureType)) return true;
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  if (sites.some(s => s.structureType === structureType)) return true;
  return false;
}

function hasContainerNearPosition(
  room: Room,
  sourcePos: RoomPosition,
  range: number = 2,
  excludedPositions?: Set<string>,
): boolean {
  const containers = room.find(FIND_STRUCTURES).filter(s =>
    s.structureType === STRUCTURE_CONTAINER &&
    Math.abs(s.pos.x - sourcePos.x) <= range &&
    Math.abs(s.pos.y - sourcePos.y) <= range &&
    !excludedPositions?.has(`${s.pos.x}:${s.pos.y}`),
  );
  if (containers.length > 0) return true;

  const sites = room.find(FIND_CONSTRUCTION_SITES).filter(s =>
    s.structureType === STRUCTURE_CONTAINER &&
    (s as ConstructionSite).my &&
    Math.abs(s.pos.x - sourcePos.x) <= range &&
    Math.abs(s.pos.y - sourcePos.y) <= range &&
    !excludedPositions?.has(`${s.pos.x}:${s.pos.y}`),
  );
  return sites.length > 0;
}

function generateRoadPlan(
  task: RemoteMiningTask,
): { positions: Array<{ x: number; y: number; roomName: string }>; containers: Record<string, { x: number; y: number; roomName: string }> } | null {
  const sourceRoom = Game.rooms[task.sourceRoom];
  if (!sourceRoom) return null;

  const startPos = getStartAnchor(sourceRoom);
  if (!startPos) return null;

  const allPositions: Array<{ x: number; y: number; roomName: string }> = [];
  const containers: Record<string, { x: number; y: number; roomName: string }> = {};
  // Track planned road positions from earlier source paths so later paths prefer them
  const plannedKeys = new Set<string>();

  // Pre-seed with existing roads/construction sites in the target room
  const targetRoomObj = Game.rooms[task.targetRoom];
  if (targetRoomObj) {
    const existingRoads = targetRoomObj.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_ROAD);
    for (const r of existingRoads) {
      plannedKeys.add(`${r.pos.x}:${r.pos.y}`);
    }
    const existingSites = targetRoomObj.find(FIND_CONSTRUCTION_SITES).filter(s => s.structureType === STRUCTURE_ROAD);
    for (const s of existingSites) {
      plannedKeys.add(`${s.pos.x}:${s.pos.y}`);
    }
  }

  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById(sourceId as Id<Source>);
    if (!source) return null;

    // Build a roomCallback that makes planned positions cheap to encourage reuse
    const roomCallback = (roomName: string) => {
      const cm = new PathFinder.CostMatrix();
      if (roomName === task.targetRoom) {
        for (const key of plannedKeys) {
          const [sx, sy] = key.split(":").map(Number);
          cm.set(sx, sy, 1);
        }
      }
      return cm;
    };

    const result = PathFinder.search(
      startPos,
      { pos: source.pos, range: 1 },
      { maxRooms: 2, plainCost: 2, swampCost: 10, roomCallback },
    );

    if (result.incomplete) return null;

    for (const pos of result.path) {
      if (pos.roomName === task.targetRoom) {
        const key = `${pos.x}:${pos.y}`;
        plannedKeys.add(key);
        allPositions.push({ x: pos.x, y: pos.y, roomName: pos.roomName });
      }
    }

    const containerPos = selectContainerPosition(source, allPositions);
    if (containerPos) {
      containers[sourceId] = containerPos;
    }
  }

  // Deduplicate positions by roomName:x:y (shared corridor segments)
  const seen = new Set<string>();
  const deduped: Array<{ x: number; y: number; roomName: string }> = [];
  for (const p of allPositions) {
    const k = `${p.roomName}:${p.x}:${p.y}`;
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(p);
    }
  }

  return { positions: deduped, containers };
}

export function processRemoteConstruction(
  store: Record<string, RemoteMiningTask>,
  config: RemoteMiningConfig,
): void {
  if (Memory.cfg?.roomPlannerBuild?.enabled === false) {
    return;
  }

  const globalSiteCount = Object.keys(Game.constructionSites ?? {}).length;
  if (globalSiteCount >= GLOBAL_SITE_SOFT_CAP) {
    return;
  }

  for (const task of Object.values(store)) {
    if (task.status !== "active") continue;

    const needsPlan = !task.roadPlan ||
      (task.roadPlan.generatedAt <= Game.time && Game.time - task.roadPlan.generatedAt >= config.roadInterval) ||
      Game.time < task.roadPlan.generatedAt;

    if (needsPlan && task.sourceIds.length > 0) {
      const plan = generateRoadPlan(task);
      if (plan) {
        task.roadPlan = {
          positions: plan.positions,
          generatedAt: Game.time,
        };
        task.containerPositions = plan.containers;
      }
    }

    if (!task.roadPlan || !task.roadPlan.positions.length) continue;

    let sitesPlaced = 0;
    let globalRemaining = GLOBAL_SITE_SOFT_CAP - Object.keys(Game.constructionSites ?? {}).length;

    const containerKeySet = new Set<string>();
    if (task.containerPositions) {
      for (const sourceId of task.sourceIds) {
        if (sitesPlaced >= config.maxRemoteSitesPerRun) break;
        if (globalRemaining <= 0) break;

        const containerPos = task.containerPositions[sourceId];
        if (!containerPos) continue;

        containerKeySet.add(`${containerPos.x}:${containerPos.y}:${containerPos.roomName}`);

        const room = Game.rooms[containerPos.roomName];
        if (!room) continue;

        // Exclude containers/sites located at other sources' planned container positions,
        // so a close neighbour source's container does not satisfy this source's guard.
        const otherSourceContainerKeys = new Set<string>();
        for (const otherId of task.sourceIds) {
          if (otherId === sourceId) continue;
          const otherPos = task.containerPositions?.[otherId];
          if (otherPos) otherSourceContainerKeys.add(`${otherPos.x}:${otherPos.y}`);
        }

        const sourceObj = Game.getObjectById(sourceId as Id<Source>);
        if (sourceObj && hasContainerNearPosition(room, sourceObj.pos, 2, otherSourceContainerKeys)) continue;

        if (hasExactRoadOrSite(room, containerPos.x, containerPos.y, STRUCTURE_CONTAINER)) continue;

        const code = room.createConstructionSite(containerPos.x, containerPos.y, STRUCTURE_CONTAINER);
        if (code === OK) {
          sitesPlaced++;
          globalRemaining--;
        } else if (code === ERR_FULL) {
          return;
        }
      }
    }

    for (const pos of task.roadPlan.positions) {
      if (sitesPlaced >= config.maxRemoteSitesPerRun) break;
      if (globalRemaining <= 0) break;
      if (pos.roomName !== task.targetRoom) continue;

      if (containerKeySet.has(`${pos.x}:${pos.y}:${pos.roomName}`)) continue;

      const room = Game.rooms[pos.roomName];
      if (!room) continue;

      if (hasExactRoadOrSite(room, pos.x, pos.y, STRUCTURE_ROAD)) continue;

      const code = room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD);
      if (code === OK) {
        sitesPlaced++;
        globalRemaining--;
      } else if (code === ERR_FULL) {
        return;
      }
    }
  }
}

// ─── Config lifecycle ────────────────────────────────────────────

// RCL7 is the minimum for remote mining — below that the room lacks the infrastructure
// to support cross-room logistics (terminal, factory, enough spawn capacity for large haulers).
function isSourceRoomValidForRemote(sourceRoomName: string): boolean {
  const room = Game.rooms[sourceRoomName];
  if (!room) return false;
  if (!room.controller || !room.controller.my) return false;
  return room.controller.level >= 7;
}

function isRemoteManagedConfig(configName: string, sourceRoom: string, targetRoom: string): boolean {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  if (!configName.startsWith(prefix)) return false;
  const suffix = configName.slice(prefix.length);
  return suffix.startsWith("harvester:") || suffix.startsWith("carrier:") || suffix.startsWith("reserver:");
}

function discoverStaleConfigNames(sourceRoom: string, targetRoom: string): string[] {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  const creepConfigs = getCreepConfigService();
  const allConfigs = creepConfigs.list(prefix);
  const staleNames: string[] = [];
  for (const configName of Object.keys(allConfigs)) {
    const suffix = configName.slice(prefix.length);
    if (suffix.startsWith("harvester:") || suffix.startsWith("carrier:") || suffix.startsWith("reserver:")) {
      staleNames.push(configName);
    }
  }
  return staleNames;
}

function removeRemoteConfig(configName: string): void {
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();
  const liveCreeps = tickContext.getCreepsByConfigName(configName);

  if (liveCreeps.length > 0) {
    const config = creepConfigs.get(configName);
    if (config) {
      delete config.roomName;
    }
  } else {
    creepConfigs.remove(configName);
  }
}

function removeReserverConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningReserverConfigName(sourceRoom, targetRoom);
  removeRemoteConfig(configName);
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    const idx = queue.indexOf(configName);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
  }
}

function removeRemotePrefixFromSpawnQueues(
  sourceRoom: string,
  targetRoom: string,
): void {
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    spawn.memory.spawnList = queue.filter(
      name => !isRemoteManagedConfig(name, sourceRoom, targetRoom),
    );
  }
}

function cleanupRemoteConfigs(
  task: RemoteMiningTask,
): void {
  const staleNames = discoverStaleConfigNames(task.sourceRoom, task.targetRoom);
  removeRemotePrefixFromSpawnQueues(task.sourceRoom, task.targetRoom);
  for (const configName of staleNames) {
    removeRemoteConfig(configName);
  }
}

/** Remove carrier configs whose index exceeds task.sourceIds.length.
 *  Keeps carrier:0 through carrier:(sourceIds.length-1). Orphans configs
 *  with live creeps instead of deleting them, so existing creeps finish
 *  their lifecycle naturally. */
function reconcileStaleCarrierConfigs(task: RemoteMiningTask): void {
  const prefix = `${task.sourceRoom}:remoteMine:${task.targetRoom}:`;
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();
  const allConfigs = creepConfigs.list(prefix);
  const maxValidIndex = task.sourceIds.length - 1;

  for (const configName of Object.keys(allConfigs)) {
    const suffix = configName.slice(prefix.length);
    if (!suffix.startsWith("carrier:")) continue;

    const indexStr = suffix.slice("carrier:".length);
    const index = parseInt(indexStr, 10);
    if (isNaN(index) || index <= maxValidIndex) continue;

    // Remove from spawn queues
    for (const spawn of tickContext.getSpawnsByRoom(task.sourceRoom)) {
      const queue = spawn.memory.spawnList;
      if (!queue || queue.length === 0) continue;
      const idx = queue.indexOf(configName);
      if (idx >= 0) {
        queue.splice(idx, 1);
      }
    }

    // Orphan or remove
    const liveCreeps = tickContext.getCreepsByConfigName(configName);
    if (liveCreeps.length > 0) {
      const config = creepConfigs.get(configName);
      if (config) {
        delete config.roomName;
      }
    } else {
      creepConfigs.remove(configName);
    }
  }
}

function upsertHarvesterConfigs(task: RemoteMiningTask): void {
  const creepConfigs = getCreepConfigService();
  for (const sourceId of task.sourceIds) {
    const configName = getRemoteMiningHarvesterConfigName(
      task.sourceRoom,
      task.targetRoom,
      sourceId,
    );
    creepConfigs.upsert(
      configName,
      "colonizerHarvester",
      [task.targetRoom, sourceId],
      task.sourceRoom,
    );
  }
}

function upsertCarrierConfigs(task: RemoteMiningTask): void {
  const creepConfigs = getCreepConfigService();
  for (let i = 0; i < task.sourceIds.length; i++) {
    const sourceId = task.sourceIds[i];
    const configName = getRemoteMiningCarrierConfigName(
      task.sourceRoom,
      task.targetRoom,
      i,
    );
    creepConfigs.upsert(
      configName,
      "remoteMiningCarrier",
      [task.targetRoom, sourceId],
      task.sourceRoom,
    );
  }
}

function upsertReserverConfig(task: RemoteMiningTask, config: RemoteMiningConfig): void {
  const configName = getRemoteMiningReserverConfigName(task.sourceRoom, task.targetRoom);
  const creepConfigs = getCreepConfigService();
  const myUsername = getMyUsername();

  const visibleTarget = Game.rooms[task.targetRoom];
  if (visibleTarget) {
    const controller = visibleTarget.controller;
    if (controller?.owner) {
      removeReserverConfig(task.sourceRoom, task.targetRoom);
      return;
    }
    if (controller?.reservation && controller.reservation.username !== myUsername) {
      removeReserverConfig(task.sourceRoom, task.targetRoom);
      return;
    }
    if (
      controller?.reservation &&
      controller.reservation.username === myUsername &&
      controller.reservation.ticksToEnd >= config.remoteReservationRenewAt
    ) {
      removeReserverConfig(task.sourceRoom, task.targetRoom);
      return;
    }
  }

  creepConfigs.upsert(
    configName,
    "remoteMiningReserver",
    [task.targetRoom],
    task.sourceRoom,
  );
}

export function processRemoteConfigLifecycle(
  store: Record<string, RemoteMiningTask>,
  config: RemoteMiningConfig,
): void {
  for (const task of Object.values(store)) {
    if (task.status === "scouting") {
      continue;
    }

    if (task.status === "abandoned") {
      cleanupRemoteConfigs(task);
      removeScoutIfVisible(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (task.status === "suspended") {
      cleanupRemoteConfigs(task);

      let resumed = false;
      const visibleTarget = Game.rooms[task.targetRoom];
      if (visibleTarget) {
        const threatReason = getRemoteThreatReason(visibleTarget);
        if (threatReason !== null) {
          task.lastThreatAt = Game.time;
          task.updatedAt = Game.time;
          delete task.safeSince;
        } else {
          if (task.safeSince === undefined) {
            task.safeSince = Game.time;
          }
          const safeTicks = Game.time - task.safeSince;
          if (safeTicks >= config.remoteSafeTicksToResume) {
            task.status = "active";
            delete task.suspendReason;
            delete task.suspendedAt;
            delete task.lastThreatAt;
            delete task.safeSince;
            task.updatedAt = Game.time;
            resumed = true;
          }
        }
      }
      if (!resumed) {
        if (isSourceRoomValidForRemote(task.sourceRoom) && !isDefenseMode(task.sourceRoom)) {
          if (!Game.rooms[task.targetRoom]) {
            upsertScoutConfig(task.sourceRoom, task.targetRoom);
          } else {
            removeScoutConfig(task.sourceRoom, task.targetRoom);
            removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
          }
        } else {
          removeScoutIfVisible(task.sourceRoom, task.targetRoom);
        }
        continue;
      }
    }

    if (!isSourceRoomValidForRemote(task.sourceRoom)) {
      cleanupRemoteConfigs(task);
      removeScoutIfVisible(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (isDefenseMode(task.sourceRoom)) {
      cleanupRemoteConfigs(task);
      removeScoutIfVisible(task.sourceRoom, task.targetRoom);
      continue;
    }

    // Conservative threat policy: suspend immediately on any hostile detection,
    // no defender squads spawned. Resume only after remoteSafeTicksToResume safe ticks.
    const visibleTarget = Game.rooms[task.targetRoom];
    if (visibleTarget) {
      const threatReason = getRemoteThreatReason(visibleTarget);
      if (threatReason !== null) {
        task.status = "suspended";
        task.suspendReason = threatReason;
        task.suspendedAt = Game.time;
        task.lastThreatAt = Game.time;
        delete task.safeSince;
        task.updatedAt = Game.time;
        cleanupRemoteConfigs(task);
        removeScoutConfig(task.sourceRoom, task.targetRoom);
        removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
        continue;
      }
    }

    // Scout is only needed when room visibility is lost.
    if (!Game.rooms[task.targetRoom]) {
      upsertScoutConfig(task.sourceRoom, task.targetRoom);
    } else {
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
    }

    upsertHarvesterConfigs(task);
    upsertCarrierConfigs(task);
    reconcileStaleCarrierConfigs(task);
    upsertReserverConfig(task, config);
  }
}

export function runRemoteMining(): void {
  const config = getRemoteMiningConfig();
  if (!config.enabled) {
    return;
  }

  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  if (!Memory.runtime.remoteMining) {
    Memory.runtime.remoteMining = {};
  }

  const store = ensureRemoteMiningStore();

  processScoutLifecycle(store, config);
  processRemoteConstruction(store, config);
  processRemoteConfigLifecycle(store, config);

  const lastScanAt = Memory.runtime.remoteMining.lastScanAt;
  if (lastScanAt !== undefined && typeof lastScanAt === "number" && lastScanAt <= Game.time && Game.time - lastScanAt < config.scanInterval) {
    return;
  }

  Memory.runtime.remoteMining.lastScanAt = Game.time;

  const tickContext = getTickContextService();
  const myRooms = tickContext.getMyRooms();

  const sourceRooms = myRooms
    .filter((room) => {
      if (!isOwnedManagedRoom(room.name)) {
        return false;
      }
      if (!room.controller || !room.controller.my) {
        return false;
      }
      return room.controller.level >= 7;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // First-come-first-served: source rooms are sorted lexicographically; the first room
  // to claim an eligible target wins. This avoids coordination overhead between rooms.
  for (const sourceRoom of sourceRooms) {
    const currentCount = countSourceRoomRemotes(store, sourceRoom.name);
    if (currentCount >= config.maxRemoteRoomsPerSourceRoom) {
      continue;
    }

    const exits = Game.map.describeExits(sourceRoom.name);
    if (!exits) {
      continue;
    }

    for (const direction of CARDINAL_EXIT_DIRECTIONS) {
      const targetRoom = exits[direction];
      if (!targetRoom) {
        continue;
      }

      if (store[targetRoom]) {
        continue;
      }

      if (!isRouteDirect(sourceRoom.name, targetRoom)) {
        continue;
      }

      if (!isRoomStatusNormal(targetRoom)) {
        continue;
      }

      const visibleRoom = Game.rooms[targetRoom];
      const now = Game.time;

      if (!visibleRoom) {
        store[targetRoom] = {
          sourceRoom: sourceRoom.name,
          targetRoom,
          status: "scouting",
          sourceIds: [],
          assignedAt: now,
          updatedAt: now,
        };
        upsertScoutConfig(sourceRoom.name, targetRoom);
        break;
      }

      const sources = visibleRoom.find(FIND_SOURCES);
      if (sources.length !== 2) {
        continue;
      }

      if (!isRemoteRoomSafe(visibleRoom)) {
        continue;
      }

      store[targetRoom] = {
        sourceRoom: sourceRoom.name,
        targetRoom,
        status: "active",
        sourceIds: sources.map((s) => s.id),
        assignedAt: now,
        updatedAt: now,
        lastVerifiedAt: now,
      };
      break;
    }
  }
}

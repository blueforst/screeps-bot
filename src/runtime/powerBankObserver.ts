import { POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { recordPowerBankDiscovery } from "@/runtime/powerBankDiscovery";
import { getMemoryService, getTickContextService, getCreepConfigService } from "@/runtime/runtimeServices";
import { getPowerBankRegion, getUnconfirmedPowerBankRouteRooms } from "@/runtime/powerBankRegion";

const REGION_REFRESH_TICKS = 250;
const REMOTE_RECHECK_TICKS = 100;
const MAX_VISION_REQUESTS = 256;
const MAX_SCOUT_TARGETS = 16;
const MAX_REMOTE_SCOUT_FALLBACKS = 2;
const POWER_BANK_SCOUT_CONFIG = "powerbank:patrol:scout:0";

export interface PendingObservation {
  requestedAt: number;
  observerId: string;
  priority: number;
}

interface ObserverFailure {
  count: number;
  nextAttemptAt: number;
  reason: string;
}

interface VisionRequest {
  roomName: string;
  reason: string;
  priority: number;
  refreshTicks: number;
  deadline: number;
  continuous: boolean;
  sourceRoom?: string;
}

export interface PowerBankVisionSnapshot {
  tick: number;
  region: ReturnType<typeof getPowerBankRegion>;
  observers: Array<{ roomName: string; id: string }>;
  pending: Record<string, PendingObservation>;
  unmet: PowerBankObserverState["unmet"];
  scoutTargets: string[];
  remoteScoutTargets: string[];
}

export interface PowerBankObserverState {
  patrolIndex: number;
  updatedAt: number;
  lastObservedRooms: string[];
  coveredRooms: string[];
  pending: Record<string, PendingObservation>;
  lastVisibleAt: Record<string, number>;
  lastObserverVisibleAt: Record<string, number>;
  failures: Record<string, ObserverFailure>;
  unmet: Array<{ roomName: string; reason: string; priority: number; deadline: number }>;
  submittedByObserver?: Record<string, number>;
  scoutTargets?: string[];
  scoutUpdatedAt?: number;
  remoteScoutTargets?: string[];
}

function getState(): PowerBankObserverState {
  const runtime = getMemoryService().ensureRuntime() as any;
  const existing = (runtime.powerBankObserver ?? {}) as Partial<PowerBankObserverState>;
  const state: PowerBankObserverState = {
    patrolIndex: existing.patrolIndex ?? 0,
    updatedAt: existing.updatedAt ?? Game.time,
    lastObservedRooms: existing.lastObservedRooms ?? [],
    coveredRooms: existing.coveredRooms ?? [],
    pending: existing.pending ?? {},
    lastVisibleAt: existing.lastVisibleAt ?? {},
    lastObserverVisibleAt: existing.lastObserverVisibleAt ?? {},
    failures: existing.failures ?? {},
    unmet: existing.unmet ?? [],
    submittedByObserver: existing.submittedByObserver ?? {},
    scoutTargets: existing.scoutTargets,
    scoutUpdatedAt: existing.scoutUpdatedAt,
    remoteScoutTargets: existing.remoteScoutTargets,
  };
  runtime.powerBankObserver = state;
  return state;
}

function getUsername(): string | undefined {
  const spawn = getTickContextService().getAllSpawns()[0];
  if (spawn) return spawn.owner.username;
  return getTickContextService().getAllCreeps()[0]?.owner.username;
}

function hasHostileCombatPresence(room: Room): boolean {
  const context = getTickContextService().getRoomContext(room);
  const hostileCreeps = context?.getHostileCreeps() ?? room.find(FIND_HOSTILE_CREEPS);
  for (const creep of hostileCreeps) {
    if (
      creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0
    ) return true;
  }
  if ((context?.getHostilePowerCreeps() ?? room.find(FIND_HOSTILE_POWER_CREEPS)).length > 0) return true;
  const hostileStructures = context?.getHostileStructures() ?? room.find(FIND_HOSTILE_STRUCTURES);
  return hostileStructures.some((structure) =>
    structure.structureType === STRUCTURE_TOWER || structure.structureType === STRUCTURE_INVADER_CORE,
  );
}

function updateTransitRisk(room: Room): void {
  const runtime = getMemoryService().ensureRuntime() as NonNullable<Memory["runtime"]> & {
    powerBankDangerRevision?: number;
  };
  const username = getUsername();
  const controller = room.controller;
  const hostileController = !!username && (
    (!!controller?.owner && controller.owner.username !== username) ||
    (!!controller?.reservation && controller.reservation.username !== username)
  );
  const permanent = runtime.powerBankPermanentDangerRooms ?? (runtime.powerBankPermanentDangerRooms = {});
  const temporary = runtime.transitDangerRooms ?? (runtime.transitDangerRooms = {});
  const hostileCombat = hasHostileCombatPresence(room);
  let changed = false;

  if (hostileController) {
    if (!permanent[room.name]) {
      permanent[room.name] = true;
      changed = true;
    }
  } else if (permanent[room.name]) {
    delete permanent[room.name];
    changed = true;
  }

  if (hostileCombat) {
    const expiry = Game.time + 500;
    if (expiry > (temporary[room.name] ?? 0) + 25) {
      temporary[room.name] = expiry;
      changed = true;
    }
  } else if (!hostileController && (temporary[room.name] ?? Infinity) <= Game.time) {
    // An expired warning becomes confirmed clear only after the room is visible
    // and its current controller/hostile-creep state has been inspected.
    delete temporary[room.name];
    changed = true;
  }

  if (changed) {
    runtime.powerBankDangerRevision = (runtime.powerBankDangerRevision ?? 0) + 1;
  }
}

function trimTickMap(map: Record<string, number>, limit: number): void {
  const entries = Object.entries(map);
  if (entries.length <= limit) return;
  entries.sort((left, right) => right[1] - left[1]);
  for (const [roomName] of entries.slice(limit)) delete map[roomName];
}

function getVisibilityAge(state: PowerBankObserverState, roomName: string): number {
  const lastSeen = state.lastVisibleAt[roomName];
  return lastSeen === undefined ? Infinity : Math.max(0, Game.time - lastSeen);
}

/**
 * First half of the vision phase: consume only Room objects that exist in this
 * tick, confirm previous Observer intents, record visible Banks, and refresh
 * route-risk evidence once before any mission consumes it.
 */
export function runPowerBankObserverIntake(): void {
  const state = getState();
  for (const [roomName, request] of Object.entries(state.pending)) {
    if (Game.rooms[roomName]) {
      state.lastObserverVisibleAt[roomName] = Game.time;
      state.lastVisibleAt[roomName] = Game.time;
      delete state.pending[roomName];
      delete state.failures[roomName];
    } else if (Game.time > request.requestedAt) {
      const previous = state.failures[roomName]?.count ?? 0;
      const count = Math.min(5, previous + 1);
      state.failures[roomName] = {
        count,
        nextAttemptAt: Game.time + Math.min(8, 2 ** (count - 1)),
        reason: "observe_result_missing",
      };
      delete state.pending[roomName];
    }
  }

  const visibleRooms = Object.values(Game.rooms);
  for (const room of visibleRooms) {
    state.lastVisibleAt[room.name] = Game.time;
    updateTransitRisk(room);
    const banks = room.find(FIND_STRUCTURES).filter(
      (structure): structure is StructurePowerBank => structure.structureType === STRUCTURE_POWER_BANK,
    );
    for (const bank of banks) recordPowerBankDiscovery(bank);
  }
  trimTickMap(state.lastVisibleAt, 256);
  trimTickMap(state.lastObserverVisibleAt, 256);
  const failures = Object.entries(state.failures);
  if (failures.length > 256) {
    failures.sort((left, right) => right[1].nextAttemptAt - left[1].nextAttemptAt);
    for (const [roomName] of failures.slice(256)) delete state.failures[roomName];
  }
}

function getActiveObservers(): StructureObserver[] {
  const result: StructureObserver[] = [];
  for (const room of getTickContextService().getMyRooms()) {
    const context = getTickContextService().getRoomContext(room);
    const structures = context?.getMyStructures() ?? room.find(FIND_MY_STRUCTURES);
    for (const structure of structures) {
      if (
        structure.structureType === STRUCTURE_OBSERVER &&
        (typeof structure.isActive !== "function" || structure.isActive())
      ) result.push(structure as StructureObserver);
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function getObserverRange(): number {
  const configured = (globalThis as typeof globalThis & { OBSERVER_RANGE?: number }).OBSERVER_RANGE;
  return Number.isFinite(configured) && (configured as number) > 0 ? configured as number : 10;
}

function canObserve(observer: StructureObserver, roomName: string): boolean {
  if (!isNormalRoom(roomName)) return false;
  try {
    return Game.map.getRoomLinearDistance(observer.room.name, roomName) <= getObserverRange();
  } catch {
    return false;
  }
}

function isNormalRoom(roomName: string): boolean {
  if (!Game.map || typeof Game.map.getRoomStatus !== "function") return true;
  try {
    return Game.map.getRoomStatus(roomName)?.status === "normal";
  } catch {
    return false;
  }
}

function addRequest(requests: Map<string, VisionRequest>, request: VisionRequest): void {
  if (!request.roomName || !isNormalRoom(request.roomName)) return;
  const existing = requests.get(request.roomName);
  if (!existing) {
    requests.set(request.roomName, request);
    return;
  }
  existing.priority = Math.max(existing.priority, request.priority);
  existing.refreshTicks = Math.min(existing.refreshTicks, request.refreshTicks);
  existing.deadline = Math.min(existing.deadline, request.deadline);
  existing.continuous ||= request.continuous;
  existing.reason = `${existing.reason},${request.reason}`;
  existing.sourceRoom ??= request.sourceRoom;
}

function buildVisionRequests(state: PowerBankObserverState): VisionRequest[] {
  const requests = new Map<string, VisionRequest>();
  const region = getPowerBankRegion();
  for (const target of region.targets) {
    const lastSeen = state.lastVisibleAt[target.roomName];
    if (lastSeen !== undefined && Game.time - lastSeen < REGION_REFRESH_TICKS) continue;
    addRequest(requests, {
      roomName: target.roomName,
      reason: "powerbank-region-patrol",
      priority: 10,
      refreshTicks: REGION_REFRESH_TICKS,
      deadline: Game.time + REGION_REFRESH_TICKS,
      continuous: false,
      sourceRoom: target.bases[0]?.sourceRoom,
    });
  }

  const bankTasks = Memory.data?.powerBankHarvest ?? {};
  for (const task of Object.values(bankTasks)) {
    if ([POWER_BANK_STATUS.COMPLETE, POWER_BANK_STATUS.FAILED, POWER_BANK_STATUS.ABORTED].includes(task.status as never)) continue;
    for (const roomName of task.planningRooms ?? []) {
      if (Game.rooms[roomName]) continue;
      addRequest(requests, {
        roomName,
        reason: "powerbank-route-risk",
        priority: 85,
        refreshTicks: 1,
        deadline: Game.time + 5,
        continuous: false,
        sourceRoom: task.sourceRoom || undefined,
      });
    }
    const critical = task.status === POWER_BANK_STATUS.TRAVELLING ||
      task.status === POWER_BANK_STATUS.ATTACKING ||
      task.status === POWER_BANK_STATUS.HAULING;
    if (!critical) continue;
    const continuous = task.status === POWER_BANK_STATUS.ATTACKING || task.status === POWER_BANK_STATUS.HAULING;
    addRequest(requests, {
      roomName: task.targetRoom,
      reason: `powerbank-${task.status}`,
      priority: continuous ? 100 : 75,
      refreshTicks: continuous ? 1 : 10,
      deadline: Game.time + (continuous ? 1 : 10),
      continuous,
      sourceRoom: task.sourceRoom || undefined,
    });
  }

  for (const task of Object.values(Memory.data?.remoteMining ?? {})) {
    const activeRemote = task.status === "active";
    const needsPureVision = activeRemote || task.status === "suspended" ||
      (task.status === "defending" && task.defenseReason === "npc_invader_core");
    if (!needsPureVision) continue;
    const lastSeen = state.lastVisibleAt[task.targetRoom];
    const refreshTicks = activeRemote ? 250 : REMOTE_RECHECK_TICKS;
    if (lastSeen !== undefined && Game.time - lastSeen < refreshTicks) continue;
    addRequest(requests, {
      roomName: task.targetRoom,
      reason: activeRemote ? "remote-mining-health-check" : "remote-mining-pure-vision",
      priority: activeRemote ? 35 : 50,
      refreshTicks,
      deadline: Game.time + (activeRemote ? 150 : 20),
      continuous: false,
      sourceRoom: task.sourceRoom,
    });
  }

  const staleRiskRooms = Object.entries(Memory.runtime?.transitDangerRooms ?? {})
    .filter(([, expiresAt]) => expiresAt <= Game.time)
    .map(([roomName]) => roomName)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20);
  for (const roomName of staleRiskRooms) {
    if (getVisibilityAge(state, roomName) < REMOTE_RECHECK_TICKS) continue;
    addRequest(requests, {
      roomName,
      reason: "transit-risk-refresh",
      priority: 20,
      refreshTicks: REMOTE_RECHECK_TICKS,
      deadline: Game.time + 100,
      continuous: false,
    });
  }

  return [...requests.values()]
    .filter((request) => request.continuous || !Game.rooms[request.roomName])
    .filter((request) => !state.pending[request.roomName])
    .filter((request) => (state.failures[request.roomName]?.nextAttemptAt ?? 0) <= Game.time)
    .sort((left, right) => right.priority - left.priority || left.deadline - right.deadline || left.roomName.localeCompare(right.roomName))
    .slice(0, MAX_VISION_REQUESTS);
}

function assignObservations(
  requests: VisionRequest[],
  observers: StructureObserver[],
  state: PowerBankObserverState,
): Set<string> {
  const eligible = requests.map((request) => ({
    request,
    observers: observers.filter((observer) => canObserve(observer, request.roomName)),
  }));
  eligible.sort((left, right) =>
    left.observers.length - right.observers.length ||
    right.request.priority - left.request.priority ||
    left.request.deadline - right.request.deadline ||
    (state.lastVisibleAt[left.request.roomName] ?? -1) - (state.lastVisibleAt[right.request.roomName] ?? -1) ||
    left.request.roomName.localeCompare(right.request.roomName),
  );

  const assigned = new Set<string>();
  const usedObservers = new Set(
    Object.entries(state.submittedByObserver ?? {})
      .filter(([, submittedAt]) => submittedAt === Game.time)
      .map(([observerId]) => observerId),
  );
  const unmet: PowerBankObserverState["unmet"] = [];
  for (const item of eligible) {
    const candidates = item.observers.filter((observer) => !usedObservers.has(observer.id));
    if (candidates.length === 0) {
      unmet.push({
        roomName: item.request.roomName,
        reason: item.observers.length === 0 ? "no_observer_in_range" : "observer_capacity",
        priority: item.request.priority,
        deadline: item.request.deadline,
      });
      continue;
    }
    const observer = candidates[0];
    usedObservers.add(observer.id);
    (state.submittedByObserver ??= {})[observer.id] = Game.time;
    const result = observer.observeRoom(item.request.roomName);
    if (result === OK) {
      assigned.add(item.request.roomName);
      state.pending[item.request.roomName] = {
        requestedAt: Game.time,
        observerId: observer.id,
        priority: item.request.priority,
      };
      state.lastObservedRooms.push(item.request.roomName);
    } else {
      const previous = state.failures[item.request.roomName]?.count ?? 0;
      const count = Math.min(5, previous + 1);
      state.failures[item.request.roomName] = {
        count,
        nextAttemptAt: Game.time + Math.min(8, 2 ** (count - 1)),
        reason: `observeRoom:${result}`,
      };
      unmet.push({
        roomName: item.request.roomName,
        reason: `observeRoom:${result}`,
        priority: item.request.priority,
        deadline: item.request.deadline,
      });
    }
  }
  state.unmet = unmet.sort((left, right) => right.priority - left.priority || left.deadline - right.deadline).slice(0, MAX_VISION_REQUESTS);
  trimTickMap(state.submittedByObserver ?? (state.submittedByObserver = {}), 256);
  return assigned;
}

function getObserversForRoom(observers: StructureObserver[], roomName: string): StructureObserver[] {
  return observers.filter((observer) => canObserve(observer, roomName));
}

function getPowerBankScoutTargets(
  state: PowerBankObserverState,
  observers: StructureObserver[],
  assigned: Set<string>,
): string[] {
  const dueByRoom = new Map<string, { age: number; priority: number }>();
  const addGap = (roomName: string, priority: number): void => {
    if (!roomName || Game.rooms[roomName] || assigned.has(roomName) || state.pending[roomName]) return;
    const age = getVisibilityAge(state, roomName);
    if (getObserversForRoom(observers, roomName).length > 0 && age < 300) {
      const repeatedFailure = (state.failures[roomName]?.count ?? 0) >= 2;
      const overdue = state.unmet.some((item) => item.roomName === roomName && item.deadline <= Game.time);
      if (priority < 80 || (!repeatedFailure && !overdue)) return;
    }
    const old = dueByRoom.get(roomName);
    if (!old || priority > old.priority || age > old.age) dueByRoom.set(roomName, { age, priority });
  };

  for (const target of getPowerBankRegion().targets) addGap(target.roomName, 10);
  for (const task of Object.values(Memory.data?.powerBankHarvest ?? {})) {
    if ([POWER_BANK_STATUS.COMPLETE, POWER_BANK_STATUS.FAILED, POWER_BANK_STATUS.ABORTED].includes(task.status as never)) continue;
    for (const roomName of task.planningRooms ?? []) addGap(roomName, 85);
    if (task.status === POWER_BANK_STATUS.TRAVELLING || task.status === POWER_BANK_STATUS.ATTACKING || task.status === POWER_BANK_STATUS.HAULING) {
      addGap(task.targetRoom, 95);
    }
  }

  const staleRiskRooms = Object.entries(Memory.runtime?.transitDangerRooms ?? {})
    .filter(([, expiresAt]) => expiresAt <= Game.time)
    .map(([roomName]) => roomName)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20);
  for (const roomName of staleRiskRooms) addGap(roomName, 85);

  return [...dueByRoom.entries()]
    .sort((left, right) => right[1].priority - left[1].priority || right[1].age - left[1].age || left[0].localeCompare(right[0]))
    .slice(0, MAX_SCOUT_TARGETS)
    .map(([roomName]) => roomName);
}

function getScoutSourceRoom(targetRooms: string[]): string | undefined {
  const region = getPowerBankRegion();
  const sourceScores = new Map<string, { count: number; distance: number }>();
  const targetSet = new Set(targetRooms);
  for (const roomName of targetRooms) {
    const target = region.targets.find((item) => item.roomName === roomName);
    for (const route of target?.bases ?? []) {
      const score = sourceScores.get(route.sourceRoom) ?? { count: 0, distance: 0 };
      score.count += 1;
      score.distance += route.distance;
      sourceScores.set(route.sourceRoom, score);
    }
  }
  for (const target of region.targets) {
    for (const route of target.bases) {
      const coveredGapCount = targetRooms.filter((roomName) => route.rooms.includes(roomName)).length;
      if (coveredGapCount === 0) continue;
      const score = sourceScores.get(route.sourceRoom) ?? { count: 0, distance: 0 };
      score.count += coveredGapCount;
      score.distance += route.distance;
      sourceScores.set(route.sourceRoom, score);
    }
  }
  for (const task of Object.values(Memory.data?.powerBankHarvest ?? {})) {
    if (!task.sourceRoom || !task.planningRooms?.some((roomName) => targetSet.has(roomName))) continue;
    const score = sourceScores.get(task.sourceRoom) ?? { count: 0, distance: 0 };
    score.count += task.planningRooms.filter((roomName) => targetSet.has(roomName)).length;
    score.distance += task.routeDistance ?? 0;
    sourceScores.set(task.sourceRoom, score);
  }
  return [...sourceScores.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].distance - right[1].distance || left[0].localeCompare(right[0]))[0]?.[0];
}

function removeScoutFromQueues(configName: string, removeQueued: boolean): boolean {
  let spawning = false;
  for (const room of getTickContextService().getMyRooms()) {
    for (const spawn of getTickContextService().getSpawnsByRoom(room.name)) {
      if (removeQueued && spawn.memory.spawnList?.includes(configName)) {
        spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
      }
      if (spawn.spawning && Memory.creeps?.[spawn.spawning.name]?.configName === configName) spawning = true;
    }
  }
  return spawning;
}

function reconcilePowerBankScout(targetRooms: string[], state: PowerBankObserverState): void {
  const service = getCreepConfigService();
  const currentArgs = targetRooms.join("|");
  const config = service.get(POWER_BANK_SCOUT_CONFIG);
  const liveCreeps = getTickContextService().getCreepsByConfigName(POWER_BANK_SCOUT_CONFIG);
  const spawning = removeScoutFromQueues(POWER_BANK_SCOUT_CONFIG, targetRooms.length === 0);

  if (targetRooms.length > 0) {
    const sourceRoom = getScoutSourceRoom(targetRooms);
    if (!sourceRoom) {
      state.scoutTargets = [];
      return;
    }
    const previousArgs = config?.args?.[0] ?? "";
    const previousRoom = config?.roomName;
    if (!config || previousArgs !== currentArgs || previousRoom !== sourceRoom) {
      service.upsert(POWER_BANK_SCOUT_CONFIG, "powerBankScout", [currentArgs], sourceRoom);
    }
    state.scoutTargets = targetRooms;
    state.scoutUpdatedAt = Game.time;
    return;
  }

  if (config && (liveCreeps.length > 0 || spawning)) {
    config.args = [""];
    delete config.roomName;
    state.scoutTargets = [];
    state.scoutUpdatedAt = Game.time;
    return;
  }
  if (config) service.remove(POWER_BANK_SCOUT_CONFIG);
  state.scoutTargets = [];
  state.scoutUpdatedAt = Game.time;
}

function getRemotePureVisionFallbacks(state: PowerBankObserverState, observers: StructureObserver[]): string[] {
  const fallback = new Map<string, { priority: number; age: number }>();
  for (const task of Object.values(Memory.data?.remoteMining ?? {})) {
    const activeRemote = task.status === "active";
    const needsPureVision = activeRemote || task.status === "suspended" ||
      (task.status === "defending" && task.defenseReason === "npc_invader_core");
    if (!needsPureVision || Game.rooms[task.targetRoom]) continue;
    const age = getVisibilityAge(state, task.targetRoom);
    const refreshTicks = activeRemote ? 250 : REMOTE_RECHECK_TICKS;
    if (getObserversForRoom(observers, task.targetRoom).length === 0 || age >= refreshTicks + 20) {
      fallback.set(task.targetRoom, { priority: activeRemote ? 30 : 70, age });
      continue;
    }
    const missed = state.failures[task.targetRoom]?.count ?? 0;
    const overdue = state.unmet.some((item) => item.roomName === task.targetRoom && item.deadline <= Game.time);
    if (missed >= 2 || overdue) fallback.set(task.targetRoom, { priority: activeRemote ? 30 : 70, age });
  }
  return [...fallback.entries()]
    .sort((left, right) => right[1].priority - left[1].priority || right[1].age - left[1].age || left[0].localeCompare(right[0]))
    .slice(0, MAX_REMOTE_SCOUT_FALLBACKS)
    .map(([roomName]) => roomName);
}

/**
 * Second half of the single Observer path. Collect all business demand, assign
 * constrained rooms first, submit at most once per Observer, then reconcile
 * target-level fallback scouts before the same tick's spawn planner.
 */
export function runPowerBankObserver(): void {
  const state = getState();
  const observers = getActiveObservers();
  const region = getPowerBankRegion();
  state.updatedAt = Game.time;
  state.coveredRooms = region.targets
    .filter((target) => observers.some((observer) => canObserve(observer, target.roomName)))
    .map((target) => target.roomName);
  state.lastObservedRooms = [];

  const requests = buildVisionRequests(state);
  const assigned = assignObservations(requests, observers, state);
  const scoutTargets = getPowerBankScoutTargets(state, observers, assigned);
  const scoutItinerary = [...new Set([...(state.scoutTargets ?? []), ...scoutTargets])]
    .filter((roomName) => !Game.rooms[roomName] && !assigned.has(roomName));
  const routeChanged = scoutItinerary.join("|") !== (state.scoutTargets ?? []).join("|");
  if (routeChanged || Game.time - (state.scoutUpdatedAt ?? -Infinity) >= 25) {
    reconcilePowerBankScout(scoutTargets, state);
  }

  state.remoteScoutTargets = getRemotePureVisionFallbacks(state, observers);
  if (Object.keys(state.pending).length > MAX_VISION_REQUESTS) {
    const entries = Object.entries(state.pending).sort((left, right) =>
      right[1].priority - left[1].priority || left[1].requestedAt - right[1].requestedAt,
    );
    for (const [roomName] of entries.slice(MAX_VISION_REQUESTS)) delete state.pending[roomName];
  }
}

export function hasPowerBankObserverCoverage(): boolean {
  const observers = getActiveObservers();
  const targets = getPowerBankRegion().targets;
  return targets.length > 0 && targets.every((target) =>
    observers.some((observer) => canObserve(observer, target.roomName)),
  );
}

export function hasFreshObserverResult(roomName: string, maxAge = 1): boolean {
  const lastSeen = getState().lastObserverVisibleAt[roomName];
  return lastSeen !== undefined && Game.time - lastSeen <= maxAge;
}

export function getPowerBankVisionSnapshot(): PowerBankVisionSnapshot {
  const state = getState();
  return {
    tick: Game.time,
    region: getPowerBankRegion(),
    observers: getActiveObservers().map((observer) => ({ roomName: observer.room.name, id: observer.id })),
    pending: { ...state.pending },
    unmet: [...state.unmet],
    scoutTargets: [...(state.scoutTargets ?? [])],
    remoteScoutTargets: [...(state.remoteScoutTargets ?? [])],
  };
}

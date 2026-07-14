import type { RoleFactory } from "@/types/system";
import {
  getEnergyStoreTarget,
  isDroppedResourceTarget,
} from "@/roles/energyTargets";
import { moveToTarget } from "@/roles/shared";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";
import {
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} from "@/runtime/energyPickupReservation";
import { listCarrierTasksByRoom, type CarrierTask, type CarrierTaskStep } from "@/runtime/carrierTaskBoard";
import { hasSharedStorageControllerLinkCluster, isStorageReceiverLink } from "@/runtime/linkControl";
import { getPlannedStoragePos, getPlannedControllerLinkPos, getProtoStorageContainer, getProtoControllerLinkContainer } from "@/runtime/roomPlannerConstruction";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { isPositionAllowedForCreep, shouldRestrictToSafeZone } from "@/runtime/safeZoneHelpers";

type CarrierPickupTarget = Resource | StructureContainer | StructureLink | StructureStorage | StructureTerminal | Tombstone | Ruin;
type DeadStorePickupTarget = Tombstone | Ruin;
type DeadStorePickupAssignment = { target: DeadStorePickupTarget; resource: ResourceConstant };
type CarrierTaskFilter = (task: CarrierTask) => boolean;

const POWER_BANK_BOOST_PRODUCER_PREFIX = "powerBankBoost:";

interface CarrierPickupOptions {
  includeStorage?: boolean;
  includeProtoStorage?: boolean;
  includeTerminal?: boolean;
}

const DEFAULT_TERMINAL_PICKUP_ROOMS: Record<string, boolean> = {};

function isTerminalPickupEnabledForRoom(roomName: string): boolean {
  const configRooms = Memory.cfg?.energyPickup?.terminalPickupRooms;
  if (configRooms && roomName in configRooms) {
    return !!configRooms[roomName];
  }
  return !!DEFAULT_TERMINAL_PICKUP_ROOMS[roomName];
}

function getCarrierPickupAmount(target: CarrierPickupTarget): number {
  return getPickupTargetEnergyAmount(target);
}

function getStoredResources(store: StoreDefinition): ResourceConstant[] {
  return (Object.keys(store) as ResourceConstant[]).filter((resource) => store.getUsedCapacity(resource) > 0);
}

function getBestStoredResource(target: DeadStorePickupTarget): ResourceConstant | null {
  const resources = getStoredResources(target.store);
  if (resources.length === 0) {
    return null;
  }

  return resources.sort((left, right) => target.store.getUsedCapacity(right) - target.store.getUsedCapacity(left))[0];
}

function isTombstonePickupTarget(target: Resource | AnyStoreStructure | Tombstone | Ruin): target is Tombstone {
  return (target as Tombstone).deathTime !== undefined;
}

function isControllerAdjacentLink(link: StructureLink): boolean {
  if (hasSharedStorageControllerLinkCluster(link.room)) {
    return false;
  }

  const controllerPos = link.room.controller?.pos;
  return !!controllerPos && link.pos.getRangeTo(controllerPos) <= 2;
}

function isDroppedAtPlannedStoragePos(resource: Resource): boolean {
  const room = resource.room;
  if (room.storage) return false;
  const plannedPos = getPlannedStoragePos(room);
  return !!plannedPos && resource.pos.isEqualTo(plannedPos);
}

function isProtoStorageContainer(structure: StructureContainer): boolean {
  const plannedPos = getPlannedStoragePos(structure.room);
  return !!plannedPos && structure.pos.isEqualTo(plannedPos);
}

function isProtoControllerLinkContainer(structure: StructureContainer): boolean {
  const plannedPos = getPlannedControllerLinkPos(structure.room);
  return !!plannedPos && structure.pos.isEqualTo(plannedPos);
}

function hasConstructionSiteAt(pos: RoomPosition): boolean {
  return pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0;
}

function deliverToPlannedStoragePosition(creep: Creep): boolean {
  const assignedRoom = getAssignedCarrierRoom(creep);
  if (!assignedRoom) {
    return false;
  }

  const plannedPos = getPlannedStoragePos(assignedRoom);
  if (!plannedPos || hasConstructionSiteAt(plannedPos)) {
    return false;
  }

  if (!creep.pos.isEqualTo(plannedPos)) {
    moveToTarget(creep, plannedPos, 0);
    return true;
  }

  const dropCode = measureCreepIntent(() => creep.drop(RESOURCE_ENERGY));
  return dropCode === OK || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
}

function getWeightedCarrierPickupCandidates(creep: Creep, options?: CarrierPickupOptions): CarrierPickupTarget[] {
  return measureCreepDecision(() => {
    const roomContext = getTickContextService().getRoomContext(creep.room);
    const dropped = (roomContext?.getDroppedEnergyResources() || []).filter(r => !isDroppedAtPlannedStoragePos(r));
    const allStructures = roomContext?.getStructures() || [];
    const structures = allStructures.filter(
      (structure): structure is StructureContainer | StructureLink =>
        ((structure.structureType === STRUCTURE_CONTAINER &&
            (options?.includeProtoStorage || !isProtoStorageContainer(structure as StructureContainer)) &&
            !isProtoControllerLinkContainer(structure as StructureContainer)) ||
          (structure.structureType === STRUCTURE_LINK &&
            isStorageReceiverLink(structure as StructureLink) &&
            !isControllerAdjacentLink(structure as StructureLink))) &&
        (structure as AnyStoreStructure).store.getUsedCapacity(RESOURCE_ENERGY) > 0,
    );
    const tombstones = roomContext?.getEnergyTombstones() || [];
    const ruins = roomContext?.getEnergyRuins() || [];
    const storage =
      options?.includeStorage && creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        ? [creep.room.storage]
        : [];
    const terminal =
      options?.includeTerminal && creep.room.terminal && creep.room.terminal.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        ? [creep.room.terminal]
        : [];

    const candidates: CarrierPickupTarget[] = [...dropped, ...structures, ...tombstones, ...ruins, ...storage, ...terminal];
    if (candidates.length === 0) {
      return [];
    }

    const filteredCandidates = shouldRestrictToSafeZone(creep)
      ? candidates.filter((candidate) => isPositionAllowedForCreep(creep, candidate.pos))
      : candidates;

    if (filteredCandidates.length === 0) {
      return [];
    }

    return filteredCandidates
      .map((candidate) => {
        const amount = getCarrierPickupAmount(candidate);
        const distance = Math.max(1, creep.pos.getRangeTo(candidate.pos));
        return {
          candidate,
          amount,
          score: amount / distance,
        };
      })
      .filter((entry) => entry.amount > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.candidate);
  });
}

function isCarrierPickupTarget(
  target: Resource | AnyStoreStructure | Tombstone | Ruin,
  options?: CarrierPickupOptions,
): target is CarrierPickupTarget {
  if (isDroppedResourceTarget(target)) {
    return !isDroppedAtPlannedStoragePos(target);
  }

  if ((target as Tombstone).deathTime !== undefined) {
    return true;
  }

  if ((target as Ruin).ticksToDecay !== undefined) {
    return true;
  }

  const structureType = (target as Structure).structureType;
  if (options?.includeStorage && structureType === STRUCTURE_STORAGE) {
    return true;
  }

  if (options?.includeTerminal && structureType === STRUCTURE_TERMINAL) {
    return true;
  }

  if (structureType === STRUCTURE_CONTAINER) {
    return (options?.includeProtoStorage || !isProtoStorageContainer(target as StructureContainer)) &&
      !isProtoControllerLinkContainer(target as StructureContainer);
  }

  if (structureType === STRUCTURE_LINK) {
    const link = target as StructureLink;
    return isStorageReceiverLink(link) && !isControllerAdjacentLink(link);
  }

  return false;
}

function pickupEnergyForCarrier(creep: Creep, options?: CarrierPickupOptions): { picked: boolean; outOfRange: boolean } {
  const desiredAmount = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;

  let sourceTarget = getReservedPickupTarget(creep);
  if (sourceTarget && !isCarrierPickupTarget(sourceTarget, options)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (sourceTarget && shouldRestrictToSafeZone(creep) && !isPositionAllowedForCreep(creep, sourceTarget.pos)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (sourceTarget && !reservePickupTarget(creep, sourceTarget, desiredAmount)) {
    releasePickupReservation(creep, sourceTarget.id);
    sourceTarget = null;
  }

  if (!sourceTarget) {
    const candidates = getWeightedCarrierPickupCandidates(creep, options);
    for (const candidate of candidates) {
      if (reservePickupTarget(creep, candidate, desiredAmount)) {
        sourceTarget = candidate;
        break;
      }
    }
  }

  if (!sourceTarget) {
    return { picked: false, outOfRange: false };
  }

  if (isDroppedResourceTarget(sourceTarget)) {
    const pickupCode = measureCreepIntent(() => creep.pickup(sourceTarget));
    if (pickupCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
      return { picked: false, outOfRange: true };
    }

    if (pickupCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    return { picked: pickupCode === OK, outOfRange: false };
  }

  if (isTombstonePickupTarget(sourceTarget)) {
    const withdrawCode = measureCreepIntent(() => creep.withdraw(sourceTarget, RESOURCE_ENERGY));
    if (withdrawCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, sourceTarget);
      return { picked: false, outOfRange: true };
    }

    if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
      releasePickupReservation(creep, sourceTarget.id);
      return { picked: false, outOfRange: false };
    }

    return { picked: withdrawCode === OK, outOfRange: false };
  }

  const withdrawCode = measureCreepIntent(() => creep.withdraw(sourceTarget, RESOURCE_ENERGY));
  if (withdrawCode === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, sourceTarget);
    return { picked: false, outOfRange: true };
  }

  if (withdrawCode === ERR_NOT_ENOUGH_RESOURCES || withdrawCode === ERR_INVALID_TARGET) {
    releasePickupReservation(creep, sourceTarget.id);
    return { picked: false, outOfRange: false };
  }

  return { picked: withdrawCode === OK, outOfRange: false };
}

function isSpawnOrExtensionTarget(target: AnyStoreStructure | null): boolean {
  return !!target && (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION);
}

function setPostTransferPlan(
  creep: Creep,
  mode: "pickup" | "deliver",
  target: Resource | AnyStoreStructure | Tombstone | Ruin,
): void {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  assignmentState.carrierPlanMode = mode;
  assignmentState.carrierPlanTargetId = target.id;
  assignmentState.carrierPlanTargetKind = isDroppedResourceTarget(target)
    ? "resource"
    : "structure";
}

function clearPostTransferPlan(creep: Creep): void {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  delete assignmentState.carrierPlanMode;
  delete assignmentState.carrierPlanTargetId;
  delete assignmentState.carrierPlanTargetKind;
}

function getPlannedTarget(creep: Creep): Resource | AnyStoreStructure | Tombstone | Ruin | null {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  if (!assignmentState.carrierPlanTargetId || !assignmentState.carrierPlanTargetKind) {
    return null;
  }

  if (assignmentState.carrierPlanTargetKind === "resource") {
    return Game.getObjectById(assignmentState.carrierPlanTargetId as Id<Resource>);
  }

  return Game.getObjectById(assignmentState.carrierPlanTargetId as Id<AnyStoreStructure | Tombstone | Ruin>);
}

function getPlannedDeliveryTarget(creep: Creep): AnyStoreStructure | null {
  if (ensureCreepAssignmentState(creep.name).carrierPlanMode !== "deliver") {
    return null;
  }

  const plannedTarget = getPlannedTarget(creep);
  if (!plannedTarget) {
    clearPostTransferPlan(creep);
    return null;
  }

  if (isDroppedResourceTarget(plannedTarget) || isTombstonePickupTarget(plannedTarget) || (plannedTarget as Ruin).ticksToDecay !== undefined) {
    clearPostTransferPlan(creep);
    return null;
  }

  const structureTarget = plannedTarget as AnyStoreStructure;
  if (structureTarget.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
    clearPostTransferPlan(creep);
    return null;
  }

  return structureTarget;
}

function hasNewerLiveReplacement(creep: Creep): boolean {
  const configName = creep.memory.configName;
  if (!configName) {
    return false;
  }

  return getTickContextService().getCreepsByConfigName(configName).some(
    (candidate) =>
      candidate.name !== creep.name &&
      candidate.memory.configName === configName &&
      candidate.ticksToLive > creep.ticksToLive,
  );
}

function getAssignedCarrierRoomName(creep: Creep): string {
  const configName = creep.memory.configName;
  if (!configName) {
    return creep.room.name;
  }

  return getCreepConfigService().get(configName)?.roomName || creep.room.name;
}

function getAssignedCarrierRoom(creep: Creep): Room | null {
  const assignedRoomName = getAssignedCarrierRoomName(creep);
  return Game.rooms[assignedRoomName] || (creep.room.name === assignedRoomName ? creep.room : null);
}

function getSynthesisCarrierTasks(roomName: string): CarrierTask[] {
  return listCarrierTasksByRoom(roomName);
}

function clearSynthesisCarrierTaskPlan(creep: Creep): void {
  const state = ensureCreepAssignmentState(creep.name);
  delete state.synthesisCarrierTaskId;
  delete state.synthesisCarrierPendingPickupTick;
  delete state.synthesisCarrierPendingStepId;
  delete state.synthesisCarrierPendingDeliveryTick;
  delete state.synthesisCarrierPendingFromId;
  delete state.synthesisCarrierPendingToId;
  delete state.synthesisCarrierPendingResource;
}

function getAssignedSynthesisCarrierTask(creep: Creep): CarrierTask | null {
  const taskId = ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId;
  if (!taskId) {
    return null;
  }

  return getSynthesisCarrierTasks(getAssignedCarrierRoomName(creep)).find((item) => item.id === taskId) || null;
}

// Per-tick memoization: Screeps object IDs resolve against the tick snapshot,
// so same-tick caching is safe. Reset by Game.time so destroyed structures
// refresh next tick. Avoids redundant Game.getObjectById calls from multiple
// callers (runnable checks, pickup/delivery selection, assignment, fallbacks).
let taskStructureCacheTick: number | null = null;
const taskStructureCache = new Map<string, AnyStoreStructure | null>();

function resolveTaskStructure(id: string): AnyStoreStructure | null {
  if (taskStructureCacheTick !== Game.time) {
    taskStructureCache.clear();
    taskStructureCacheTick = Game.time;
  }
  if (taskStructureCache.has(id)) {
    return taskStructureCache.get(id) ?? null;
  }
  const resolved = Game.getObjectById(id as Id<AnyStoreStructure>) || null;
  taskStructureCache.set(id, resolved);
  return resolved;
}

function isCarrierTaskStepRunnable(step: CarrierTaskStep): boolean {
  const from = resolveTaskStructure(step.fromId);
  const to = resolveTaskStructure(step.toId);
  if (!from || !to) {
    return false;
  }
  if (from.store.getUsedCapacity(step.resource) <= 0) {
    return false;
  }
  if (to.store.getFreeCapacity(step.resource) <= 0) {
    return false;
  }
  return true;
}

function selectPickupStep(task: CarrierTask, creep: Creep): CarrierTaskStep | null {
  const candidates = task.steps
    .filter((step) => isCarrierTaskStepRunnable(step))
    .sort((left, right) => {
      const leftFrom = resolveTaskStructure(left.fromId);
      const rightFrom = resolveTaskStructure(right.fromId);
      const leftRange = leftFrom ? creep.pos.getRangeTo(leftFrom.pos) : 99;
      const rightRange = rightFrom ? creep.pos.getRangeTo(rightFrom.pos) : 99;
      return leftRange - rightRange;
    });
  return candidates.length > 0 ? candidates[0] : null;
}

function selectDeliveryStep(task: CarrierTask, creep: Creep): CarrierTaskStep | null {
  const candidates = task.steps
    .filter((step) => creep.store.getUsedCapacity(step.resource) > 0)
    .filter((step) => {
      const to = resolveTaskStructure(step.toId);
      return !!to && to.store.getFreeCapacity(step.resource) > 0;
    })
    .sort((left, right) => {
      const leftTo = resolveTaskStructure(left.toId);
      const rightTo = resolveTaskStructure(right.toId);
      const leftRange = leftTo ? creep.pos.getRangeTo(leftTo.pos) : 99;
      const rightRange = rightTo ? creep.pos.getRangeTo(rightTo.pos) : 99;
      return leftRange - rightRange;
    });
  return candidates.length > 0 ? candidates[0] : null;
}

function isCarrierTaskRunnable(task: CarrierTask): boolean {
  return task.steps.some((step) => isCarrierTaskStepRunnable(step));
}

function isPowerBankBoostCarrierTask(task: CarrierTask): boolean {
  return task.producer.startsWith(POWER_BANK_BOOST_PRODUCER_PREFIX);
}

function hasRunnablePowerBankBoostCarrierTask(roomName: string): boolean {
  return getSynthesisCarrierTasks(roomName).some((task) => isPowerBankBoostCarrierTask(task) && isCarrierTaskRunnable(task));
}

function isUrgentLabCleanupCarrierTask(task: CarrierTask): boolean {
  return task.type === "lab_cleanup" || task.type === "lab_product_unload";
}

function hasRunnableUrgentLabCleanupCarrierTask(roomName: string): boolean {
  return getSynthesisCarrierTasks(roomName).some((task) => isUrgentLabCleanupCarrierTask(task) && isCarrierTaskRunnable(task));
}

function assignSynthesisCarrierTask(
  creep: Creep,
  taskFilter?: CarrierTaskFilter,
  clearWhenNoCandidate = true,
): { task: CarrierTask; step: CarrierTaskStep } | null {
  return measureCreepDecision(() => {
    const assigned = getAssignedSynthesisCarrierTask(creep);
    if (assigned && (!taskFilter || taskFilter(assigned))) {
      const assignedStep = selectPickupStep(assigned, creep);
      if (assignedStep) {
        return { task: assigned, step: assignedStep };
      }
    }

    const candidates = getSynthesisCarrierTasks(getAssignedCarrierRoomName(creep))
      .filter((task) => !taskFilter || taskFilter(task))
      .filter((task) => isCarrierTaskRunnable(task))
      .map((task) => ({
        task,
        step: selectPickupStep(task, creep),
      }))
      .filter((entry): entry is { task: CarrierTask; step: CarrierTaskStep } => !!entry.step)
      .sort((left, right) => {
        if (left.task.priority !== right.task.priority) {
          return right.task.priority - left.task.priority;
        }
        const leftFrom = resolveTaskStructure(left.step.fromId);
        const rightFrom = resolveTaskStructure(right.step.fromId);
        const leftRange = leftFrom ? creep.pos.getRangeTo(leftFrom.pos) : 99;
        const rightRange = rightFrom ? creep.pos.getRangeTo(rightFrom.pos) : 99;
        return leftRange - rightRange;
    });

    if (candidates.length <= 0) {
      if (clearWhenNoCandidate) {
        clearSynthesisCarrierTaskPlan(creep);
      }
      return null;
    }

    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = candidates[0].task.id;
    return candidates[0];
  });
}

function pickupSynthesisCarrierResource(
  creep: Creep,
  taskFilter?: CarrierTaskFilter,
  clearWhenNoCandidate = true,
): { picked: boolean; outOfRange: boolean } {
  if (creep.store.getUsedCapacity() > 0) {
    return { picked: false, outOfRange: false };
  }

  const assignment = assignSynthesisCarrierTask(creep, taskFilter, clearWhenNoCandidate);
  if (!assignment) {
    return { picked: false, outOfRange: false };
  }

  const from = resolveTaskStructure(assignment.step.fromId);
  if (!from || from.store.getUsedCapacity(assignment.step.resource) <= 0) {
    clearSynthesisCarrierTaskPlan(creep);
    return { picked: false, outOfRange: false };
  }

  const freeCapacity = creep.store.getFreeCapacity(assignment.step.resource);
  const sourceAvailable = from.store.getUsedCapacity(assignment.step.resource);
  const withdrawAmount = Math.min(assignment.step.amount, freeCapacity, sourceAvailable);
  if (withdrawAmount <= 0) {
    return { picked: false, outOfRange: false };
  }

  const code = measureCreepIntent(() => creep.withdraw(from, assignment.step.resource, withdrawAmount));
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, from);
    return { picked: false, outOfRange: true };
  }
  if (code !== OK) {
    clearSynthesisCarrierTaskPlan(creep);
    return { picked: false, outOfRange: false };
  }

  // Record the accepted intent — store mutation happens next tick in live Screeps
  const state = ensureCreepAssignmentState(creep.name);
  state.synthesisCarrierPendingPickupTick = Game.time;
  state.synthesisCarrierPendingStepId = assignment.step.id;
  state.synthesisCarrierPendingFromId = assignment.step.fromId;
  state.synthesisCarrierPendingToId = assignment.step.toId;
  state.synthesisCarrierPendingResource = assignment.step.resource;
  return {
    picked: true,
    outOfRange: false,
  };
}

function pickupOwnedRoomDeadStoreResource(creep: Creep): { picked: boolean; outOfRange: boolean } {
  if (!creep.room.controller?.my || creep.store.getUsedCapacity() > 0) {
    return { picked: false, outOfRange: false };
  }

  const assignment = measureCreepDecision((): DeadStorePickupAssignment | null => {
    const roomContext = getTickContextService().getRoomContext(creep.room);
    const tombstones = (roomContext?.room.find(FIND_TOMBSTONES, {
      filter: (tombstone) => tombstone.store.getUsedCapacity() > 0,
    }) || []) as Tombstone[];
    const ruins = (roomContext?.room.find(FIND_RUINS, {
      filter: (ruin) => ruin.store.getUsedCapacity() > 0,
    }) || []) as Ruin[];

    const candidates = [...tombstones, ...ruins]
      .map((target) => ({ target, resource: getBestStoredResource(target) }))
      .filter((entry): entry is DeadStorePickupAssignment => !!entry.resource)
      .sort((left, right) => creep.pos.getRangeTo(left.target.pos) - creep.pos.getRangeTo(right.target.pos));

    return candidates[0] || null;
  });

  if (!assignment) {
    return { picked: false, outOfRange: false };
  }

  const code = measureCreepIntent(() => creep.withdraw(assignment.target, assignment.resource));
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, assignment.target);
    return { picked: false, outOfRange: true };
  }

  return { picked: code === OK, outOfRange: false };
}

function getFirstNonEnergyResource(creep: Creep): ResourceConstant | null {
  for (const resource of Object.keys(creep.store) as ResourceConstant[]) {
    if (resource === RESOURCE_ENERGY) {
      continue;
    }
    if (creep.store.getUsedCapacity(resource) > 0) {
      return resource;
    }
  }

  return null;
}

function getSynthesisCleanupDeliveryTarget(creep: Creep, resource: ResourceConstant): AnyStoreStructure | null {
  const assignedRoom = getAssignedCarrierRoom(creep);
  if (assignedRoom?.terminal && assignedRoom.terminal.store.getFreeCapacity(resource) > 0) {
    return assignedRoom.terminal;
  }
  if (assignedRoom?.storage && assignedRoom.storage.store.getFreeCapacity(resource) > 0) {
    return assignedRoom.storage;
  }

  return null;
}

function deliverSynthesisCarrierResource(creep: Creep): boolean {
  const assigned = getAssignedSynthesisCarrierTask(creep);
  const state = ensureCreepAssignmentState(creep.name);

  // committed-delivery guard: snapshot delivery before pendingStepId expiry gates
  const _cdToId = state.synthesisCarrierPendingToId;
  const _cdResource = state.synthesisCarrierPendingResource;
  if (_cdToId && _cdResource && creep.store.getUsedCapacity(_cdResource) > 0) {
    const _cdTarget = resolveTaskStructure(_cdToId);
    if (_cdTarget && _cdTarget.store.getFreeCapacity(_cdResource) > 0) {
      const _cdCode = measureCreepIntent(() => creep.transfer(_cdTarget, _cdResource));
      if (_cdCode === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, _cdTarget);
        return true;
      }
      if (_cdCode === OK) {
        clearSynthesisCarrierTaskPlan(creep);
        return true;
      }
      if (_cdCode === ERR_NOT_ENOUGH_RESOURCES) {
        moveToTarget(creep, _cdTarget);
        return true;
      }
    }
    delete state.synthesisCarrierPendingFromId;
    delete state.synthesisCarrierPendingToId;
    delete state.synthesisCarrierPendingResource;
  }

  const explicitPendingStepId = (state.synthesisCarrierPendingPickupTick != null &&
    state.synthesisCarrierPendingPickupTick >= Game.time - 1)
    ? state.synthesisCarrierPendingStepId : undefined;
  const pendingStepId = explicitPendingStepId ||
    (assigned && creep.store.getUsedCapacity() === 0 &&
     state.synthesisCarrierPendingDeliveryTick !== Game.time - 1
     ? assigned.steps[0]?.id : undefined);

  if (pendingStepId) {
    const step = assigned?.steps.find(s => s.id === pendingStepId);
    const target = step ? resolveTaskStructure(step.toId) : null;
    if (step && target) {
      if (creep.store.getUsedCapacity() === 0) {
        moveToTarget(creep, target);
        state.synthesisCarrierPendingDeliveryTick = Game.time;
        return true;
      }
      const code = measureCreepIntent(() => creep.transfer(target, step.resource));
      if (code === ERR_NOT_IN_RANGE) {
        moveToTarget(creep, target);
        return true;
      }
      if (code === OK) {
        delete state.synthesisCarrierPendingPickupTick;
        delete state.synthesisCarrierPendingStepId;
        if (creep.store.getUsedCapacity() === 0) {
          clearSynthesisCarrierTaskPlan(creep);
        } else {
          state.synthesisCarrierPendingDeliveryTick = Game.time;
        }
        return true;
      }
      if (code === ERR_NOT_ENOUGH_RESOURCES) {
        moveToTarget(creep, target);
        return true;
      }
      delete state.synthesisCarrierPendingPickupTick;
      delete state.synthesisCarrierPendingStepId;
    } else {
      // Board was refreshed and the original task/step is gone.
      // Fall back to snapshot fields captured at pickup time.
      const snapshotToId = state.synthesisCarrierPendingToId;
      const snapshotResource = state.synthesisCarrierPendingResource;
      if (snapshotToId && snapshotResource) {
        const snapshotTarget = resolveTaskStructure(snapshotToId);
        if (!snapshotTarget) {
          delete state.synthesisCarrierPendingToId;
          delete state.synthesisCarrierPendingResource;
        } else if (creep.store.getUsedCapacity(snapshotResource) > 0) {
          const code = measureCreepIntent(() => creep.transfer(snapshotTarget, snapshotResource));
          if (code === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, snapshotTarget);
            return true;
          }
          if (code === OK) {
            delete state.synthesisCarrierPendingPickupTick;
            delete state.synthesisCarrierPendingStepId;
            delete state.synthesisCarrierPendingFromId;
            delete state.synthesisCarrierPendingToId;
            delete state.synthesisCarrierPendingResource;
            if (creep.store.getUsedCapacity() === 0) {
              clearSynthesisCarrierTaskPlan(creep);
            } else {
              state.synthesisCarrierPendingDeliveryTick = Game.time;
            }
            return true;
          }
          if (code === ERR_NOT_ENOUGH_RESOURCES) {
            moveToTarget(creep, snapshotTarget);
            return true;
          }
        }
      }
      delete state.synthesisCarrierPendingPickupTick;
      delete state.synthesisCarrierPendingStepId;
    }
  }

  // terminal_offload task-bound delivery: keep carrier bound to the assigned
  // storage target even when selectDeliveryStep returns null (storage full) —
  // prevents fall-through to generic getEnergyStoreTarget which would route
  // energy toward spawn/extension/tower.
  if (assigned?.type === "terminal_offload") {
    const offloadStep = assigned.steps.find(
      (step) => creep.store.getUsedCapacity(step.resource) > 0,
    );
    if (offloadStep) {
      const offloadTarget = resolveTaskStructure(offloadStep.toId);
      if (offloadTarget) {
        const code = measureCreepIntent(() =>
          creep.transfer(offloadTarget, offloadStep.resource),
        );
        if (code === ERR_NOT_IN_RANGE) {
          moveToTarget(creep, offloadTarget);
          return true;
        }
        if (code === OK) {
          const dState = ensureCreepAssignmentState(creep.name);
          if (creep.store.getUsedCapacity() === 0) {
            clearSynthesisCarrierTaskPlan(creep);
          } else {
            dState.synthesisCarrierPendingDeliveryTick = Game.time;
          }
          return true;
        }
        // ERR_FULL, ERR_INVALID_TARGET, etc — stay bound, retry next tick
        return true;
      }
    }
    // Empty-store fallback: carrier called target() during mount re-entry
    // before withdraw intent has mutated store. Use first step's toId as
    // movement target to prevent task clear and source-side movement.
    if (creep.store.getUsedCapacity() === 0 && assigned.steps.length > 0) {
      const fallbackStep = assigned.steps[0];
      const fallbackTarget = resolveTaskStructure(fallbackStep.toId);
      if (fallbackTarget) {
        moveToTarget(creep, fallbackTarget);
        return true;
      }
    }
    // No matching step (nothing to deliver) or target destroyed — clear task
    clearSynthesisCarrierTaskPlan(creep);
    return false;
  }

  const assignedStep = measureCreepDecision(() => (assigned ? selectDeliveryStep(assigned, creep) : null));
  const assignedResource = assignedStep?.resource;
  const fallbackResource = getFirstNonEnergyResource(creep);
  const resource = assignedResource || fallbackResource;
  if (!resource) {
    clearSynthesisCarrierTaskPlan(creep);
    return false;
  }

  const assignedTarget = assignedStep ? resolveTaskStructure(assignedStep.toId) : null;
  const target = assignedTarget && assignedTarget.store.getFreeCapacity(resource) > 0
    ? assignedTarget
    : assignedResource
      ? null
      : getSynthesisCleanupDeliveryTarget(creep, resource);
  if (!target) {
    clearSynthesisCarrierTaskPlan(creep);
    return false;
  }

  const code = measureCreepIntent(() => creep.transfer(target, resource));
  if (code === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, target);
    return true;
  }
  if (code !== OK) {
    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  }

  const dState = ensureCreepAssignmentState(creep.name);
  if (creep.store.getUsedCapacity() === 0) {
    clearSynthesisCarrierTaskPlan(creep);
  } else {
    dState.synthesisCarrierPendingDeliveryTick = Game.time;
  }
  return true;
}

export const carrierRole: RoleFactory = () => ({
  source: (creep): boolean => {
    clearPostTransferPlan(creep);

    const deliveryState = ensureCreepAssignmentState(creep.name);
    if (deliveryState.synthesisCarrierPendingDeliveryTick === Game.time - 1) {
      delete deliveryState.synthesisCarrierPendingDeliveryTick;
      if (creep.store.getUsedCapacity() === 0) {
        clearSynthesisCarrierTaskPlan(creep);
      }
    }

    if (creep.store.getUsedCapacity() > 0) {
      releasePickupReservation(creep);
      return true;
    }

    const assignedRoomName = getAssignedCarrierRoomName(creep);
    if (hasRunnablePowerBankBoostCarrierTask(assignedRoomName)) {
      const powerBankBoostPickup = pickupSynthesisCarrierResource(creep, isPowerBankBoostCarrierTask, false);
      if (powerBankBoostPickup.picked || powerBankBoostPickup.outOfRange) {
        delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
        if (powerBankBoostPickup.picked) {
          releasePickupReservation(creep);
        }
        return creep.store.getUsedCapacity() > 0 ||
          ensureCreepAssignmentState(creep.name).synthesisCarrierPendingPickupTick === Game.time;
      }
    }

    if (hasRunnableUrgentLabCleanupCarrierTask(assignedRoomName)) {
      const urgentLabCleanupPickup = pickupSynthesisCarrierResource(creep, isUrgentLabCleanupCarrierTask, false);
      if (urgentLabCleanupPickup.picked || urgentLabCleanupPickup.outOfRange) {
        delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
        if (urgentLabCleanupPickup.picked) {
          releasePickupReservation(creep);
        }
        return creep.store.getUsedCapacity() > 0 ||
          ensureCreepAssignmentState(creep.name).synthesisCarrierPendingPickupTick === Game.time;
      }
    }

    const energyDemandTarget = getEnergyStoreTarget(creep, {
      includeTerminal: false,
      includeStorage: false,
      roomName: assignedRoomName,
    });

    if (energyDemandTarget) {
      delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
      const isSupplyingSpawnOrExtension = isSpawnOrExtensionTarget(energyDemandTarget);

      if (creep.store.getUsedCapacity() === 0 && hasNewerLiveReplacement(creep) &&
          (getAssignedCarrierRoom(creep)?.controller?.level ?? 0) > 2) {
        releasePickupReservation(creep);
        clearSynthesisCarrierTaskPlan(creep);
        creep.suicide();
        return false;
      }

      pickupEnergyForCarrier(creep, {
        includeStorage: isSupplyingSpawnOrExtension,
        includeProtoStorage: isSupplyingSpawnOrExtension,
        includeTerminal: isTerminalPickupEnabledForRoom(assignedRoomName),
      });
      const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
      if (hasEnergy) {
        releasePickupReservation(creep);
      }
      return hasEnergy;
    }

    const hadExistingTask = !!ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId;
    const hadPendingPickup = ensureCreepAssignmentState(creep.name).synthesisCarrierPendingPickupTick === Game.time;
    if (hadPendingPickup) {
      delete ensureCreepAssignmentState(creep.name).synthesisCarrierPendingPickupTick;
      delete ensureCreepAssignmentState(creep.name).synthesisCarrierPendingStepId;
      const state = ensureCreepAssignmentState(creep.name);
      if (state.synthesisCarrierPendingResource &&
          creep.store.getUsedCapacity(state.synthesisCarrierPendingResource) === 0) {
        delete state.synthesisCarrierPendingToId;
        delete state.synthesisCarrierPendingResource;
      }
    }

    const carrierTaskPickup = pickupSynthesisCarrierResource(creep);
    if (carrierTaskPickup.picked || carrierTaskPickup.outOfRange) {
      delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
      if (carrierTaskPickup.picked) {
        releasePickupReservation(creep);
      }
      return creep.store.getUsedCapacity() > 0 ||
        ensureCreepAssignmentState(creep.name).synthesisCarrierPendingPickupTick === Game.time;
    }

    // Pre-assigned task with fresh withdraw(OK) committed this tick —
    // same-tick mount re-entry should switch to target for delivery
    if (hadExistingTask && !hadPendingPickup &&
        ensureCreepAssignmentState(creep.name).synthesisCarrierPendingPickupTick === Game.time) {
      delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
      releasePickupReservation(creep);
      return true;
    }

    const ownedRoomDeadStorePickup = pickupOwnedRoomDeadStoreResource(creep);
    if (ownedRoomDeadStorePickup.picked || ownedRoomDeadStorePickup.outOfRange) {
      delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
      if (ownedRoomDeadStorePickup.picked) {
        releasePickupReservation(creep);
      }
      return creep.store.getUsedCapacity() > 0;
    }

    if (creep.store.getUsedCapacity() === 0 && hasNewerLiveReplacement(creep) &&
        (getAssignedCarrierRoom(creep)?.controller?.level ?? 0) > 2) {
      releasePickupReservation(creep);
      creep.suicide();
      return false;
    }

    const carrierState = ensureCreepAssignmentState(creep.name);
    const snapshotResource = carrierState.synthesisCarrierPendingResource;
    const carryingSnapshot = snapshotResource && carrierState.synthesisCarrierPendingToId &&
      creep.store.getUsedCapacity(snapshotResource) > 0;

    if (!carryingSnapshot) {
      carrierState.carrierStorageOnlyMode = true;
    }

    pickupEnergyForCarrier(creep, {
      includeStorage: false,
      includeTerminal: isTerminalPickupEnabledForRoom(assignedRoomName),
    });
    const hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
    if (hasEnergy) {
      releasePickupReservation(creep);
    }

    return hasEnergy;
  },
  target: (creep): boolean => {
    if (deliverSynthesisCarrierResource(creep)) {
      if (ensureCreepAssignmentState(creep.name).synthesisCarrierPendingDeliveryTick === Game.time) {
        return false;
      }
      return creep.store.getUsedCapacity() === 0;
    }

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      const tState = ensureCreepAssignmentState(creep.name);
      const tSnapshotResource = tState.synthesisCarrierPendingResource;
      const tSnapshotToId = tState.synthesisCarrierPendingToId;
      if (tSnapshotResource && tSnapshotToId && creep.store.getUsedCapacity(tSnapshotResource) > 0) {
        const tSnapshotTarget = resolveTaskStructure(tSnapshotToId);
        if (tSnapshotTarget) {
          const tCode = measureCreepIntent(() => creep.transfer(tSnapshotTarget, tSnapshotResource));
          if (tCode === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, tSnapshotTarget);
            return false;
          }
          if (tCode === OK) {
            delete tState.synthesisCarrierPendingToId;
            delete tState.synthesisCarrierPendingResource;
            clearPostTransferPlan(creep);
            return true;
          }
          return false;
        }
        delete tState.synthesisCarrierPendingToId;
        delete tState.synthesisCarrierPendingResource;
      }
      clearPostTransferPlan(creep);
      return creep.store.getUsedCapacity() === 0;
    }

    if (ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode) {
      const assignedRoom = getAssignedCarrierRoom(creep);
      const protoContainer = assignedRoom ? getProtoStorageContainer(assignedRoom) : null;
      const protoTarget = protoContainer && protoContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? protoContainer : null;
      const protoLinkContainer = assignedRoom ? getProtoControllerLinkContainer(assignedRoom) : null;
      const protoLinkTarget = protoLinkContainer && protoLinkContainer.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? protoLinkContainer : null;
      const storageStruct = assignedRoom?.storage;
      const terminalStruct = assignedRoom?.terminal;
      const storageTarget =
        (storageStruct && storageStruct.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? storageStruct : null) ||
        (terminalStruct && terminalStruct.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ? terminalStruct : null) ||
        protoTarget ||
        protoLinkTarget;

      if (!storageTarget) {
        delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
        clearPostTransferPlan(creep);
      } else {
        const code = measureCreepIntent(() => creep.transfer(storageTarget, RESOURCE_ENERGY));
        if (code === ERR_NOT_IN_RANGE) {
          moveToTarget(creep, storageTarget);
          return false;
        }
        if (code !== OK) {
          return false;
        }

        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
          delete ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode;
          clearPostTransferPlan(creep);
          return true;
        }

        return false;
      }
    }

    let target = getPlannedDeliveryTarget(creep);
    if (!target) {
      target = getEnergyStoreTarget(creep, { roomName: getAssignedCarrierRoomName(creep) });
      if (target) {
        setPostTransferPlan(creep, "deliver", target);
      }
    }

    if (!target) {
      clearPostTransferPlan(creep);
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && deliverToPlannedStoragePosition(creep)) {
        return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
      }
      if (
        creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
        hasRunnablePowerBankBoostCarrierTask(getAssignedCarrierRoomName(creep))
      ) {
        const dropCode = measureCreepIntent(() => creep.drop(RESOURCE_ENERGY));
        return dropCode === OK;
      }
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
      }
      return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    }

    const transferCode = measureCreepIntent(() => creep.transfer(target, RESOURCE_ENERGY));
    if (transferCode === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target);
      return false;
    }

    if (transferCode === ERR_FULL || transferCode === ERR_INVALID_TARGET) {
      clearPostTransferPlan(creep);
      return false;
    }

    if (transferCode !== OK) {
      clearPostTransferPlan(creep);
      return false;
    }

    const remainingEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
    if (remainingEnergy > 0) {
      const nextTarget = getEnergyStoreTarget(creep, {
        excludeIds: [target.id],
        roomName: getAssignedCarrierRoomName(creep),
      });
      if (nextTarget) {
        setPostTransferPlan(creep, "deliver", nextTarget);
        moveToTarget(creep, nextTarget);
        return false;
      }
    }

    clearPostTransferPlan(creep);
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      ensureCreepAssignmentState(creep.name).carrierStorageOnlyMode = true;
    }

    return creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
  },
});

import { POWER_BANK_BOOST_REQUIREMENTS } from "@/runtime/powerBankConstants";
import {
  pauseSynthesisForBoost,
  resumeSynthesisAfterBoost,
} from "@/runtime/synthesisControl";
import {
  createResourceTransferTask,
  getIncomingResourceTransferAmount,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { getTickContextService } from "@/runtime/runtimeServices";
import {
  ensurePowerBankBoostPrepStore,
  type BoostLabAssignment,
  type BoostPrepMemory,
} from "@/runtime/powerBankBoostMemory";

const POWER_BANK_BOOST_PRODUCER = "powerBankBoost";
const BOOST_LAB_SUPPLY_PRIORITY = 140;

export interface BoostPrepResult {
  status: "preparing" | "ready" | "failed";
  reason?: string;
  labs: string[];
}

function getRequiredCompounds(tier: number): ResourceConstant[] {
  const req = POWER_BANK_BOOST_REQUIREMENTS[tier];
  if (!req) return [];
  const compounds: ResourceConstant[] = [
    ...req.attacker,
    ...req.healer,
  ];
  return [...new Set(compounds)];
}

function getLocalStock(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }
  return total;
}

function selectAvailableLabs(room: Room, count: number): StructureLab[] {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureLab => s.structureType === STRUCTURE_LAB,
  });
  const preferred = labs.filter((lab) => {
    const mineralType = lab.mineralType as ResourceConstant | undefined;
    if (!mineralType) return true;
    if (lab.store.getUsedCapacity(mineralType) <= 0) return true;
    return false;
  });
  const pool = preferred.length >= count ? preferred : labs;
  return pool.slice(0, count);
}

export function prepareBoosts(
  taskId: string,
  sourceRoomName: string,
  tier: number,
): BoostPrepResult {
  const compounds = getRequiredCompounds(tier);

  if (compounds.length === 0) {
    return { status: "ready", labs: [] };
  }

  const room = Game.rooms[sourceRoomName];
  if (!room) {
    return { status: "failed", reason: "room_not_visible", labs: [] };
  }

  pauseSynthesisForBoost(sourceRoomName, taskId);

  const labs = selectAvailableLabs(room, compounds.length);
  if (labs.length < compounds.length) {
    return {
      status: "failed",
      reason: "insufficient_labs",
      labs: labs.map((l) => l.id),
    };
  }

  const prepStore = ensurePowerBankBoostPrepStore();
  const assignments: Record<string, BoostLabAssignment> = {};
  const drafts: CarrierTaskDraft[] = [];

  for (let i = 0; i < compounds.length; i++) {
    const compound = compounds[i];
    const lab = labs[i];
    assignments[lab.id] = { labId: lab.id, compound };

    const needed = LAB_BOOST_MINERAL * 30;
    const labHas = lab.store.getUsedCapacity(compound);
    const incoming = getIncomingResourceTransferAmount(sourceRoomName, compound);
    const localStock = getLocalStock(room, compound);

    const deficit = Math.max(0, needed - labHas - incoming);

    if (deficit > 0 && localStock > 0) {
      const source = resolveBoostSupplySource(room, compound);
      if (source) {
        const amount = Math.min(deficit, localStock, source.store.getUsedCapacity(compound));
        const labFree = lab.store.getFreeCapacity();
        // lab.store.getFreeCapacity(resource) returns null when mineralType is not set;
        // use total free capacity instead
        const usableFree = labFree ?? 0;
        const transferAmt = Math.min(amount, usableFree);
        if (transferAmt > 0) {
          drafts.push({
            id: `powerBankBoost:lab_supply:${sourceRoomName}:${compound}`,
            type: "lab_supply",
            priority: BOOST_LAB_SUPPLY_PRIORITY,
            steps: [
              {
                id: `${compound}:${source.id}->${lab.id}`,
                resource: compound,
                fromKind: source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
                toKind: "lab",
                fromId: source.id,
                toId: lab.id,
                amount: transferAmt,
              },
            ],
          });
        }
      }
    } else if (deficit > 0 && localStock <= 0 && incoming < deficit) {
      const donorRoom = findBestDonorRoom(compound, deficit, [sourceRoomName]);
      if (donorRoom) {
        createResourceTransferTask(
          donorRoom,
          sourceRoomName,
          compound,
          deficit,
          `powerBankBoost:${taskId}`,
        );
      } else {
        return {
          status: "failed",
          reason: "insufficient_boost_compound",
          labs: labs.map((l) => l.id),
        };
      }
    }
  }

  prepStore[taskId] = {
    labs: assignments,
    taskId,
    sourceRoomName,
  };

  replaceCarrierTasksForProducerRoom(
    POWER_BANK_BOOST_PRODUCER,
    sourceRoomName,
    drafts,
  );

  if (checkBoostReadiness(sourceRoomName, compounds)) {
    return { status: "ready", labs: labs.map((l) => l.id) };
  }

  return { status: "preparing", labs: labs.map((l) => l.id) };
}

/**
 * Checks if all required compounds are loaded in reserved boost labs.
 */
export function checkBoostReadiness(
  sourceRoomName: string,
  requiredCompounds: ResourceConstant[],
): boolean {
  if (requiredCompounds.length === 0) return true;

  const prepStore = ensurePowerBankBoostPrepStore();
  const activePrep = Object.values(prepStore).find(
    (p) => p.sourceRoomName === sourceRoomName,
  );
  if (!activePrep) return false;

  for (const compound of requiredCompounds) {
    const assignment = Object.values(activePrep.labs).find(
      (a) => a.compound === compound,
    );
    if (!assignment) return false;

    const lab = Game.getObjectById(assignment.labId as Id<StructureLab>);
    if (!lab) return false;

    const labAmount = lab.store.getUsedCapacity(compound);
    if (labAmount < LAB_BOOST_MINERAL) return false;
  }

  return true;
}

/**
 * Releases boost labs and resumes synthesis production.
 */
export function releaseBoostLabs(taskId: string, sourceRoomName: string): void {
  replaceCarrierTasksForProducerRoom(
    POWER_BANK_BOOST_PRODUCER,
    sourceRoomName,
    [],
  );

  const prepStore = ensurePowerBankBoostPrepStore();
  delete prepStore[taskId];

  resumeSynthesisAfterBoost(sourceRoomName);
}

/**
 * Finds the best donor room for a resource transfer. Prefers hub rooms.
 * Returns null if no room has sufficient surplus.
 */
export function findBestDonorRoom(
  resource: ResourceConstant,
  amount: number,
  excludeRooms: string[],
): string | null {
  const hubRoomName = Memory.cfg?.hub?.hubRoomName;
  const candidates: Array<{ roomName: string; surplus: number; isHub: boolean }> = [];

  for (const room of getTickContextService().getMyRooms()) {
    if (excludeRooms.includes(room.name)) continue;
    if (!room.terminal) continue;
    if (room.terminal.cooldown > 0) continue;

    const surplus = room.terminal.store.getUsedCapacity(resource);

    if (surplus < amount) continue;

    candidates.push({
      roomName: room.name,
      surplus,
      isHub: room.name === hubRoomName,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
    return b.surplus - a.surplus;
  });

  return candidates[0].roomName;
}

function resolveBoostSupplySource(
  room: Room,
  resource: ResourceConstant,
): StructureStorage | StructureTerminal | null {
  const terminalAmount = room.terminal?.store.getUsedCapacity(resource) ?? 0;
  const storageAmount = room.storage?.store.getUsedCapacity(resource) ?? 0;

  if (storageAmount >= terminalAmount && room.storage && storageAmount > 0) {
    return room.storage;
  }
  if (room.terminal && terminalAmount > 0) {
    return room.terminal;
  }
  if (room.storage && storageAmount > 0) {
    return room.storage;
  }
  return null;
}

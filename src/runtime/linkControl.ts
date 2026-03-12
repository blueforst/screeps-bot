import { hasSourceAdjacentLink } from "@/runtime/sourceLink";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import { getTickContextService } from "@/runtime/runtimeServices";

const CLASSIFY_INTERVAL = 11;
const SOURCE_SENDER_RANGE = 2;
const RECEIVER_RANGE = 2;
const RECEIVER_FILL_THRESHOLD = 0.5;

interface LinkRoomRuntime {
  updatedAt: number;
  senderIds: string[];
  receiverIds: string[];
}

function ensureLinkRuntimeStore(): Record<string, LinkRoomRuntime> {
  Memory.runtime = Memory.runtime || {};
  Memory.runtime.linkNetwork = Memory.runtime.linkNetwork || {};
  return Memory.runtime.linkNetwork;
}

function classifyRoomLinks(room: Room): LinkRoomRuntime {
  const roomContext = getTickContextService().getRoomContext(room);
  const links = roomContext?.getLinks() || [];
  const sources = roomContext?.getSources() || [];
  const storagePos = room.storage?.pos;
  const controllerPos = room.controller?.pos;

  const senderIds: string[] = [];
  const receiverIds: string[] = [];

  for (const link of links) {
    const nearReceiver =
      (!!storagePos && link.pos.getRangeTo(storagePos) <= RECEIVER_RANGE) ||
      (!!controllerPos && link.pos.getRangeTo(controllerPos) <= RECEIVER_RANGE);

    if (nearReceiver) {
      receiverIds.push(link.id);
      continue;
    }

    const nearSource = sources.some((source) => link.pos.getRangeTo(source.pos) <= SOURCE_SENDER_RANGE);
    if (nearSource) {
      senderIds.push(link.id);
    }
  }

  return {
    updatedAt: Game.time,
    senderIds,
    receiverIds,
  };
}

function getRoomLinkRuntime(room: Room): LinkRoomRuntime {
  const store = ensureLinkRuntimeStore();
  const existing = store[room.name];
  if (!existing || Game.time - existing.updatedAt >= CLASSIFY_INTERVAL) {
    const refreshed = classifyRoomLinks(room);
    store[room.name] = refreshed;
    return refreshed;
  }

  return existing;
}

function isReceiverByPosition(link: StructureLink): boolean {
  const storagePos = link.room.storage?.pos;
  const controllerPos = link.room.controller?.pos;
  return (
    (!!storagePos && link.pos.getRangeTo(storagePos) <= RECEIVER_RANGE) ||
    (!!controllerPos && link.pos.getRangeTo(controllerPos) <= RECEIVER_RANGE)
  );
}

function isStorageReceiverByPosition(link: StructureLink): boolean {
  const storagePos = link.room.storage?.pos;
  return !!storagePos && link.pos.getRangeTo(storagePos) <= RECEIVER_RANGE;
}

function isLinkUnderfilled(link: StructureLink): boolean {
  const capacity = link.store.getCapacity(RESOURCE_ENERGY);
  if (!capacity || capacity <= 0) {
    return false;
  }

  const used = link.store.getUsedCapacity(RESOURCE_ENERGY);
  return used / capacity < RECEIVER_FILL_THRESHOLD;
}

function isControllerReceiver(link: StructureLink): boolean {
  const controllerPos = link.room.controller?.pos;
  return !!controllerPos && link.pos.getRangeTo(controllerPos) <= RECEIVER_RANGE;
}

function chooseReceiverTarget(sender: StructureLink, receiverLinks: StructureLink[]): StructureLink | null {
  const validReceivers = receiverLinks
    .filter((receiver) => receiver.id !== sender.id && isLinkUnderfilled(receiver))
    .sort((a, b) => {
      const aControllerPriority = isControllerReceiver(a) ? 0 : 1;
      const bControllerPriority = isControllerReceiver(b) ? 0 : 1;
      if (aControllerPriority !== bControllerPriority) {
        return aControllerPriority - bControllerPriority;
      }

      const aCapacity = a.store.getCapacity(RESOURCE_ENERGY) || 1;
      const bCapacity = b.store.getCapacity(RESOURCE_ENERGY) || 1;
      const aFill = a.store.getUsedCapacity(RESOURCE_ENERGY) / aCapacity;
      const bFill = b.store.getUsedCapacity(RESOURCE_ENERGY) / bCapacity;
      if (aFill !== bFill) {
        return aFill - bFill;
      }

      return sender.pos.getRangeTo(a.pos) - sender.pos.getRangeTo(b.pos);
    });

  return validReceivers[0] || null;
}

function cleanupLinkedSourceContainers(room: Room): void {
  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    if (!hasSourceAdjacentLink(source)) {
      continue;
    }

    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
    }) as StructureContainer[];
    for (const container of containers) {
      container.destroy();
    }

    const sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
      filter: (site) => site.structureType === STRUCTURE_CONTAINER,
    });
    for (const site of sites) {
      site.remove();
    }
  }
}

export function isReceiverLink(link: StructureLink): boolean {
  const roomData = Memory.runtime?.linkNetwork?.[link.room.name];
  if (!roomData) {
    return isReceiverByPosition(link);
  }

  return roomData.receiverIds.includes(link.id) || isReceiverByPosition(link);
}

export function isStorageReceiverLink(link: StructureLink): boolean {
  const roomData = Memory.runtime?.linkNetwork?.[link.room.name];
  if (!roomData) {
    return isStorageReceiverByPosition(link);
  }

  return roomData.receiverIds.includes(link.id) && isStorageReceiverByPosition(link);
}

export function runLinkControl(): void {
  const myRooms = getTickContextService().getMyRooms();

  for (const room of myRooms) {
    cleanupLinkedSourceContainers(room);

    const roomData = getRoomLinkRuntime(room);
    if (roomData.senderIds.length === 0 || roomData.receiverIds.length === 0) {
      continue;
    }

    const senderLinks = roomData.senderIds
      .map((id) => Game.getObjectById(id as Id<StructureLink>))
      .filter((link): link is StructureLink => !!link);
    const receiverLinks = roomData.receiverIds
      .map((id) => Game.getObjectById(id as Id<StructureLink>))
      .filter((link): link is StructureLink => !!link);

    if (senderLinks.length === 0 || receiverLinks.length === 0) {
      continue;
    }

    for (const sender of senderLinks) {
      if (sender.cooldown > 0 || sender.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
        continue;
      }

      const target = chooseReceiverTarget(sender, receiverLinks);
      if (!target) {
        continue;
      }

      const code = sender.transferEnergy(target);
      if (code === OK) {
        recordFixedCpuAction("linkControl");
      }
    }
  }
}

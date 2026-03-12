import { runMineralExtraction } from "@/runtime/mineralExtraction";
import { replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createContainer(
  room: Room,
  mineralType: MineralConstant,
  amount: number,
): StructureContainer {
  return {
    id: `${room.name}-container-${amount}`,
    structureType: STRUCTURE_CONTAINER,
    room,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return amount;
        }
        return resource === mineralType ? amount : 0;
      },
    },
  } as unknown as StructureContainer;
}

function createMineral(
  room: Room,
  options: {
    id?: string;
    mineralType?: MineralConstant;
    amount?: number;
    hasExtractor?: boolean;
    containerAmount?: number;
  } = {},
): Mineral {
  const mineralType = options.mineralType ?? RESOURCE_KEANIUM;
  const structures: Structure[] = [];
  if (options.hasExtractor ?? true) {
    structures.push({ structureType: STRUCTURE_EXTRACTOR } as StructureExtractor);
  }
  if ((options.containerAmount ?? 0) > 0) {
    structures.push(createContainer(room, mineralType, options.containerAmount ?? 0));
  }

  return {
    id: options.id ?? `${room.name}-mineral`,
    mineralType,
    mineralAmount: options.amount ?? 10000,
    room,
    pos: {
      lookFor: () => structures,
      findInRange: (_type: FindConstant, _range: number, opts?: { filter?: (value: Structure) => boolean }) =>
        opts?.filter ? structures.filter((structure) => opts.filter?.(structure)) : structures,
    } as unknown as RoomPosition,
  } as Mineral;
}

function createRoom(options: {
  name?: string;
  minerals?: Mineral[];
  terminalFree?: number;
  storageFree?: number;
} = {}): Room {
  const name = options.name ?? "W1N1";
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    terminal: {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getFreeCapacity: () => options.terminalFree ?? 10000,
      },
    } as unknown as StructureTerminal,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getFreeCapacity: () => options.storageFree ?? 10000,
      },
    } as unknown as StructureStorage,
    find(type: FindConstant) {
      if (type === FIND_MINERALS) {
        return options.minerals ?? [];
      }
      return [];
    },
  } as Room;

  return room;
}

describe("runMineralExtraction", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 10;
    Memory.rooms = {};
  });

  it("creates a mineral hauling task only when container stock is above threshold", () => {
    const room = createRoom();
    const mineral = createMineral(room, { containerAmount: 701 });
    room.find = ((type: FindConstant) => (type === FIND_MINERALS ? [mineral] : [])) as Room["find"];
    Game.rooms[room.name] = room;

    runMineralExtraction();

    expect(Memory.rooms?.[room.name]?.carrierTasks).toMatchObject({
      [`mineral:mineral_haul:${room.name}:${mineral.id}`]: {
        type: "mineral_haul",
        steps: [
          {
            resource: mineral.mineralType,
            fromKind: "container",
            toKind: "terminal",
            amount: 701,
          },
        ],
      },
    });
  });

  it("does not create a task when container stock is at or below threshold", () => {
    const room = createRoom({ name: "W1N2" });
    const mineral = createMineral(room, { containerAmount: 700 });
    room.find = ((type: FindConstant) => (type === FIND_MINERALS ? [mineral] : [])) as Room["find"];
    Game.rooms[room.name] = room;

    runMineralExtraction();

    expect(Memory.rooms?.[room.name]?.carrierTasks).toBeUndefined();
  });

  it("clears existing mineral tasks when stock falls back to threshold", () => {
    const room = createRoom({ name: "W1N4" });
    const mineral = createMineral(room, { containerAmount: 700 });
    room.find = ((type: FindConstant) => (type === FIND_MINERALS ? [mineral] : [])) as Room["find"];
    Game.rooms[room.name] = room;
    replaceCarrierTasksForProducerRoom("mineralExtraction", room.name, [
      {
        id: `mineral:mineral_haul:${room.name}:${mineral.id}`,
        type: "mineral_haul",
        priority: 25,
        steps: [
          {
            id: "step-1",
            resource: mineral.mineralType,
            fromKind: "container",
            toKind: "terminal",
            fromId: "from-1",
            toId: "to-1",
            amount: 800,
          },
        ],
      },
    ]);

    runMineralExtraction();

    expect(Memory.rooms?.[room.name]?.carrierTasks).toBeUndefined();
  });

  it("falls back to storage when terminal cannot accept the mineral", () => {
    const room = createRoom({ name: "W1N3", terminalFree: 0, storageFree: 5000 });
    const mineral = createMineral(room, { containerAmount: 900 });
    room.find = ((type: FindConstant) => (type === FIND_MINERALS ? [mineral] : [])) as Room["find"];
    Game.rooms[room.name] = room;

    runMineralExtraction();

    expect(Memory.rooms?.[room.name]?.carrierTasks).toMatchObject({
      [`mineral:mineral_haul:${room.name}:${mineral.id}`]: {
        steps: [
          {
            toKind: "storage",
          },
        ],
      },
    });
  });
});

import { runSynthesisControl } from "@/runtime/synthesisControl";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createLab(room: Room, id: string): StructureLab {
  return {
    id,
    room,
    structureType: STRUCTURE_LAB,
    pos: {
      inRangeTo: () => true,
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: () => 0,
    },
    runReaction: jest.fn(() => OK),
    cooldown: 0,
  } as unknown as StructureLab;
}

function createRoom(options: {
  name: string;
  mineralType: MineralConstant;
  storageEnergy?: number;
  hydroxideAmount?: number;
}): Room {
  const room = {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === RESOURCE_ENERGY) {
            return options.storageEnergy ?? 0;
          }
          if (resource === RESOURCE_HYDROXIDE) {
            return options.hydroxideAmount ?? 0;
          }
          return 0;
        },
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_HYDROXIDE ? 0 : 0),
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal,
  } as Room;

  const labs = [createLab(room, `${options.name}-lab-1`), createLab(room, `${options.name}-lab-2`), createLab(room, `${options.name}-lab-3`)];
  room.find = ((type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) => {
    if (type === FIND_MINERALS) {
      return [{ id: `${options.name}-mineral`, mineralType: options.mineralType, room } as Mineral];
    }
    if (type === FIND_MY_STRUCTURES) {
      return opts?.filter ? labs.filter((structure) => opts.filter?.(structure)) : labs;
    }
    return [];
  }) as Room["find"];
  return room;
}

describe("runSynthesisControl auto OH planning", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 1;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
      },
    };
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
  });

  it("selects a native reagent room as the auto OH producer", () => {
    const keaniumRoom = createRoom({ name: "W1N1", mineralType: RESOURCE_KEANIUM, storageEnergy: 500000, hydroxideAmount: 1000 });
    const hydrogenRoom = createRoom({ name: "W1N2", mineralType: RESOURCE_HYDROGEN, storageEnergy: 300000, hydroxideAmount: 0 });
    Game.rooms[keaniumRoom.name] = keaniumRoom;
    Game.rooms[hydrogenRoom.name] = hydrogenRoom;

    runSynthesisControl();

    expect(Memory.runtime?.synthesisControl).toMatchObject({
      autoOhTarget: 4000,
      autoOhCurrent: 1000,
      autoOhProducerRoomName: hydrogenRoom.name,
      rooms: {
        [hydrogenRoom.name]: {
          activeProduct: RESOURCE_HYDROXIDE,
          targetAmount: 3000,
        },
      },
    });
  });

  it("keeps manual synthesis reactions ahead of the auto OH fallback", () => {
    const hydrogenRoom = createRoom({ name: "W2N2", mineralType: RESOURCE_HYDROGEN, storageEnergy: 300000, hydroxideAmount: 0 });
    const oxygenRoom = createRoom({ name: "W2N3", mineralType: RESOURCE_OXYGEN, storageEnergy: 250000, hydroxideAmount: 0 });
    Game.rooms[hydrogenRoom.name] = hydrogenRoom;
    Game.rooms[oxygenRoom.name] = oxygenRoom;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          [hydrogenRoom.name]: {
            reactions: [
              {
                product: RESOURCE_UTRIUM_HYDRIDE,
                targetAmount: 500,
              },
            ],
          },
        },
      },
    };

    runSynthesisControl();

    expect(Memory.runtime?.synthesisControl?.rooms[hydrogenRoom.name]?.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(Memory.runtime?.synthesisControl?.autoOhProducerRoomName).toBe(hydrogenRoom.name);
  });

  it("does not create an auto OH plan when the global reserve is already satisfied", () => {
    const hydrogenRoom = createRoom({ name: "W3N1", mineralType: RESOURCE_HYDROGEN, storageEnergy: 300000, hydroxideAmount: 2500 });
    const oxygenRoom = createRoom({ name: "W3N2", mineralType: RESOURCE_OXYGEN, storageEnergy: 250000, hydroxideAmount: 2000 });
    Game.rooms[hydrogenRoom.name] = hydrogenRoom;
    Game.rooms[oxygenRoom.name] = oxygenRoom;

    runSynthesisControl();

    expect(Memory.runtime?.synthesisControl?.autoOhProducerRoomName).toBeUndefined();
    expect(Memory.runtime?.synthesisControl?.rooms).toEqual({});
  });

});

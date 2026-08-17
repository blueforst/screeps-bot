import { runFlagHaulingByFlag } from "@/runtime/flagHauling";
import { getCreepConfigService } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    energyCapacityAvailable: 1600,
    find: () => [],
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

function createSpawn(room: Room): StructureSpawn {
  const spawn = {
    name: `${room.name}-spawn`,
    room,
    memory: {},
    isActive: () => true,
  } as unknown as StructureSpawn;
  Game.spawns[spawn.name] = spawn;
  return spawn;
}

function createFlag(name: string, roomName: string): Flag {
  return {
    name,
    pos: { x: 25, y: 25, roomName } as RoomPosition,
    remove: jest.fn(() => OK),
  } as unknown as Flag;
}

function createStoredStructure(
  id: string,
  structureType: StructureConstant,
  resources: Partial<Record<ResourceConstant, number>>,
): AnyStoreStructure {
  return {
    id,
    structureType,
    store: {
      ...resources,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
        }

        return resources[resource] || 0;
      },
    },
  } as unknown as AnyStoreStructure;
}

function createRemoteCarrierCreep(configName: string, carriedAmount: number): Creep {
  return {
    name: `remote-carrier-${carriedAmount}`,
    memory: {
      role: "remoteCarrier",
      roleArgs: ["W5N5", "25", "25"],
      configName,
    },
    room: { name: carriedAmount > 0 ? "W5N5" : "W1N1" } as Room,
    store: {
      getUsedCapacity: () => carriedAmount,
    },
  } as unknown as Creep;
}

describe("runFlagHaulingByFlag", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
    Game.flags = {};
    Game.rooms = {};
    Game.spawns = {};
    Memory.data = {};
    Memory.creeps = {};
    (Game as Game & { map: GameMap }).map = {
      getRoomLinearDistance: (left: string, right: string) => (left === right ? 0 : 10),
    } as GameMap;
  });

  it("removes the flag when only less-than-carrier-capacity energy remains", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    const target = {
      name: "W5N5",
      controller: undefined,
      find: jest.fn((type: FindConstant) => {
        if (type === FIND_STRUCTURES) {
          return [createStoredStructure("remote-container", STRUCTURE_CONTAINER, { [RESOURCE_ENERGY]: 799 })];
        }

        return [];
      }),
    } as unknown as Room;
    Game.rooms[target.name] = target;
    const flag = createFlag("HAUL", target.name);
    Game.flags.HAUL = flag;

    runFlagHaulingByFlag();

    expect(flag.remove).toHaveBeenCalledTimes(1);
    expect(getCreepConfigService().list()).toEqual({});
  });

  it("keeps cancelled configs while loaded carriers still need to return home", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    Game.flags.HAUL = createFlag("HAUL", "W5N5");
    runFlagHaulingByFlag();
    const configName = "W1N1:haul:W5N5:carrier:HAUL";
    const carrier = createRemoteCarrierCreep(configName, 800);
    Game.creeps = { [carrier.name]: carrier };
    Game.flags = {};
    Game.time += 1;

    runFlagHaulingByFlag();

    expect(getCreepConfigService().get(configName)).toMatchObject({
      role: "remoteCarrier",
      args: ["W5N5", "25", "25"],
    });
    expect(getCreepConfigService().get(configName)?.roomName).toBeUndefined();
    expect(carrier.memory.configName).toBe(configName);
    expect(Memory.data?.flagHauling?.HAUL).toBeDefined();
  });
});

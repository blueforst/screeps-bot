jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set(["safe"])),
}));

jest.mock("@/runtime/boostControl", () => ({
  buyBoostIfNeeded: jest.fn(),
  clearBoostLabTasks: jest.fn(),
  shouldBoostDefender: jest.fn(() => false),
  syncBoostLabTask: jest.fn(),
}));

import { runHomeDefense } from "@/runtime/homeDefense";
import { buyBoostIfNeeded, clearBoostLabTasks, shouldBoostDefender, syncBoostLabTask } from "@/runtime/boostControl";
import { getCreepConfigService } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createTower(roomName: string, x: number, y: number, energy: number): StructureTower {
  return {
    id: `${roomName}-tower-${x}-${y}` as Id<StructureTower>,
    structureType: STRUCTURE_TOWER,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    store: {
      getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? 1000 : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY || resource === undefined ? Math.max(0, 1000 - energy) : 0,
      ),
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? energy : 0)),
    } as unknown as StoreDefinition,
  } as unknown as StructureTower;
}

function createHostile(roomName: string, x: number, y: number): Creep {
  return {
    id: `${roomName}-hostile-${x}-${y}` as Id<Creep>,
    owner: {
      username: "Enemy",
    } as Owner,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    body: [{ type: ATTACK, hits: 100 } as BodyPartDefinition],
    hits: 100,
    hitsMax: 100,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
  } as unknown as Creep;
}

function createRoom(
  name: string,
  options: {
    towers?: StructureTower[];
    hostiles?: Creep[];
    myCreeps?: Creep[];
  } = {},
): Room {
  const towers = options.towers ?? [];
  const hostiles = options.hostiles ?? [];
  const myCreeps = options.myCreeps ?? [];

  const hostileFilter = (opts?: { filter?: unknown }): ((creep: Creep) => boolean) | null => {
    if (typeof opts?.filter === "function") {
      return opts.filter as (creep: Creep) => boolean;
    }

    return null;
  };

  return {
    name,
    controller: {
      my: true,
    } as StructureController,
    find(type: FindConstant, opts?: { filter?: unknown }) {
      if (type === FIND_HOSTILE_CREEPS) {
        const results = [...hostiles];
        const filter = hostileFilter(opts);
        return filter ? results.filter((creep) => filter(creep)) : results;
      }

      if (type === FIND_MY_STRUCTURES) {
        return towers;
      }

      if (type === FIND_MY_CREEPS) {
        return myCreeps;
      }

      return [];
    },
  } as Room;
}

function createSpawn(room: Room, queue: string[] = []): StructureSpawn {
  return {
    name: `${room.name}-spawn`,
    id: `${room.name}-spawn-id` as Id<StructureSpawn>,
    room,
    memory: {
      spawnList: [...queue],
    },
    spawning: null,
    addTask(configName: string) {
      this.memory.spawnList = [...(this.memory.spawnList || []), configName];
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

describe("runHomeDefense", () => {
  beforeEach(() => {
    resetRuntimeServices();
    jest.clearAllMocks();
    Game.time += 1;
  });

  it("stops queued defender spawning when towers can handle the hostile", () => {
    const roomName = "W1N1";
    const configName = `${roomName}:homeDefense:defender:0`;
    const hostile = createHostile(roomName, 12, 12);
    const room = createRoom(roomName, {
      towers: [createTower(roomName, 10, 10, 500)],
      hostiles: [hostile],
    });
    const spawn = createSpawn(room, [configName]);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.data = {
      creepConfigs: {
        [configName]: {
          role: "homeDefender",
          args: [roomName],
          roomName,
        },
      },
    } as Memory["data"];

    runHomeDefense();

    expect(spawn.memory.spawnList).toEqual([]);
    expect(getCreepConfigService().get(configName)).toBeUndefined();
    expect(clearBoostLabTasks).toHaveBeenCalledWith(roomName);
    expect(shouldBoostDefender).not.toHaveBeenCalled();
    expect(buyBoostIfNeeded).not.toHaveBeenCalled();
    expect(syncBoostLabTask).not.toHaveBeenCalled();
  });

  it("queues a defender when towers cannot handle the hostile", () => {
    const roomName = "W1N2";
    const configName = `${roomName}:homeDefense:defender:0`;
    const hostile = createHostile(roomName, 12, 12);
    const room = createRoom(roomName, {
      towers: [createTower(roomName, 10, 10, 0)],
      hostiles: [hostile],
    });
    const spawn = createSpawn(room);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;

    runHomeDefense();

    expect(spawn.memory.spawnList).toEqual([configName]);
    expect(getCreepConfigService().get(configName)).toMatchObject({
      role: "homeDefender",
      args: [roomName],
      roomName,
    });
    expect(shouldBoostDefender).toHaveBeenCalledWith(room, [hostile]);
    expect(clearBoostLabTasks).toHaveBeenCalledWith(roomName);
  });
});

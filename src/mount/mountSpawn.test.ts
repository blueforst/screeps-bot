jest.mock("@/runtime/tickContext", () => ({
  ...jest.requireActual("@/runtime/tickContext"),
  isSpawnActive: jest.fn(() => true),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  recordFixedCpuAction: jest.fn(),
}));

import { mountSpawn } from "@/mount/mountSpawn";
import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
} from "@/runtime/upgraderPolicy";

type SpawnPrototype = {
  work(this: StructureSpawn): void;
};

function createSpawn(name: string, room: Room, queue: string[]): StructureSpawn {
  return {
    name,
    room,
    spawning: null,
    memory: { spawnList: [...queue] },
    spawnCreep: jest.fn(() => OK),
  } as unknown as StructureSpawn;
}

describe("mountSpawn", () => {
  let prototype: SpawnPrototype;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Object.assign(global, { StructureSpawn: function StructureSpawn() {} });
    mountSpawn();
    prototype = (global as typeof global & {
      StructureSpawn: { prototype: SpawnPrototype };
    }).StructureSpawn.prototype;
    Memory.data = { creepConfigs: {} } as Memory["data"];
    Game.rooms = {};
    Game.spawns = {};
  });

  it("preserves authenticated RCL8 maintenance ownership over war and emergency queues", () => {
    const room = {
      name: "E4N58",
      energyAvailable: 300,
      energyCapacityAvailable: 5_600,
      controller: {
        my: true,
        level: 8,
        ticksToDowngrade: RCL8_UPGRADER_RECOVERY_START_TICKS,
      },
    } as Room;
    const maintenance = "E4N58:upgrader:0";
    const war = "E4N58:war:E5N58:g1:healer:0";
    const emergency = `E4N58:manual:maxcarrier:${Game.time}`;
    Memory.data = {
      manualUpgraders: {
        [room.name]: { createdAt: Game.time, updatedAt: Game.time, maintenance: true },
      },
      creepConfigs: {
        [maintenance]: {
          role: "upgrader",
          args: [room.name],
          roomName: room.name,
          body: [...RCL8_UPGRADER_MAINTENANCE_BODY],
        },
        [war]: { role: "healer", args: [], roomName: room.name, body: [HEAL, MOVE] },
        [emergency]: { role: "carrier", args: [], roomName: room.name, body: [CARRY, MOVE] },
      },
    } as Memory["data"];
    Game.rooms[room.name] = room;
    const maintenanceSpawn = createSpawn("Spawn1", room, [maintenance]);
    const warSpawn = createSpawn("Spawn2", room, [war]);
    const emergencySpawn = createSpawn("Spawn3", room, [emergency]);
    for (const spawn of [maintenanceSpawn, warSpawn, emergencySpawn]) {
      Object.setPrototypeOf(spawn, prototype);
    }
    Game.spawns = {
      Spawn1: maintenanceSpawn,
      Spawn2: warSpawn,
      Spawn3: emergencySpawn,
    };

    prototype.work.call(warSpawn);
    prototype.work.call(emergencySpawn);
    expect(warSpawn.spawnCreep).not.toHaveBeenCalled();
    expect(emergencySpawn.spawnCreep).not.toHaveBeenCalled();

    prototype.work.call(maintenanceSpawn);
    expect(maintenanceSpawn.spawnCreep).toHaveBeenCalledWith(
      RCL8_UPGRADER_MAINTENANCE_BODY,
      `upgrader-${Game.time}`,
      expect.objectContaining({
        memory: expect.objectContaining({ configName: maintenance }),
      }),
    );
    expect(maintenanceSpawn.memory.spawnList).toEqual([]);
  });

  it("locks Spawn20 to its safe exit and isolates success cleanup from failure retry", () => {
    {
      const room = {
        name: "E5N59",
        energyAvailable: 1_000,
        energyCapacityAvailable: 12_900,
      } as Room;
      const configName = `${room.name}:manual:maxcarrier:${Game.time}`;
      Memory.data = {
        creepConfigs: {
          [configName]: {
            role: "carrier",
            args: [],
            roomName: room.name,
            body: [CARRY, MOVE],
          },
        },
      } as Memory["data"];
      const spawn = createSpawn("Spawn20", room, [configName]);
      Object.setPrototypeOf(spawn, prototype);
      Game.spawns = { Spawn20: spawn };

      prototype.work.call(spawn);

      expect(spawn.spawnCreep).toHaveBeenCalledWith(
        [CARRY, MOVE],
        `carrier-${Game.time}`,
        expect.objectContaining({ directions: [TOP] }),
      );
      expect(spawn.memory.spawnList).toEqual([]);
      expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
    }

    // The failure fixture is rebuilt from scratch so the first scenario cannot leak queue/config state.
    {
      const room = {
        name: "E5N59",
        energyAvailable: 200,
        energyCapacityAvailable: 12_900,
      } as Room;
      const configName = `${room.name}:carrier:0`;
      Memory.data = {
        creepConfigs: {
          [configName]: {
            role: "carrier",
            args: [],
            roomName: room.name,
            body: [CARRY, CARRY, MOVE],
          },
        },
      } as Memory["data"];
      const spawn = createSpawn("Spawn20", room, [configName]);
      spawn.spawnCreep = jest.fn(() => ERR_NOT_ENOUGH_ENERGY);
      Object.setPrototypeOf(spawn, prototype);
      Game.spawns = { Spawn20: spawn };

      prototype.work.call(spawn);

      expect(spawn.memory.spawnList).toEqual([configName]);
      expect(spawn.memory._lastSpawnFail).toMatchObject({
        tick: Game.time,
        spawnName: "Spawn20",
        configName,
        role: "carrier",
        code: ERR_NOT_ENOUGH_ENERGY,
      });
      expect(Memory.data!.creepConfigs![configName]).toBeDefined();
      expect(spawn.spawnCreep).toHaveBeenCalledWith(
        [CARRY, CARRY, MOVE],
        `carrier-${Game.time}`,
        expect.objectContaining({ directions: [TOP] }),
      );
    }
  });
});

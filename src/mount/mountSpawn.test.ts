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

describe("mountSpawn war energy reservation", () => {
  let prototype: SpawnPrototype;

  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Object.assign(global, { StructureSpawn: function StructureSpawn() {} });
    mountSpawn();
    prototype = (global as typeof global & {
      StructureSpawn: { prototype: SpawnPrototype };
    }).StructureSpawn.prototype;
    Memory.data = { creepConfigs: {} } as Memory["data"];
    Game.spawns = {};
  });

  it("keeps reserving energy when the spawn holding the war task is still busy with a source-room carrier", () => {
    const room = {
      name: "E1N57",
      energyAvailable: 3_482,
      energyCapacityAvailable: 5_600,
    } as Room;
    const warConfig = "E1N57:war:E3N57:controllerAttacker:0";
    const remoteConfig = "E1N57:remoteMine:E1N56:carrier:1";
    Memory.data!.creepConfigs = {
      [warConfig]: {
        role: "claimer",
        args: ["E3N57", "", "attack"],
        roomName: room.name,
        body: [...Array(8).fill(CLAIM), ...Array(8).fill(MOVE)],
      },
      [remoteConfig]: {
        role: "remoteMiningCarrier",
        args: ["E1N56"],
        roomName: room.name,
        body: [CARRY, CARRY, MOVE],
      },
    };
    const warSpawn = createSpawn("Spawn5", room, [warConfig]);
    warSpawn.spawning = {
      name: "carrier-72350194",
      remainingTime: 58,
      needTime: 96,
    } as Spawning;
    const remoteSpawn = createSpawn("Spawn11", room, [remoteConfig]);
    Object.setPrototypeOf(warSpawn, prototype);
    Object.setPrototypeOf(remoteSpawn, prototype);
    Game.spawns = { Spawn5: warSpawn, Spawn11: remoteSpawn };

    prototype.work.call(remoteSpawn);

    expect(remoteSpawn.spawnCreep).not.toHaveBeenCalled();
    expect(remoteSpawn.memory.spawnList).toEqual([remoteConfig]);
  });

  it("does not yield to a 51-part or invalid-part emergency config", () => {
    const room = { name: "E1N61", energyAvailable: 3000, energyCapacityAvailable: 3000 } as Room;
    const emergencyConfig = `${room.name}:manual:maxcarrier:${Game.time}`;
    const workerConfig = `${room.name}:worker:0`;
    const emergencySpawn = createSpawn("Spawn5", room, [emergencyConfig]);
    emergencySpawn.spawning = { name: "busy" } as Spawning;
    const workerSpawn = createSpawn("Spawn11", room, [workerConfig]);
    Object.setPrototypeOf(emergencySpawn, prototype);
    Object.setPrototypeOf(workerSpawn, prototype);
    Game.spawns = { Spawn5: emergencySpawn, Spawn11: workerSpawn };
    Memory.data!.creepConfigs = {
      [emergencyConfig]: { role: "carrier", args: [], roomName: room.name, body: Array(51).fill(CARRY) },
      [workerConfig]: { role: "worker", args: [], roomName: room.name, body: [WORK, CARRY, MOVE] },
    };

    prototype.work.call(workerSpawn);
    expect(workerSpawn.spawnCreep).toHaveBeenCalledTimes(1);

    workerSpawn.spawnCreep = jest.fn(() => OK);
    workerSpawn.memory.spawnList = [workerConfig];
    Memory.data!.creepConfigs![emergencyConfig].body = ["invalid" as BodyPartConstant];
    prototype.work.call(workerSpawn);

    expect(workerSpawn.spawnCreep).toHaveBeenCalledTimes(1);
  });

  it("does not make an authenticated RCL8 maintenance upgrader yield to war or emergency carriers", () => {
    const room = {
      name: "E4N58",
      energyAvailable: 300,
      energyCapacityAvailable: 5600,
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
    Object.setPrototypeOf(maintenanceSpawn, prototype);
    Object.setPrototypeOf(warSpawn, prototype);
    Object.setPrototypeOf(emergencySpawn, prototype);
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
});

describe("mountSpawn fixed safe exit directions", () => {
  let prototype: SpawnPrototype;

  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Object.assign(global, { StructureSpawn: function StructureSpawn() {} });
    mountSpawn();
    prototype = (global as typeof global & {
      StructureSpawn: { prototype: SpawnPrototype };
    }).StructureSpawn.prototype;
    Memory.data = { creepConfigs: {} } as Memory["data"];
    Game.spawns = {};
  });

  it.each([
    ["carrier", [CARRY, MOVE] as BodyPartConstant[]],
    ["worker", [WORK, CARRY, MOVE] as BodyPartConstant[]],
  ] as const)("locks E5N59 Spawn20 %s spawns to TOP", (role, body) => {
    const room = {
      name: "E5N59",
      energyAvailable: 1_000,
      energyCapacityAvailable: 12_900,
    } as Room;
    const configName = `${room.name}:${role}:0`;
    Memory.data!.creepConfigs = {
      [configName]: { role, args: [], roomName: room.name, body: [...body] },
    };
    const spawn = createSpawn("Spawn20", room, [configName]);
    Object.setPrototypeOf(spawn, prototype);
    Game.spawns = { Spawn20: spawn };

    prototype.work.call(spawn);

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      body,
      `${role}-${Game.time}`,
      expect.objectContaining({
        directions: [TOP],
        memory: expect.objectContaining({ role, configName }),
      }),
    );
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it.each([
    ["E5N59", "Spawn15"],
    ["E6N59", "Spawn20"],
  ])("keeps default directions for %s/%s", (roomName, spawnName) => {
    const room = {
      name: roomName,
      energyAvailable: 1_000,
      energyCapacityAvailable: 12_900,
    } as Room;
    const configName = `${room.name}:worker:0`;
    Memory.data!.creepConfigs = {
      [configName]: {
        role: "worker",
        args: [],
        roomName: room.name,
        body: [WORK, CARRY, MOVE],
      },
    };
    const spawn = createSpawn(spawnName, room, [configName]);
    Object.setPrototypeOf(spawn, prototype);
    Game.spawns = { [spawnName]: spawn };

    prototype.work.call(spawn);

    const options = (spawn.spawnCreep as jest.Mock).mock.calls[0][2] as SpawnOptions;
    expect(options).not.toHaveProperty("directions");
  });

  it("preserves Spawn20 failure recording and queue retry", () => {
    const room = {
      name: "E5N59",
      energyAvailable: 200,
      energyCapacityAvailable: 12_900,
    } as Room;
    const configName = `${room.name}:carrier:0`;
    Memory.data!.creepConfigs = {
      [configName]: {
        role: "carrier",
        args: [],
        roomName: room.name,
        body: [CARRY, CARRY, MOVE],
      },
    };
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
    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      [CARRY, CARRY, MOVE],
      `carrier-${Game.time}`,
      expect.objectContaining({ directions: [TOP] }),
    );
  });

  it("preserves successful transient config cleanup", () => {
    const room = {
      name: "E5N59",
      energyAvailable: 1_000,
      energyCapacityAvailable: 12_900,
    } as Room;
    const configName = `${room.name}:manual:maxcarrier:${Game.time}`;
    Memory.data!.creepConfigs = {
      [configName]: {
        role: "carrier",
        args: [],
        roomName: room.name,
        body: [CARRY, MOVE],
      },
    };
    const spawn = createSpawn("Spawn20", room, [configName]);
    Object.setPrototypeOf(spawn, prototype);
    Game.spawns = { Spawn20: spawn };

    prototype.work.call(spawn);

    expect(spawn.memory.spawnList).toEqual([]);
    expect(Memory.data!.creepConfigs![configName]).toBeUndefined();
    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      [CARRY, MOVE],
      `carrier-${Game.time}`,
      expect.objectContaining({ directions: [TOP] }),
    );
  });
});

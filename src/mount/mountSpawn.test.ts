jest.mock("@/runtime/tickContext", () => ({
  ...jest.requireActual("@/runtime/tickContext"),
  isSpawnActive: jest.fn(() => true),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  recordFixedCpuAction: jest.fn(),
}));

import { mountSpawn } from "@/mount/mountSpawn";

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

  it("holds a lower-priority remote spawn while another spawn has a war task at its queue head", () => {
    const room = {
      name: "E1N57",
      energyAvailable: 2_350,
      energyCapacityAvailable: 5_600,
    } as Room;
    const warConfig = "E1N57:war:E2N54:g1:healer:0";
    const remoteConfig = "E1N57:remoteMine:E1N58:harvester:source";
    Memory.data!.creepConfigs = {
      [warConfig]: {
        role: "healer",
        args: [],
        roomName: room.name,
        body: [...Array(10).fill(TOUGH), ...Array(20).fill(HEAL), ...Array(8).fill(MOVE)],
      },
      [remoteConfig]: {
        role: "harvester",
        args: [],
        roomName: room.name,
        body: [WORK, CARRY, MOVE],
      },
    };
    const warSpawn = createSpawn("Spawn5", room, [warConfig]);
    const remoteSpawn = createSpawn("Spawn11", room, [remoteConfig]);
    Object.setPrototypeOf(warSpawn, prototype);
    Object.setPrototypeOf(remoteSpawn, prototype);
    Game.spawns = { Spawn5: warSpawn, Spawn11: remoteSpawn };

    prototype.work.call(remoteSpawn);

    expect(remoteSpawn.spawnCreep).not.toHaveBeenCalled();
    expect(remoteSpawn.memory.spawnList).toEqual([remoteConfig]);
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

  it("allows a source-room carrier to spawn ahead of a waiting war task", () => {
    const room = {
      name: "E1N57",
      energyAvailable: 2_350,
      energyCapacityAvailable: 5_600,
    } as Room;
    const warConfig = "E1N57:war:E2N54:g1:healer:0";
    const carrierConfig = "E1N57:carrier:0";
    Memory.data!.creepConfigs = {
      [warConfig]: {
        role: "healer",
        args: [],
        roomName: room.name,
        body: [...Array(10).fill(TOUGH), ...Array(20).fill(HEAL), ...Array(8).fill(MOVE)],
      },
      [carrierConfig]: {
        role: "carrier",
        args: [],
        roomName: room.name,
        body: [CARRY, MOVE],
      },
    };
    const warSpawn = createSpawn("Spawn5", room, [warConfig]);
    const carrierSpawn = createSpawn("Spawn11", room, [carrierConfig]);
    Object.setPrototypeOf(warSpawn, prototype);
    Object.setPrototypeOf(carrierSpawn, prototype);
    Game.spawns = { Spawn5: warSpawn, Spawn11: carrierSpawn };

    prototype.work.call(carrierSpawn);

    expect(carrierSpawn.spawnCreep).toHaveBeenCalled();
    expect(carrierSpawn.memory.spawnList).toEqual([]);
  });

  it("holds a managed carrier until another spawn starts its queued emergency carrier", () => {
    const room = {
      name: "E1N58",
      energyAvailable: 300,
      energyCapacityAvailable: 300,
    } as Room;
    const emergencyConfig = `${room.name}:manual:maxcarrier:${Game.time}`;
    const managedConfig = `${room.name}:carrier:0`;
    Memory.data!.creepConfigs = {
      [emergencyConfig]: {
        role: "carrier",
        args: [],
        roomName: room.name,
        body: [CARRY, MOVE],
      },
      [managedConfig]: {
        role: "carrier",
        args: [],
        roomName: room.name,
        body: [CARRY, MOVE],
      },
    };
    const emergencySpawn = createSpawn("Spawn5", room, [emergencyConfig]);
    emergencySpawn.spawning = { name: "worker-busy" } as Spawning;
    const managedSpawn = createSpawn("Spawn11", room, [managedConfig]);
    Object.setPrototypeOf(emergencySpawn, prototype);
    Object.setPrototypeOf(managedSpawn, prototype);
    Game.spawns = { Spawn5: emergencySpawn, Spawn11: managedSpawn };

    prototype.work.call(managedSpawn);

    expect(managedSpawn.spawnCreep).not.toHaveBeenCalled();
    expect(managedSpawn.memory.spawnList).toEqual([managedConfig]);
  });

  it("holds worker and war tasks until another spawn starts a valid emergency carrier", () => {
    const room = { name: "E1N59", energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const emergencyConfig = `${room.name}:manual:maxcarrier:${Game.time}`;
    const workerConfig = `${room.name}:worker:0`;
    const warConfig = `${room.name}:war:E2N59:g1:healer:0`;
    Memory.data!.creepConfigs = {
      [emergencyConfig]: { role: "carrier", args: [], roomName: room.name, body: [CARRY, MOVE] },
      [workerConfig]: { role: "worker", args: [], roomName: room.name, body: [WORK, CARRY, MOVE] },
      [warConfig]: { role: "healer", args: [], roomName: room.name, body: [HEAL, MOVE] },
    };
    const emergencySpawn = createSpawn("Spawn5", room, [emergencyConfig]);
    emergencySpawn.spawning = { name: "busy" } as Spawning;
    const workerSpawn = createSpawn("Spawn11", room, [workerConfig]);
    const warSpawn = createSpawn("Spawn12", room, [warConfig]);
    Object.setPrototypeOf(emergencySpawn, prototype);
    Object.setPrototypeOf(workerSpawn, prototype);
    Object.setPrototypeOf(warSpawn, prototype);
    Game.spawns = { Spawn5: emergencySpawn, Spawn11: workerSpawn, Spawn12: warSpawn };

    prototype.work.call(workerSpawn);
    prototype.work.call(warSpawn);

    expect(workerSpawn.spawnCreep).not.toHaveBeenCalled();
    expect(warSpawn.spawnCreep).not.toHaveBeenCalled();
  });

  it("does not yield to a missing or unspawnable emergency config", () => {
    const room = { name: "E1N60", energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const emergencyConfig = `${room.name}:manual:maxcarrier:${Game.time}`;
    const workerConfig = `${room.name}:worker:0`;
    const emergencySpawn = createSpawn("Spawn5", room, [emergencyConfig]);
    emergencySpawn.spawning = { name: "busy" } as Spawning;
    const workerSpawn = createSpawn("Spawn11", room, [workerConfig]);
    Object.setPrototypeOf(emergencySpawn, prototype);
    Object.setPrototypeOf(workerSpawn, prototype);
    Game.spawns = { Spawn5: emergencySpawn, Spawn11: workerSpawn };
    Memory.data!.creepConfigs = {
      [workerConfig]: { role: "worker", args: [], roomName: room.name, body: [WORK, CARRY, MOVE] },
    };

    prototype.work.call(workerSpawn);
    expect(workerSpawn.spawnCreep).toHaveBeenCalledTimes(1);

    workerSpawn.spawnCreep = jest.fn(() => OK);
    workerSpawn.memory.spawnList = [workerConfig];
    Memory.data!.creepConfigs![emergencyConfig] = {
      role: "carrier",
      args: [],
      roomName: room.name,
      body: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE],
    };
    prototype.work.call(workerSpawn);

    expect(workerSpawn.spawnCreep).toHaveBeenCalledTimes(1);
  });

  it("holds a hub upgrader until the other spawn's waiting war task starts", () => {
    const room = {
      name: "E4N58",
      energyAvailable: 5_600,
      energyCapacityAvailable: 5_600,
    } as Room;
    const warConfig = "E4N58:war:E5N58:g1:healer:0";
    const upgraderConfig = "E4N58:hubUpgrader:0";
    Memory.data!.creepConfigs = {
      [warConfig]: {
        role: "healer",
        args: [],
        roomName: room.name,
        body: [...Array(10).fill(TOUGH), ...Array(20).fill(HEAL), ...Array(8).fill(MOVE)],
      },
      [upgraderConfig]: {
        role: "hubUpgrader",
        args: [],
        roomName: room.name,
        body: [...Array(15).fill(WORK), ...Array(5).fill(CARRY), ...Array(10).fill(MOVE)],
      },
    };
    const warSpawn = createSpawn("Spawn2", room, [warConfig]);
    const upgraderSpawn = createSpawn("Spawn10", room, [upgraderConfig]);
    Object.setPrototypeOf(warSpawn, prototype);
    Object.setPrototypeOf(upgraderSpawn, prototype);
    Game.spawns = { Spawn2: warSpawn, Spawn10: upgraderSpawn };

    prototype.work.call(upgraderSpawn);
    expect(upgraderSpawn.spawnCreep).not.toHaveBeenCalled();

    warSpawn.memory.spawnList = [];
    prototype.work.call(upgraderSpawn);
    expect(upgraderSpawn.spawnCreep).toHaveBeenCalled();
    expect(upgraderSpawn.memory.spawnList).toEqual([]);
  });
});

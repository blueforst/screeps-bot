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
});

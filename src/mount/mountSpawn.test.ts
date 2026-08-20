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

    // 孵化期间出生位被已出生 creep 占据：向其发出让路指令；
    // Spawn20 的出生位是 TOP 邻格（directions 约束），blocker 从自身
    // 周围离开且不得被推回出生格；无可用出口时不发。
    {
      const blockerMove = jest.fn(() => OK);
      const blockerPos = { x: 25, y: 25 };
      const blockerRoom = { room: undefined as unknown as Room };
      const blocker = { move: blockerMove, pos: blockerPos, get room() { return blockerRoom.room; } } as unknown as Creep;
      const makePos = (
        x: number,
        y: number,
        terrain: (x: number, y: number) => string = () => "plain",
      ) => ({
        x,
        y,
        lookFor: (type: string): unknown[] => {
          if (type === LOOK_TERRAIN) {
            return [terrain(x, y)];
          }
          if (type === LOOK_CREEPS && x === blockerPos.x && y === blockerPos.y) {
            return [blocker];
          }
          return [];
        },
      });
      const makeRoom = (name: string, terrain: (x: number, y: number) => string) =>
        ({ name, getPositionAt: (x: number, y: number) => makePos(x, y, terrain) }) as unknown as Room;
      const makeSpawningSpawn = (name: string, room: Room) =>
        ({
          name,
          room,
          spawning: { name: "incoming" },
          pos: makePos(25, 25),
          memory: { spawnList: ["queued"] },
          spawnCreep: jest.fn(),
        }) as unknown as StructureSpawn;

      // 默认 spawn：出生位 = spawn 自身格 (25,25)，TOP (25,24) 可走 → 让向 TOP。
      const openRoom = makeRoom("E1N57", () => "plain");
      blockerRoom.room = openRoom;
      const openSpawn = makeSpawningSpawn("Spawn1", openRoom);
      Object.setPrototypeOf(openSpawn, prototype);
      prototype.work.call(openSpawn);
      expect(blockerMove).toHaveBeenCalledWith(TOP);
      expect(openSpawn.spawnCreep).not.toHaveBeenCalled();

      // Spawn20：出生位 = TOP 邻格 (25,24)；blocker 站在出生位上，
      // 其 TOP (25,23) 为墙，其余邻格可走 → 让向 TOP_RIGHT（不会推回出生位）。
      blockerMove.mockClear();
      blockerPos.y = 24;
      const spawn20Room = makeRoom("E5N59", (x, y) => (y === 23 && x === 25 ? "wall" : "plain"));
      blockerRoom.room = spawn20Room;
      const spawn20 = makeSpawningSpawn("Spawn20", spawn20Room);
      Object.setPrototypeOf(spawn20, prototype);
      prototype.work.call(spawn20);
      expect(blockerMove).toHaveBeenCalledWith(TOP_RIGHT);

      // Spawn20：出生位四周全墙 → 不发指令。
      blockerMove.mockClear();
      const walledSpawn20Room = makeRoom(
        "E5N59",
        (x, y) => (y === 25 || (y === 24 && (x === 24 || x === 26)) || y === 23) ? "wall" : "plain",
      );
      blockerRoom.room = walledSpawn20Room;
      const walledSpawn20 = makeSpawningSpawn("Spawn20", walledSpawn20Room);
      Object.setPrototypeOf(walledSpawn20, prototype);
      prototype.work.call(walledSpawn20);
      expect(blockerMove).not.toHaveBeenCalled();
    }
  });
});

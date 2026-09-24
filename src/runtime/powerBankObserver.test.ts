import {
  getPowerBankVisionSnapshot,
  hasFreshObserverResult,
  runPowerBankObserver,
  runPowerBankObserverIntake,
} from "@/runtime/powerBankObserver";
import { getPowerBankRegion } from "@/runtime/powerBankRegion";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };

function createLabs(roomName: string): Structure[] {
  return Array.from({ length: 3 }, (_, index) => ({
    id: `${roomName}-lab${index}`,
    structureType: STRUCTURE_LAB,
    my: true,
  } as unknown as StructureLab));
}

function createOwnedRoom(name: string, structures: Structure[] = []): Room {
  return {
    name,
    controller: { my: true, level: 8 },
    energyCapacityAvailable: 6000,
    storage: { store: { getFreeCapacity: () => 100_000 } },
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) return structures;
      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_POWER_CREEPS) return [];
      return [];
    }),
  } as unknown as Room;
}

function createObserver(room: Room): StructureObserver {
  return {
    id: `${room.name}-observer` as Id<StructureObserver>,
    structureType: STRUCTURE_OBSERVER,
    room,
    pos: { x: 10, y: 10, roomName: room.name } as RoomPosition,
    isActive: () => true,
    observeRoom: jest.fn(() => OK),
  } as unknown as StructureObserver;
}

function createSpawn(room: Room): StructureSpawn {
  return {
    name: `${room.name}-spawn`,
    id: `${room.name}-spawn` as Id<StructureSpawn>,
    room,
    isActive: () => true,
    owner: { username: "me" },
    memory: {},
  } as unknown as StructureSpawn;
}

function resetWithMap(exits: Record<string, Record<number, string>>): void {
  delete (global as RuntimeGlobal).__runtimeServices;
  registerRuntimeServices();
  Game.time = 100;
  Game.rooms = {};
  Game.spawns = {};
  Memory.data = {};
  Memory.runtime = {};
  Game.map = {
    ...Game.map,
    describeExits: jest.fn((roomName: string) => exits[roomName] ?? null),
    getRoomStatus: jest.fn(() => ({ status: "normal" })),
    getRoomLinearDistance: jest.fn(() => 1),
    getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
  } as unknown as GameMap;
}

describe("powerBankObserver", () => {
  it("confirms only next-tick Room visibility and then advances the pending result", () => {
    resetWithMap({
      E3N59: { [FIND_EXIT_RIGHT]: "E4N59" },
      E4N59: { [FIND_EXIT_TOP]: "E4N60" },
    });
    const base = createOwnedRoom("E3N59");
    const observer = createObserver(base);
    const spawn = createSpawn(base);
    const labs = createLabs(base.name);
    (base.find as jest.Mock).mockImplementation((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) return [observer, spawn, ...labs];
      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_POWER_CREEPS) return [];
      return [];
    });
    Game.rooms[base.name] = base;
    Game.spawns[spawn.name] = spawn;

    expect(getPowerBankRegion().targets.map((target) => target.roomName)).toContain("E4N60");
    runPowerBankObserverIntake();
    runPowerBankObserver();
    runPowerBankObserver();

    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(observer.observeRoom).toHaveBeenCalledWith("E4N60");
    expect(hasFreshObserverResult("E4N60")).toBe(false);
    expect(getPowerBankVisionSnapshot().pending["E4N60"]).toMatchObject({ requestedAt: 100 });

    Game.time = 101;
    Game.rooms["E4N60"] = createOwnedRoom("E4N60");
    runPowerBankObserverIntake();

    expect(hasFreshObserverResult("E4N60")).toBe(true);
    expect(getPowerBankVisionSnapshot().pending["E4N60"]).toBeUndefined();
  });

  it("assigns a constrained room before a room reachable by both Observers", () => {
    resetWithMap({
      E3N59: { [FIND_EXIT_RIGHT]: "E4N59" },
      E4N59: { [FIND_EXIT_TOP]: "E4N60" },
      W0N59: { [FIND_EXIT_TOP]: "W0N60" },
    });
    const baseA = createOwnedRoom("E3N59");
    const baseB = createOwnedRoom("W0N59");
    const observerA = createObserver(baseA);
    const observerB = createObserver(baseB);
    const spawnA = createSpawn(baseA);
    const spawnB = createSpawn(baseB);
    for (const [room, observer, spawn] of [
      [baseA, observerA, spawnA],
      [baseB, observerB, spawnB],
    ] as const) {
      const labs = createLabs(room.name);
      (room.find as jest.Mock).mockImplementation((type: FindConstant) => {
        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) return [observer, spawn, ...labs];
        if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_POWER_CREEPS) return [];
        return [];
      });
      Game.rooms[room.name] = room;
      Game.spawns[spawn.name] = spawn;
    }
    (Game.map.getRoomLinearDistance as jest.Mock).mockImplementation((from: string, to: string) =>
      from === "E3N59" && to === "W0N60" ? 11 : 1,
    );

    runPowerBankObserverIntake();
    runPowerBankObserver();

    expect(observerB.observeRoom).toHaveBeenCalledWith("W0N60");
    expect(observerA.observeRoom).toHaveBeenCalledWith("E4N60");
    expect(observerA.observeRoom).toHaveBeenCalledTimes(1);
    expect(observerB.observeRoom).toHaveBeenCalledTimes(1);
  });

  it("does not retry a missed next-tick result in the same tick", () => {
    resetWithMap({ E3N59: { [FIND_EXIT_TOP]: "E3N60" } });
    const base = createOwnedRoom("E3N59");
    const observer = createObserver(base);
    const spawn = createSpawn(base);
    const labs = createLabs(base.name);
    (base.find as jest.Mock).mockImplementation((type: FindConstant) =>
      type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES ? [observer, spawn, ...labs] : [],
    );
    Game.rooms[base.name] = base;
    Game.spawns[spawn.name] = spawn;

    runPowerBankObserverIntake();
    runPowerBankObserver();
    Game.time = 101;
    runPowerBankObserverIntake();
    runPowerBankObserver();

    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(getPowerBankVisionSnapshot().unmet).toEqual([]);
    Game.time = 102;
    runPowerBankObserverIntake();
    runPowerBankObserver();
    expect(observer.observeRoom).toHaveBeenCalledTimes(2);
  });

  it("reports the unsatisfied target when Observer capacity is overcommitted", () => {
    resetWithMap({
      E3N59: { [FIND_EXIT_RIGHT]: "E4N59" },
      E4N59: {
        [FIND_EXIT_TOP]: "E4N60",
        [FIND_EXIT_RIGHT]: "E5N59",
      },
      E5N59: { [FIND_EXIT_TOP]: "E5N60" },
    });
    const base = createOwnedRoom("E3N59");
    const observer = createObserver(base);
    const spawn = createSpawn(base);
    const labs = createLabs(base.name);
    (base.find as jest.Mock).mockImplementation((type: FindConstant) =>
      type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES ? [observer, spawn, ...labs] : [],
    );
    Game.rooms[base.name] = base;
    Game.spawns[spawn.name] = spawn;

    runPowerBankObserverIntake();
    runPowerBankObserver();

    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(getPowerBankVisionSnapshot().unmet).toHaveLength(1);
    expect(getPowerBankVisionSnapshot().unmet[0].reason).toBe("observer_capacity");
  });

  it("retains high-priority demand at the request cap and bounds old observer IDs", () => {
    resetWithMap({ E3N59: { [FIND_EXIT_TOP]: "E3N60" } });
    const base = createOwnedRoom("E3N59");
    const observer = createObserver(base);
    const spawn = createSpawn(base);
    const labs = createLabs(base.name);
    (base.find as jest.Mock).mockImplementation((type: FindConstant) =>
      type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES ? [observer, spawn, ...labs] : [],
    );
    Game.rooms[base.name] = base;
    Game.spawns[spawn.name] = spawn;
    Memory.data = {
      powerBankHarvest: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
        `bank-${index}`,
        { status: "attacking", targetRoom: `E${index + 1}N60`, sourceRoom: base.name },
      ])),
      remoteMining: { lowPriority: { status: "active", targetRoom: "E0N60", sourceRoom: base.name } },
    } as any;
    Memory.runtime!.powerBankObserver = {
      patrolIndex: 0,
      updatedAt: Game.time,
      lastObservedRooms: [],
      coveredRooms: [],
      pending: {},
      lastVisibleAt: {},
      lastObserverVisibleAt: {},
      failures: {},
      unmet: [],
      submittedByObserver: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`old-${index}`, 1])),
    } as any;

    runPowerBankObserverIntake();
    runPowerBankObserver();

    const snapshot = getPowerBankVisionSnapshot();
    expect(observer.observeRoom).toHaveBeenCalledTimes(1);
    expect(snapshot.unmet).toHaveLength(255);
    expect(snapshot.unmet.every((item) => item.priority === 100)).toBe(true);
    const submitted = Memory.runtime!.powerBankObserver?.submittedByObserver ?? {};
    expect(Object.keys(submitted).length).toBeLessThanOrEqual(256);
    expect(submitted[observer.id]).toBe(Game.time);
  });
});

import {
  applyRoomWorkforceConstructionTierEffect,
  buildRoomWorkforceInventory,
  getDesiredWorkerCount,
  getExpectedManagedConfigNames,
  getWorkerCap,
} from "@/runtime/roomWorkforce";
import { clearWorkerTaskBoardForTest, getWorkerTasksByRoom } from "@/runtime/workerTaskPool";
import type { WorkerTask } from "@/types/system";

function createSource(id: string, roomName: string, hasLink = false): Source {
  return {
    id,
    room: { name: roomName } as Room,
    pos: {
      findInRange: () => (hasLink ? ([{ structureType: STRUCTURE_LINK }] as StructureLink[]) : []),
    } as unknown as RoomPosition,
  } as Source;
}

function createMineral(
  id: string,
  options: {
    hasExtractor?: boolean;
    hasContainer?: boolean;
    amount?: number;
  } = {},
): Mineral {
  const structures: Structure[] = [];
  if (options.hasExtractor) {
    structures.push({ structureType: STRUCTURE_EXTRACTOR } as StructureExtractor);
  }
  if (options.hasContainer) {
    structures.push({ structureType: STRUCTURE_CONTAINER } as StructureContainer);
  }

  return {
    id,
    mineralAmount: options.amount ?? 1000,
    pos: {
      findInRange: () => structures,
    } as unknown as RoomPosition,
  } as Mineral;
}

function createRoom(options: {
  name?: string;
  level?: number;
  constructionCount?: number;
  tasks?: Record<string, WorkerTask>;
  sources?: Source[];
  workerConstructionTier?: RoomMemory["workerConstructionTier"];
  minerals?: Mineral[];
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {
    workerConstructionTier: options.workerConstructionTier,
  } as RoomMemory;
  Memory.rooms[name] = memory;
  const sources = options.sources ?? [];
  const minerals = options.minerals ?? [];
  const constructionSites = Array.from({ length: options.constructionCount ?? 0 }, (_, index) => ({
    id: `site-${index}`,
  })) as ConstructionSite[];

  return {
    name,
    memory,
    controller: {
      level: options.level ?? 5,
    } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_MINERALS) {
        return minerals;
      }

      return [];
    },
  } as Room;
}

describe("roomWorkforce", () => {
  beforeEach(() => {
    clearWorkerTaskBoardForTest();
  });

  it("clamps worker cap to the supported range", () => {
    expect(getWorkerCap()).toBe(8);

    Memory.cfg = { worker: { maxPerRoom: 0 } };
    expect(getWorkerCap()).toBe(1);

    Memory.cfg = { worker: { maxPerRoom: 12 } };
    expect(getWorkerCap()).toBe(10);

    Memory.cfg = { worker: { maxPerRoom: 6 } };
    expect(getWorkerCap()).toBe(6);
  });

  it.each([
    [1, 5],
    [2, 4],
    [3, 3],
    [4, 1],
    [5, 1],
    [7, 1],
  ] as const)("uses the existing RCL %i worker baseline", (level, expected) => {
    expect(getDesiredWorkerCount(createRoom({ name: `W${level}N1`, level }))).toBe(expected);
  });

  it("uses construction hysteresis when deciding worker count", () => {
    const room = createRoom({ level: 5, constructionCount: 6 });

    expect(getDesiredWorkerCount(room)).toBe(3);
    expect(room.memory.workerConstructionTier).toBe(2);

    room.find = ((type: FindConstant) => {
      if (type === FIND_SOURCES) {
        return [];
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return Array.from({ length: 5 }, (_, index) => ({ id: `site-mid-${index}` })) as ConstructionSite[];
      }

      return [];
    }) as Room["find"];

    expect(getDesiredWorkerCount(room)).toBe(3);
    expect(room.memory.workerConstructionTier).toBe(2);

    room.find = ((type: FindConstant) => {
      if (type === FIND_SOURCES) {
        return [];
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return Array.from({ length: 4 }, (_, index) => ({ id: `site-low-${index}` })) as ConstructionSite[];
      }

      return [];
    }) as Room["find"];

    expect(getDesiredWorkerCount(room)).toBe(2);
    expect(room.memory.workerConstructionTier).toBe(1);
  });

  it.each([
    [0, 1, 1, 2],
    [1, 0, 0, 1],
    [1, 6, 2, 3],
    [2, 4, 1, 2],
    [2, 15, 3, 4],
    [3, 12, 2, 3],
  ] as const)(
    "moves construction tier %i with %i sites to tier %i and %i workers",
    (workerConstructionTier, constructionCount, expectedTier, expectedWorkers) => {
      const room = createRoom({
        name: `W${workerConstructionTier}N${constructionCount}`,
        level: 5,
        constructionCount,
        workerConstructionTier,
      });

      expect(getDesiredWorkerCount(room)).toBe(expectedWorkers);
      expect(room.memory.workerConstructionTier).toBe(expectedTier);
    },
  );

  it("adds a worker only for an active normal repair task", () => {
    const normalRepairRoom = createRoom({ level: 5 });
    const normalTasks = getWorkerTasksByRoom(normalRepairRoom.name);
    normalTasks["repair:r1"] = {
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: normalRepairRoom.name,
      priority: 320,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "normal",
    };
    expect(getDesiredWorkerCount(normalRepairRoom)).toBe(2);

    const emergencyRepairRoom = createRoom({ name: "W1N2", level: 5 });
    const emergencyTasks = getWorkerTasksByRoom(emergencyRepairRoom.name);
    emergencyTasks["repair:r2"] = {
      id: "repair:r2",
      type: "repair",
      targetId: "r2",
      roomName: emergencyRepairRoom.name,
      priority: 900,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "emergency",
    };
    expect(getDesiredWorkerCount(emergencyRepairRoom)).toBe(1);
  });

  it("caps RCL8 at one worker regardless of construction and normal repair demand", () => {
    const room = createRoom({
      name: "W8N8",
      level: 8,
      constructionCount: 20,
      workerConstructionTier: 3,
    });
    const tasks = getWorkerTasksByRoom(room.name);
    tasks["repair:r8"] = {
      id: "repair:r8",
      type: "repair",
      targetId: "r8",
      roomName: room.name,
      priority: 320,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "normal",
    };

    expect(getDesiredWorkerCount(room)).toBe(1);
    expect(room.memory.workerConstructionTier).toBe(0);
  });

  it("keeps RCL8 inventory construction pure until its exact set-zero effect is applied", () => {
    const room = createRoom({
      name: "W8N7",
      level: 8,
      constructionCount: 20,
      workerConstructionTier: 3,
    });

    const inventory = buildRoomWorkforceInventory(room);

    expect(inventory.constructionTierEffect).toEqual({ kind: "set", value: 0 });
    expect(inventory.configs.filter((config) => config.kind === "worker")).toEqual([
      {
        kind: "worker",
        configName: "W8N7:worker:0",
        role: "worker",
        args: [],
        slot: 0,
      },
    ]);
    expect(room.memory.workerConstructionTier).toBe(3);

    applyRoomWorkforceConstructionTierEffect(room, inventory.constructionTierEffect);

    expect(room.memory.workerConstructionTier).toBe(0);
  });

  it("builds managed config names from source roles, carrier, and workers", () => {
    const room = createRoom({
      level: 5,
      sources: [createSource("source-a", "W1N1"), createSource("source-b", "W1N1", true)],
      minerals: [
        createMineral("mineral-ok", { hasExtractor: true, hasContainer: true, amount: 4000 }),
        createMineral("mineral-no-container", { hasExtractor: true, hasContainer: false, amount: 4000 }),
        createMineral("mineral-empty", { hasExtractor: true, hasContainer: true, amount: 0 }),
      ],
    });

    expect(getExpectedManagedConfigNames(room)).toEqual([
      "W1N1:harvester:source-a",
      "W1N1:miner:source-b",
      "W1N1:mineralHarvester:mineral-ok",
      "W1N1:carrier:0",
      "W1N1:worker:0",
    ]);
  });

  it("builds typed config payloads without mutating construction tier", () => {
    const room = createRoom({
      level: 5,
      constructionCount: 6,
      workerConstructionTier: 1,
      sources: [createSource("source-a", "W1N1"), createSource("source-b", "W1N1", true)],
      minerals: [createMineral("mineral-a", { hasExtractor: true, hasContainer: true, amount: 4000 })],
    });

    const inventory = buildRoomWorkforceInventory(room);

    expect(room.memory.workerConstructionTier).toBe(1);
    expect(inventory.constructionTierEffect).toEqual({ kind: "set", value: 2 });
    expect(
      inventory.configs.map(({ kind, configName, role, args }) => ({ kind, configName, role, args })),
    ).toEqual([
      { kind: "source", configName: "W1N1:harvester:source-a", role: "harvester", args: ["source-a"] },
      { kind: "source", configName: "W1N1:miner:source-b", role: "miner", args: ["source-b"] },
      {
        kind: "mineral",
        configName: "W1N1:mineralHarvester:mineral-a",
        role: "mineralHarvester",
        args: ["mineral-a"],
      },
      { kind: "carrier", configName: "W1N1:carrier:0", role: "carrier", args: [] },
      { kind: "worker", configName: "W1N1:worker:0", role: "worker", args: [] },
      { kind: "worker", configName: "W1N1:worker:1", role: "worker", args: [] },
      { kind: "worker", configName: "W1N1:worker:2", role: "worker", args: [] },
    ]);
    expect(inventory.configs[0]).toMatchObject({
      kind: "source",
      deprecatedConfigName: "W1N1:miner:source-a",
    });

    applyRoomWorkforceConstructionTierEffect(room, inventory.constructionTierEffect);
    expect(room.memory.workerConstructionTier).toBe(2);
  });

  it("returns a preserve effect for Reserve without mutating or recalculating tier", () => {
    const room = createRoom({
      name: "W1N6",
      level: 5,
      constructionCount: 20,
      workerConstructionTier: 3,
    });
    Game.flags.RESERVE_W1N6 = {
      name: "RESERVE_W1N6",
      pos: { roomName: room.name } as RoomPosition,
    } as Flag;

    const inventory = buildRoomWorkforceInventory(room);

    expect(inventory.constructionTierEffect).toEqual({ kind: "preserve" });
    expect(inventory.configs.some((config) => config.kind === "worker")).toBe(false);
    expect(room.memory.workerConstructionTier).toBe(3);
  });

  it("does not cache inventories across task-board observations in the same tick", () => {
    const room = createRoom({ name: "W2N2", level: 5 });

    const beforeRepair = buildRoomWorkforceInventory(room);
    const tasks = getWorkerTasksByRoom(room.name);
    tasks["repair:r1"] = {
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: room.name,
      priority: 320,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "normal",
    };
    const afterRepair = buildRoomWorkforceInventory(room);

    expect(afterRepair).not.toBe(beforeRepair);
    expect(beforeRepair.configs.filter((config) => config.kind === "worker")).toHaveLength(1);
    expect(afterRepair.configs.filter((config) => config.kind === "worker")).toHaveLength(2);
  });

  it("keeps two carriers through rcl4 before reducing to one at rcl5", () => {
    const rcl3Room = createRoom({ name: "W1N3", level: 3, sources: [createSource("source-a", "W1N3")] });
    const rcl4Room = createRoom({ name: "W1N4", level: 4, sources: [createSource("source-a", "W1N4")] });
    const rcl5Room = createRoom({ name: "W1N5", level: 5, sources: [createSource("source-a", "W1N5")] });

    expect(getExpectedManagedConfigNames(rcl3Room)).toEqual([
      "W1N3:harvester:source-a",
      "W1N3:carrier:0",
      "W1N3:carrier:1",
      "W1N3:worker:0",
      "W1N3:worker:1",
      "W1N3:worker:2",
    ]);

    expect(getExpectedManagedConfigNames(rcl4Room)).toEqual([
      "W1N4:harvester:source-a",
      "W1N4:carrier:0",
      "W1N4:carrier:1",
      "W1N4:worker:0",
    ]);

    expect(getExpectedManagedConfigNames(rcl5Room)).toEqual([
      "W1N5:harvester:source-a",
      "W1N5:carrier:0",
      "W1N5:worker:0",
    ]);
  });

  it.each(["RESERVE", "RESERVE_W1N6"])("keeps construction tier and omits workers under %s", (flagName) => {
    const room = createRoom({
      name: "W1N6",
      level: 5,
      constructionCount: 20,
      workerConstructionTier: 3,
      sources: [createSource("source-a", "W1N6")],
    });
    Game.flags[flagName] = {
      name: flagName,
      pos: { roomName: room.name } as RoomPosition,
    } as Flag;

    expect(getExpectedManagedConfigNames(room)).toEqual([
      "W1N6:harvester:source-a",
      "W1N6:carrier:0",
    ]);
    expect(room.memory.workerConstructionTier).toBe(3);
  });
});

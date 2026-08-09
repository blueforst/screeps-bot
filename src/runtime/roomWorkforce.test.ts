import { getDesiredWorkerCount, getExpectedManagedConfigNames, getWorkerCap } from "@/runtime/roomWorkforce";
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
});

import { getDesiredWorkerCount, getExpectedManagedConfigNames, getWorkerCap } from "@/runtime/roomWorkforce";

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
  tasks?: RoomMemory["tasks"];
  sources?: Source[];
  workerConstructionTier?: RoomMemory["workerConstructionTier"];
  minerals?: Mineral[];
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = (Memory.rooms[name] = {
    workerConstructionTier: options.workerConstructionTier,
    tasks: options.tasks,
  } as RoomMemory);
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
  it("clamps worker cap to the supported range", () => {
    expect(getWorkerCap()).toBe(8);

    Memory.cfg = { worker: { maxPerRoom: 0 } };
    expect(getWorkerCap()).toBe(1);

    Memory.cfg = { worker: { maxPerRoom: 12 } };
    expect(getWorkerCap()).toBe(10);

    Memory.cfg = { worker: { maxPerRoom: 6 } };
    expect(getWorkerCap()).toBe(6);
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

  it("adds a worker only for active normal repair tasks", () => {
    const normalRepairRoom = createRoom({
      level: 5,
      tasks: {
        "repair:r1": {
          id: "repair:r1",
          type: "repair",
          targetId: "r1",
          roomName: "W1N1",
          priority: 320,
          assignedCreeps: [],
          maxAssignees: 1,
          status: "active",
          updatedAt: Game.time,
          repairMode: "normal",
        },
      },
    });
    expect(getDesiredWorkerCount(normalRepairRoom)).toBe(2);

    const emergencyRepairRoom = createRoom({
      name: "W1N2",
      level: 5,
      tasks: {
        "repair:r2": {
          id: "repair:r2",
          type: "repair",
          targetId: "r2",
          roomName: "W1N2",
          priority: 900,
          assignedCreeps: [],
          maxAssignees: 1,
          status: "active",
          updatedAt: Game.time,
          repairMode: "emergency",
        },
      },
    });
    expect(getDesiredWorkerCount(emergencyRepairRoom)).toBe(1);
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
});

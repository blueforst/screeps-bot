import { bootstrapRooms } from "@/runtime/bootstrap";
import { getCreepConfigService } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createSource(id: string, roomName: string, hasLink = false): Source {
  return {
    id,
    room: { name: roomName } as Room,
    pos: {
      findInRange: () => (hasLink ? ([{ structureType: STRUCTURE_LINK }] as StructureLink[]) : []),
      findClosestByRange: (targets: StructureLink[]) => targets[0] || null,
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
  sources?: Source[];
  minerals?: Mineral[];
  constructionCount?: number;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  const sources = options.sources ?? [];
  const minerals = options.minerals ?? [];
  const structures = options.structures ?? [];
  const constructionSites = options.constructionSites ?? Array.from({ length: options.constructionCount ?? 0 }, (_, index) => ({
    id: `site-${index}`,
  })) as ConstructionSite[];

  return {
    name,
    memory,
    controller: {
      my: true,
      level: options.level ?? 5,
    } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      if (type === FIND_MINERALS) {
        return minerals;
      }

      return [];
    },
  } as Room;
}

function createSpawn(room: Room, queue: string[] = []): StructureSpawn {
  return {
    room,
    memory: {
      spawnList: [...queue],
    },
  } as StructureSpawn;
}

function createOwnedStructure(structureType: StructureConstant): Structure {
  return {
    structureType,
    my: true,
  } as unknown as Structure;
}

function createConstructionSite(structureType: BuildableStructureConstant): ConstructionSite {
  return {
    structureType,
    my: true,
  } as ConstructionSite;
}

function createRoomPlannerEntry(layout: Record<string, { x: number; y: number }[]>) {
  return {
    layout,
    timestamp: "test-plan",
    savedAt: Game.time,
  };
}

describe("bootstrapRooms", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("removes stale source, mineral, and worker configs when no live creep still references them", () => {
    const room = createRoom({
      sources: [createSource("source-a", "W1N1")],
      minerals: [createMineral("mineral-a", { hasExtractor: true, hasContainer: true, amount: 500 })],
    });
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = createSpawn(room);
    Memory.data = {
      creepConfigs: {
        "W1N1:harvester:source-a": { role: "harvester", args: ["source-a"], roomName: "W1N1" },
        "W1N1:harvester:stale": { role: "harvester", args: ["stale"], roomName: "W1N1" },
        "W1N1:mineralHarvester:mineral-a": {
          role: "mineralHarvester",
          args: ["mineral-a"],
          roomName: "W1N1",
        },
        "W1N1:mineralHarvester:stale": {
          role: "mineralHarvester",
          args: ["stale"],
          roomName: "W1N1",
        },
        "W1N1:worker:0": { role: "worker", args: [], roomName: "W1N1" },
        "W1N1:worker:9": { role: "worker", args: [], roomName: "W1N1" },
      },
    } as Memory["data"];

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:stale")).toBeUndefined();
    expect(getCreepConfigService().get("W1N1:mineralHarvester:stale")).toBeUndefined();
    expect(getCreepConfigService().get("W1N1:worker:9")).toBeUndefined();
    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toBeDefined();
    expect(getCreepConfigService().get("W1N1:mineralHarvester:mineral-a")).toBeDefined();
    expect(getCreepConfigService().get("W1N1:worker:0")).toBeDefined();
  });

  it("orphans a live surplus RCL8 worker and removes its queued replacement", () => {
    const room = createRoom({
      name: "W8N8",
      level: 8,
      constructionCount: 20,
    });
    const spawn = createSpawn(room, ["W8N8:worker:1", "manual:keep"]);
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = spawn;
    Memory.data = {
      creepConfigs: {
        "W8N8:worker:0": { role: "worker", args: [], roomName: "W8N8" },
        "W8N8:worker:1": { role: "worker", args: [], roomName: "W8N8" },
      },
    } as Memory["data"];
    Game.creeps.workerLive = {
      name: "workerLive",
      room,
      memory: {
        role: "worker",
        configName: "W8N8:worker:1",
      },
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    bootstrapRooms();

    expect(getCreepConfigService().get("W8N8:worker:0")?.roomName).toBe("W8N8");
    expect(getCreepConfigService().get("W8N8:worker:1")?.roomName).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["manual:keep"]);
    expect(Game.creeps.workerLive.suicide).not.toHaveBeenCalled();
  });

  it("removes an orphaned stale harvester config after the live creep is gone", () => {
    const room = createRoom({
      sources: [createSource("source-a", "W1N1", true)],
    });
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = createSpawn(room);
    Memory.data = {
      creepConfigs: {
        "W1N1:harvester:source-a": { role: "harvester", args: ["source-a"] },
        "W1N1:miner:source-a": { role: "miner", args: ["source-a"], roomName: "W1N1" },
      },
    } as Memory["data"];

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toBeUndefined();
    expect(getCreepConfigService().get("W1N1:miner:source-a")).toMatchObject({
      role: "miner",
      args: ["source-a"],
      roomName: "W1N1",
    });
  });

  it("creates local harvesters for managed colonies after rcl3 extensions are complete", () => {
    const room = createRoom({
      name: "W1N1",
      level: 3,
      sources: [createSource("source-a", "W1N1")],
      structures: Array.from({ length: 10 }, () => createOwnedStructure(STRUCTURE_EXTENSION)),
    });
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = createSpawn(room);
    Memory.data = {
      colonization: {
        W1N1: {
          targetRoom: "W1N1",
          sourceRoom: "W9N9",
          status: "managed",
          flagName: "CL",
          planReady: true,
          claimCompleted: true,
          scoutSafe: true,
          dangerousRooms: [],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
      roomPlanner: {
        W1N1: createRoomPlannerEntry({
          [STRUCTURE_EXTENSION]: Array.from({ length: 10 }, (_, index) => ({ x: 10 + index, y: 10 })),
        }),
      },
    } as unknown as Memory["data"];

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toMatchObject({
      role: "harvester",
      args: ["source-a"],
      roomName: "W1N1",
    });
  });
});

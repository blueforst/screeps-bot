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

function createRoom(options: {
  name?: string;
  level?: number;
  sources?: Source[];
  constructionCount?: number;
  tasks?: RoomMemory["tasks"];
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = (Memory.rooms[name] = {
    tasks: options.tasks,
  } as RoomMemory);
  const sources = options.sources ?? [];
  const constructionSites = Array.from({ length: options.constructionCount ?? 0 }, (_, index) => ({
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

describe("bootstrapRooms", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("upserts managed configs and removes stale source queue entries", () => {
    const room = createRoom({
      sources: [createSource("source-a", "W1N1"), createSource("source-b", "W1N1", true)],
    });
    const spawn = createSpawn(room, ["W1N1:harvester:old", "W1N1:miner:source-b", "manual:keep"]);
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = spawn;

    bootstrapRooms();

    expect(getCreepConfigService().list()).toMatchObject({
      "W1N1:harvester:source-a": { role: "harvester", args: ["source-a"], roomName: "W1N1" },
      "W1N1:miner:source-b": { role: "miner", args: ["source-b"], roomName: "W1N1" },
      "W1N1:carrier:0": { role: "carrier", args: [], roomName: "W1N1" },
      "W1N1:worker:0": { role: "worker", args: [], roomName: "W1N1" },
    });
    expect(spawn.memory.spawnList).toEqual(["W1N1:miner:source-b", "manual:keep"]);
  });

  it("removes stale source and worker configs when no live creep still references them", () => {
    const room = createRoom({
      sources: [createSource("source-a", "W1N1")],
    });
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = createSpawn(room);
    Memory.data = {
      creepConfigs: {
        "W1N1:harvester:source-a": { role: "harvester", args: ["source-a"], roomName: "W1N1" },
        "W1N1:harvester:stale": { role: "harvester", args: ["stale"], roomName: "W1N1" },
        "W1N1:worker:0": { role: "worker", args: [], roomName: "W1N1" },
        "W1N1:worker:9": { role: "worker", args: [], roomName: "W1N1" },
      },
    } as Memory["data"];

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:stale")).toBeUndefined();
    expect(getCreepConfigService().get("W1N1:worker:9")).toBeUndefined();
    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toBeDefined();
    expect(getCreepConfigService().get("W1N1:worker:0")).toBeDefined();
  });

  it("keeps stale configs that are still referenced by live creeps", () => {
    const room = createRoom({
      sources: [createSource("source-a", "W1N1")],
    });
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = createSpawn(room);
    Memory.data = {
      creepConfigs: {
        "W1N1:harvester:source-a": { role: "harvester", args: ["source-a"], roomName: "W1N1" },
        "W1N1:harvester:stale": { role: "harvester", args: ["stale"], roomName: "W1N1" },
        "W1N1:worker:0": { role: "worker", args: [], roomName: "W1N1" },
        "W1N1:worker:9": { role: "worker", args: [], roomName: "W1N1" },
      },
    } as Memory["data"];
    Game.creeps.workerLive = {
      name: "workerLive",
      room,
      memory: {
        configName: "W1N1:worker:9",
      },
    } as Creep;
    Game.creeps.harvesterLive = {
      name: "harvesterLive",
      room,
      memory: {
        configName: "W1N1:harvester:stale",
      },
    } as Creep;

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:stale")).toBeDefined();
    expect(getCreepConfigService().get("W1N1:worker:9")).toBeDefined();
  });
});

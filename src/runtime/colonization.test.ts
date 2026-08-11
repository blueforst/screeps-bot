jest.mock("@/modules/autoplanner", () => ({
  runPlannerForRoom: jest.fn(() => false),
  savePlannerForRoom: jest.fn(() => false),
}));

jest.mock("@/runtime/warControl", () => ({
  clearWarRoomTask: jest.fn(),
  isWarRoomClearDone: jest.fn(() => false),
  requestWarRoomClear: jest.fn(),
}));

jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

import { runColonizationByFlag } from "@/runtime/colonization";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { clearWarRoomTask, requestWarRoomClear } from "@/runtime/warControl";

const { runPlannerForRoom } = jest.requireMock("@/modules/autoplanner") as {
  runPlannerForRoom: jest.Mock;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createSourceRoom(name: string): Room {
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  return {
    name,
    memory,
    energyCapacityAvailable: 1000,
    controller: {
      my: true,
      level: 5,
    } as StructureController,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createSource(id: string): Source {
  return { id } as Source;
}

function createTargetRoom(
  name: string,
  options: {
    my?: boolean;
    level?: number;
    sources?: Source[];
    structures?: Structure[];
    constructionSites?: ConstructionSite[];
  } = {},
): Room {
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  const sources = options.sources ?? [];
  const structures = options.structures ?? [];
  const constructionSites = options.constructionSites ?? [];
  return {
    name,
    memory,
    controller: {
      my: options.my ?? false,
      level: options.level,
      reservation: options.my
        ? undefined
        : {
            username: "Invader",
          },
    } as StructureController,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }
      return [];
    }),
  } as unknown as Room;
}

function createSpawn(room: Room): StructureSpawn {
  return {
    room,
    pos: {} as RoomPosition,
    owner: {
      username: "me",
    } as Owner,
    memory: {
      spawnList: [],
    },
    isActive: jest.fn(() => true),
    addTask: jest.fn(),
  } as unknown as StructureSpawn;
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

function createScout(sourceRoom: string, targetRoom: Room, name = "scout1"): Creep {
  const configName = `${sourceRoom}:colonize:${targetRoom.name}:scout:0`;
  const memory = {
    role: "scout",
    configName,
    scoutVisitedRooms: [sourceRoom, targetRoom.name],
  } as CreepMemory;

  Memory.creeps[name] = memory;

  return {
    name,
    room: targetRoom,
    owner: {
      username: "me",
    } as Owner,
    memory,
  } as Creep;
}

describe("runColonizationByFlag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time += 1;
    Memory.data = undefined;
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    Object.assign(Game, {
      map: {
        getRoomLinearDistance: jest.fn(() => 1),
        getRoomStatus: jest.fn(() => ({ status: "normal" })),
        findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
        describeExits: jest.fn((roomName: string) => {
          if (roomName === "W1N1") {
            return { [RIGHT]: "W1N2" };
          }
          if (roomName === "W1N2") {
            return { [LEFT]: "W1N1" };
          }
          return null;
        }),
      },
    });

    Object.assign(global, {
      RoomPosition: MockRoomPosition,
      PathFinder: {
        search: jest.fn(() => ({ incomplete: false, path: [{}, {}] })),
        CostMatrix: class {},
      },
    });
  });

  it("reuses a failed safe-route lookup within the same tick", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const spawn = createSpawn(sourceRoom);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: "W1N2",
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    (Game.map.findRoute as jest.Mock).mockReturnValue(ERR_NO_PATH);
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "claiming",
          flagName: "CL",
          planReady: false,
          claimCompleted: false,
          scoutSafe: false,
          scoutRouteRooms: ["W1N1", "W9N9", "W1N2"],
          dangerousRooms: [],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(Game.map.findRoute).toHaveBeenCalledTimes(1);
  });

  it("creates and queues a scout even before a fixed safe route is found", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const spawn = createSpawn(sourceRoom);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: "W1N2",
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    (Game.map.findRoute as jest.Mock).mockReturnValue(ERR_NO_PATH);

    runColonizationByFlag();

    expect(getCreepConfigService().get("W1N1:colonize:W1N2:scout:0")).toMatchObject({
      role: "scout",
      roomName: "W1N1",
      args: ["W1N2", ""],
      body: [MOVE],
    });
    expect(spawn.memory.spawnList).toContain("W1N1:colonize:W1N2:scout:0");
  });

  it("detaches colonization configs immediately when the flag is removed while creeps are alive", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const spawn = createSpawn(sourceRoom);
    const workerConfigName = "W1N1:colonize:W1N2:worker:0";
    const workerMemory = {
      role: "colonizerWorker",
      configName: workerConfigName,
    } as CreepMemory;
    const workerSuicide = jest.fn(() => OK);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.flags = {};
    spawn.memory.spawnList = [workerConfigName];
    Memory.creeps.colonizerWorker = workerMemory;
    Game.creeps.colonizerWorker = {
      name: "colonizerWorker",
      room: sourceRoom,
      memory: workerMemory,
      owner: {
        username: "me",
      } as Owner,
      suicide: workerSuicide,
    } as unknown as Creep;
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "bootstrapping",
          flagName: "CL",
          planReady: true,
          claimCompleted: true,
          scoutSafe: true,
          scoutRouteRooms: ["W1N1", "W1N2"],
          dangerousRooms: [],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
      creepConfigs: {
        [workerConfigName]: {
          role: "colonizerWorker",
          args: ["W1N2", "W1N1|W1N2"],
          roomName: "W1N1",
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(workerSuicide).toHaveBeenCalledTimes(1);
    expect(spawn.memory.spawnList).not.toContain(workerConfigName);
    expect(getCreepConfigService().get(workerConfigName)?.roomName).toBeUndefined();

    delete Game.creeps.colonizerWorker;
    delete Memory.creeps.colonizerWorker;
    Game.time += 1;

    runColonizationByFlag();

    expect(getCreepConfigService().get(workerConfigName)).toBeUndefined();
    expect(Memory.data?.colonization?.W1N2).toBeUndefined();
  });

  it("purges an owned War workflow when a clearing colonization is abandoned", () => {
    Game.flags = {};
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "clearing",
          flagName: "CL",
          planReady: false,
          claimCompleted: false,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(clearWarRoomTask).toHaveBeenCalledWith("W1N2");
  });

  it("purges the old War workflow before changing the colonization source room", () => {
    const oldSource = createSourceRoom("W1N1");
    const nextSource = createSourceRoom("W2N1");
    Game.rooms = { W1N1: oldSource, W2N1: nextSource };
    Game.spawns = {
      Spawn1: createSpawn(oldSource),
      Spawn2: createSpawn(nextSource),
    };
    Game.flags = {
      CL_W2N1: {
        name: "CL_W2N1",
        pos: { roomName: "W1N2" } as RoomPosition,
        remove: jest.fn(),
      } as unknown as Flag,
    };
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "clearing",
          flagName: "CL_W2N1",
          planReady: false,
          claimCompleted: false,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(clearWarRoomTask).toHaveBeenCalledWith("W1N2");
    expect(Memory.data?.colonization?.W1N2?.sourceRoom).toBe("W2N1");
  });

  it("purges the War workflow while defense mode pauses a clearing colonization", () => {
    const sourceRoom = createSourceRoom("W1N1");
    Game.rooms = { W1N1: sourceRoom };
    Game.spawns = { Spawn1: createSpawn(sourceRoom) };
    Game.flags = {
      CL: {
        name: "CL",
        pos: { roomName: "W1N2" } as RoomPosition,
        remove: jest.fn(),
      } as unknown as Flag,
    };
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "clearing",
          flagName: "CL",
          planReady: false,
          claimCompleted: false,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    (isDefenseMode as jest.Mock).mockReturnValue(true);

    runColonizationByFlag();

    expect(clearWarRoomTask).toHaveBeenCalledWith("W1N2");
  });

});

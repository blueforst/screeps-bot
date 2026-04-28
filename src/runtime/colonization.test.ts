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
import { requestWarRoomClear } from "@/runtime/warControl";

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

  it("keeps reservation-only target rooms on the normal claimer path", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const targetRoom = createTargetRoom("W1N2");
    const spawn = createSpawn(sourceRoom);
    const scout = createScout(sourceRoom.name, targetRoom);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = spawn;
    Game.creeps[scout.name] = scout;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    runColonizationByFlag();

    expect(requestWarRoomClear).not.toHaveBeenCalled();
    expect(getCreepConfigService().get("W1N1:colonize:W1N2:claimer:0")).toMatchObject({
      role: "claimer",
      roomName: "W1N1",
      args: ["W1N2", "W1N1|W1N2"],
    });
    expect(Memory.data?.colonization?.W1N2?.mode).toBe("normal");
    expect(Memory.data?.colonization?.W1N2?.status).toBe("claiming");
  });

  it("preserves exact preferred source room flags", () => {
    const sourceRoomA = createSourceRoom("W1N1");
    const sourceRoomB = createSourceRoom("W3N3");
    const targetRoom = createTargetRoom("W1N2");
    const spawnA = createSpawn(sourceRoomA);
    const spawnB = createSpawn(sourceRoomB);
    const scout = createScout(sourceRoomB.name, targetRoom);

    Game.rooms[sourceRoomA.name] = sourceRoomA;
    Game.rooms[sourceRoomB.name] = sourceRoomB;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = spawnA;
    Game.spawns.Spawn2 = spawnB;
    Game.creeps[scout.name] = scout;
    Game.flags.CL_W3N3 = {
      name: "CL_W3N3",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    runColonizationByFlag();

    expect(getCreepConfigService().get("W3N3:colonize:W1N2:claimer:0")).toMatchObject({
      role: "claimer",
      roomName: "W3N3",
      args: ["W1N2", "W3N3|W1N2"],
    });
  });

  it("supports wildcard-style colonization flag suffixes for shared source rooms", () => {
    const sourceRoomA = createSourceRoom("W1N1");
    const sourceRoomB = createSourceRoom("W3N3");
    const targetRoom = createTargetRoom("W1N2");
    const spawnA = createSpawn(sourceRoomA);
    const spawnB = createSpawn(sourceRoomB);
    const scout = createScout(sourceRoomB.name, targetRoom);

    Game.rooms[sourceRoomA.name] = sourceRoomA;
    Game.rooms[sourceRoomB.name] = sourceRoomB;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = spawnA;
    Game.spawns.Spawn2 = spawnB;
    Game.creeps[scout.name] = scout;
    Game.flags.CL_W3N3_batch1 = {
      name: "CL_W3N3_batch1",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    runColonizationByFlag();

    expect(getCreepConfigService().get("W3N3:colonize:W1N2:claimer:0")).toMatchObject({
      role: "claimer",
      roomName: "W3N3",
      args: ["W1N2", "W3N3|W1N2"],
    });
  });

  it("accepts attached suffixes after the preferred source room prefix", () => {
    const sourceRoomA = createSourceRoom("W1N1");
    const sourceRoomB = createSourceRoom("W3N3");
    const targetRoom = createTargetRoom("W1N2");
    const spawnA = createSpawn(sourceRoomA);
    const spawnB = createSpawn(sourceRoomB);
    const scout = createScout(sourceRoomB.name, targetRoom);

    Game.rooms[sourceRoomA.name] = sourceRoomA;
    Game.rooms[sourceRoomB.name] = sourceRoomB;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = spawnA;
    Game.spawns.Spawn2 = spawnB;
    Game.creeps[scout.name] = scout;
    Game.flags.CL_W3N3shared = {
      name: "CL_W3N3shared",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    runColonizationByFlag();

    expect(getCreepConfigService().get("W3N3:colonize:W1N2:claimer:0")).toMatchObject({
      role: "claimer",
      roomName: "W3N3",
      args: ["W1N2", "W3N3|W1N2"],
    });
  });

  it("marks the task claimed on a later tick after reservation clearing succeeds", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const targetRoom = createTargetRoom("W1N2");
    const spawn = createSpawn(sourceRoom);
    const scout = createScout(sourceRoom.name, targetRoom);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = spawn;
    Game.creeps[scout.name] = scout;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    runColonizationByFlag();

    targetRoom.controller = {
      my: true,
      level: 1,
    } as StructureController;
    Game.time += 1;

    runColonizationByFlag();

    expect(Memory.data?.colonization?.W1N2?.claimCompleted).toBe(true);
    expect(Memory.data?.colonization?.W1N2?.status).toBe("waiting_plan");
    expect(getCreepConfigService().get("W1N1:colonize:W1N2:claimer:0")).toBeUndefined();
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

  it("throttles repeated failed safe-route retries across ticks while target stays unseen", () => {
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
          safeRouteRetryAt: Game.time + 10,
          safeRouteRetryKey: "W1N1->W1N2:",
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];

    runColonizationByFlag();
    expect(Game.map.findRoute).not.toHaveBeenCalled();

    Game.time += 9;
    runColonizationByFlag();
    expect(Game.map.findRoute).not.toHaveBeenCalled();

    Game.time += 1;
    runColonizationByFlag();
    expect(Game.map.findRoute).toHaveBeenCalledTimes(1);
  });

  it("does not assign a source room that is currently in defense mode", () => {
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
    (isDefenseMode as jest.Mock).mockImplementation((roomName: string) => roomName === sourceRoom.name);

    runColonizationByFlag();

    expect(Memory.data?.colonization).toEqual({});
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

  it("throttles repeated planner retries when plan generation fails", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const targetRoom = createTargetRoom("W1N2");
    const spawn = createSpawn(sourceRoom);
    const scout = createScout(sourceRoom.name, targetRoom);

    targetRoom.controller = {
      my: true,
      level: 1,
    } as StructureController;

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = spawn;
    Game.creeps[scout.name] = scout;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    runPlannerForRoom.mockReturnValue(false);

    runColonizationByFlag();
    expect(runPlannerForRoom).toHaveBeenCalledTimes(1);

    Game.time += 1;
    runColonizationByFlag();
    expect(runPlannerForRoom).toHaveBeenCalledTimes(1);

    Game.time += 49;
    runColonizationByFlag();
    expect(runPlannerForRoom).toHaveBeenCalledTimes(2);
  });

  it("keeps mother-room harvesters assigned at RCL3 until local source workers are ready", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const targetRoom = createTargetRoom("W1N2", {
      my: true,
      level: 3,
      sources: [createSource("source-a")],
    });
    const sourceSpawn = createSpawn(sourceRoom);
    const targetSpawn = createSpawn(targetRoom);
    const externalHarvesterConfigName = "W1N1:colonize:W1N2:harvester:source-a";
    const flagRemove = jest.fn();

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = sourceSpawn;
    Game.spawns.Spawn2 = targetSpawn;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: flagRemove,
    } as unknown as Flag;
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
        [externalHarvesterConfigName]: {
          role: "colonizerHarvester",
          args: ["W1N2", "source-a", "W1N1|W1N2"],
          roomName: "W1N1",
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(getCreepConfigService().get(externalHarvesterConfigName)?.roomName).toBe("W1N1");
    expect(Memory.data?.colonization?.W1N2?.status).toBe("managed");
    expect(flagRemove).not.toHaveBeenCalled();
  });

  it("does not retire mother-room harvesters at RCL3 before extensions are complete", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const targetRoom = createTargetRoom("W1N2", {
      my: true,
      level: 3,
      sources: [createSource("source-a")],
      structures: Array.from({ length: 9 }, () => createOwnedStructure(STRUCTURE_EXTENSION)),
      constructionSites: [createConstructionSite(STRUCTURE_EXTENSION)],
    });
    const sourceSpawn = createSpawn(sourceRoom);
    const targetSpawn = createSpawn(targetRoom);
    const externalHarvesterConfigName = "W1N1:colonize:W1N2:harvester:source-a";
    const localHarvesterConfigName = "W1N2:harvester:source-a";
    const externalHarvesterSuicide = jest.fn(() => OK);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = sourceSpawn;
    Game.spawns.Spawn2 = targetSpawn;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;
    Memory.creeps.externalHarvester = {
      role: "colonizerHarvester",
      configName: externalHarvesterConfigName,
    } as CreepMemory;
    Game.creeps.externalHarvester = {
      name: "externalHarvester",
      room: targetRoom,
      memory: Memory.creeps.externalHarvester,
      owner: {
        username: "me",
      } as Owner,
      suicide: externalHarvesterSuicide,
    } as unknown as Creep;
    Memory.creeps.localHarvester = {
      role: "harvester",
      configName: localHarvesterConfigName,
    } as CreepMemory;
    Game.creeps.localHarvester = {
      name: "localHarvester",
      room: targetRoom,
      memory: Memory.creeps.localHarvester,
      owner: {
        username: "me",
      } as Owner,
    } as Creep;
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "managed",
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
        [externalHarvesterConfigName]: {
          role: "colonizerHarvester",
          args: ["W1N2", "source-a", "W1N1|W1N2"],
          roomName: "W1N1",
        },
        [localHarvesterConfigName]: {
          role: "harvester",
          args: ["source-a"],
          roomName: "W1N2",
        },
      },
      roomPlanner: {
        W1N2: createRoomPlannerEntry({
          [STRUCTURE_EXTENSION]: Array.from({ length: 10 }, (_, index) => ({ x: 10 + index, y: 10 })),
        }),
      },
    } as unknown as Memory["data"];

    runColonizationByFlag();

    expect(externalHarvesterSuicide).not.toHaveBeenCalled();
    expect(getCreepConfigService().get(externalHarvesterConfigName)?.roomName).toBe("W1N1");
    expect(Memory.data?.colonization?.W1N2?.status).toBe("managed");
  });

  it("cleans mother-room harvester configs at RCL3 after local source workers take over", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const targetRoom = createTargetRoom("W1N2", {
      my: true,
      level: 3,
      sources: [createSource("source-a")],
      structures: Array.from({ length: 10 }, () => createOwnedStructure(STRUCTURE_EXTENSION)),
    });
    const sourceSpawn = createSpawn(sourceRoom);
    const targetSpawn = createSpawn(targetRoom);
    const externalHarvesterConfigName = "W1N1:colonize:W1N2:harvester:source-a";
    const localHarvesterConfigName = "W1N2:harvester:source-a";
    const flagRemove = jest.fn();
    const externalHarvesterMemory = {
      role: "colonizerHarvester",
      configName: externalHarvesterConfigName,
    } as CreepMemory;
    const externalHarvesterSuicide = jest.fn(() => {
      delete Game.creeps.externalHarvester;
      delete Memory.creeps.externalHarvester;
      return OK;
    });

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    Game.spawns.Spawn1 = sourceSpawn;
    Game.spawns.Spawn2 = targetSpawn;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: targetRoom.name,
      } as RoomPosition,
      remove: flagRemove,
    } as unknown as Flag;
    Memory.creeps.externalHarvester = externalHarvesterMemory;
    Game.creeps.externalHarvester = {
      name: "externalHarvester",
      room: targetRoom,
      memory: externalHarvesterMemory,
      owner: {
        username: "me",
      } as Owner,
      suicide: externalHarvesterSuicide,
    } as unknown as Creep;
    Memory.creeps.localHarvester = {
      role: "harvester",
      configName: localHarvesterConfigName,
    } as CreepMemory;
    Game.creeps.localHarvester = {
      name: "localHarvester",
      room: targetRoom,
      memory: Memory.creeps.localHarvester,
      owner: {
        username: "me",
      } as Owner,
    } as Creep;
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "managed",
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
        [externalHarvesterConfigName]: {
          role: "colonizerHarvester",
          args: ["W1N2", "source-a", "W1N1|W1N2"],
          roomName: "W1N1",
        },
        [localHarvesterConfigName]: {
          role: "harvester",
          args: ["source-a"],
          roomName: "W1N2",
        },
      },
      roomPlanner: {
        W1N2: createRoomPlannerEntry({
          [STRUCTURE_EXTENSION]: Array.from({ length: 10 }, (_, index) => ({ x: 10 + index, y: 10 })),
        }),
      },
    } as unknown as Memory["data"];

    runColonizationByFlag();

    expect(externalHarvesterSuicide).toHaveBeenCalledTimes(1);
    expect(getCreepConfigService().get(externalHarvesterConfigName)).toBeUndefined();
    expect(Memory.data?.colonization?.W1N2).toBeUndefined();
    expect(flagRemove).toHaveBeenCalledTimes(1);
  });

});

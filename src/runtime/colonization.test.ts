jest.mock("@/modules/autoplanner", () => ({
  runPlannerForRoom: jest.fn(() => false),
  savePlannerForRoom: jest.fn(() => false),
}));

jest.mock("@/runtime/warControl", () => ({
  clearWarRoomTask: jest.fn(),
  isWarRoomClearDone: jest.fn(() => false),
  requestWarRoomClear: jest.fn(),
}));

import { runColonizationByFlag } from "@/runtime/colonization";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { requestWarRoomClear } from "@/runtime/warControl";

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

function createTargetRoom(name: string): Room {
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  return {
    name,
    memory,
    controller: {
      my: false,
      reservation: {
        username: "Invader",
      },
    } as StructureController,
    find: jest.fn((type: FindConstant) => {
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

});

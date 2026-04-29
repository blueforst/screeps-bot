import { runFlagHaulingByFlag } from "@/runtime/flagHauling";
import { getCreepConfigService } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    energyCapacityAvailable: 1600,
    find: () => [],
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

function createSpawn(room: Room): StructureSpawn {
  const spawn = {
    name: `${room.name}-spawn`,
    room,
    memory: {},
    isActive: () => true,
  } as unknown as StructureSpawn;
  Game.spawns[spawn.name] = spawn;
  return spawn;
}

function createFlag(name: string, roomName: string): Flag {
  return {
    name,
    pos: { x: 25, y: 25, roomName } as RoomPosition,
    remove: jest.fn(() => OK),
  } as unknown as Flag;
}

describe("runFlagHaulingByFlag", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
    Game.flags = {};
    Game.rooms = {};
    Game.spawns = {};
    Memory.data = {};
    Memory.creeps = {};
    (Game as Game & { map: GameMap }).map = {
      getRoomLinearDistance: (left: string, right: string) => (left === right ? 0 : 10),
    } as GameMap;
  });

  it("creates a max-body remote carrier config from the nearest home room", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    Game.flags.HAUL = createFlag("HAUL", "W5N5");

    runFlagHaulingByFlag();

    const configs = getCreepConfigService().list("W1N1:haul:W5N5:carrier:HAUL");
    const config = configs["W1N1:haul:W5N5:carrier:HAUL"];
    expect(config).toMatchObject({
      role: "remoteCarrier",
      args: ["W5N5", "25", "25"],
      roomName: "W1N1",
    });
    expect(config.body).toHaveLength(32);
  });

  it("honors a room suffix source override", () => {
    const near = createRoom("W1N1");
    const preferred = createRoom("W2N2");
    createSpawn(near);
    createSpawn(preferred);
    Game.flags.HAUL_W2N2_batch = createFlag("HAUL_W2N2_batch", "W5N5");

    runFlagHaulingByFlag();

    expect(getCreepConfigService().get("W2N2:haul:W5N5:carrier:HAUL_W2N2_batch")?.roomName).toBe("W2N2");
  });

  it("does not spawn a remote carrier when the flag room is owned", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    Game.flags.HAUL = createFlag("HAUL", home.name);

    runFlagHaulingByFlag();

    expect(getCreepConfigService().list()).toEqual({});
  });

  it("removes the flag and cleans up config when the visible target has no haul resources", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    const target = {
      name: "W5N5",
      controller: undefined,
      find: jest.fn(() => []),
    } as unknown as Room;
    Game.rooms[target.name] = target;
    const flag = createFlag("HAUL", target.name);
    Game.flags.HAUL = flag;

    runFlagHaulingByFlag();

    expect(flag.remove).toHaveBeenCalledTimes(1);
    expect(getCreepConfigService().list()).toEqual({});
    expect(Memory.data?.flagHauling).toEqual({});
  });
});

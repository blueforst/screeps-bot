import { getPowerBankRegion, invalidatePowerBankRegion, isPowerBankHighwayRoom } from "@/runtime/powerBankRegion";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };

function createBase(roomName: string): { room: Room; spawn: StructureSpawn } {
  const labs = Array.from({ length: 3 }, (_, index) => ({
    id: `${roomName}-lab${index}`,
    structureType: STRUCTURE_LAB,
    my: true,
  } as unknown as StructureLab));
  const room = {
    name: roomName,
    controller: { my: true, level: 8 },
    energyCapacityAvailable: 6000,
    storage: { store: { getFreeCapacity: () => 100_000 } },
    find: jest.fn((type: FindConstant) =>
      type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES ? labs : [],
    ),
  } as unknown as Room;
  const spawn = {
    id: `${roomName}-spawn` as Id<StructureSpawn>,
    room,
    isActive: () => true,
  } as unknown as StructureSpawn;
  return { room, spawn };
}

function reset(exits: Record<string, Record<number, string>>): void {
  delete (global as RuntimeGlobal).__runtimeServices;
  registerRuntimeServices();
  Game.time = 500;
  Game.rooms = {};
  Game.spawns = {};
  Memory.runtime = {};
  Memory.data = {};
  Game.map = {
    ...Game.map,
    describeExits: jest.fn((roomName: string) => exits[roomName] ?? null),
    getRoomStatus: jest.fn(() => ({ status: "normal" })),
  } as unknown as GameMap;
}

describe("powerBankRegion", () => {
  it("recognizes highway coordinates on both sides of zero and sector boundaries", () => {
    expect(isPowerBankHighwayRoom("E0N7")).toBe(true);
    expect(isPowerBankHighwayRoom("E10N9")).toBe(true);
    expect(isPowerBankHighwayRoom("W9N4")).toBe(true);
    expect(isPowerBankHighwayRoom("E3S9")).toBe(true);
    expect(isPowerBankHighwayRoom("W0N3")).toBe(false);
    expect(isPowerBankHighwayRoom("E3N7")).toBe(false);
  });

  it("walks across room-coordinate boundaries through a non-highway room", () => {
    reset({
      E9N9: { [FIND_EXIT_RIGHT]: "E10N9" },
      E10N9: { [FIND_EXIT_TOP]: "E10N10" },
    });
    const { room, spawn } = createBase("E9N9");
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;

    const region = getPowerBankRegion();
    const target = region.targets.find((item) => item.roomName === "E10N10");

    expect(target?.bases[0]).toMatchObject({
      sourceRoom: "E9N9",
      distance: 2,
      rooms: ["E9N9", "E10N9", "E10N10"],
      confidence: "terrain-only",
    });
  });

  it("crosses the E/W zero boundary and keeps expired danger as unconfirmed risk", () => {
    reset({
      E0N59: { [FIND_EXIT_LEFT]: "W0N59" },
      W0N59: { [FIND_EXIT_TOP]: "W0N60" },
    });
    const { room, spawn } = createBase("E0N59");
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.runtime!.transitDangerRooms = { "W0N59": Game.time - 1 };

    const target = getPowerBankRegion().targets.find((item) => item.roomName === "W0N60");

    expect(target?.bases[0]).toMatchObject({
      sourceRoom: "E0N59",
      rooms: ["E0N59", "W0N59", "W0N60"],
      confidence: "known-risk",
    });
  });

  it("does not route through a currently dangerous or restricted room", () => {
    reset({
      E3N59: { [FIND_EXIT_RIGHT]: "E4N59" },
      E4N59: { [FIND_EXIT_TOP]: "E4N60" },
    });
    const { room, spawn } = createBase("E3N59");
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    Memory.runtime!.transitDangerRooms = { "E4N59": Game.time + 50 };

    expect(getPowerBankRegion().targets.some((item) => item.roomName === "E4N60")).toBe(false);

    Memory.runtime!.transitDangerRooms = {};
    invalidatePowerBankRegion();
    (Game.map.getRoomStatus as jest.Mock).mockImplementation((roomName: string) =>
      roomName === "E4N59" ? { status: "closed" } : { status: "normal" },
    );
    Game.time += 1;
    expect(getPowerBankRegion().targets.some((item) => item.roomName === "E4N60")).toBe(false);
  });
});

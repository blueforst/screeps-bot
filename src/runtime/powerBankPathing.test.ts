import { derivePowerBankTierProfile } from "@/runtime/powerBankViability";
import { estimatePathTravelTicks, planPowerBankTravel } from "@/runtime/powerBankPathing";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
type TestPosition = Pick<RoomPosition, "x" | "y" | "roomName">;

class MockRoomPosition {
  constructor(public x: number, public y: number, public roomName: string) {}
}

function reset(): void {
  Object.assign(global, { RoomPosition: MockRoomPosition });
  delete (global as RuntimeGlobal).__runtimeServices;
  registerRuntimeServices();
  Game.time = 100;
  Game.rooms = {};
  Game.spawns = {};
  Memory.runtime = {};
  Memory.data = {};
  Game.map = {
    ...Game.map,
    getRoomStatus: jest.fn(() => ({ status: "normal" })),
    getRoomTerrain: jest.fn((roomName: string) => ({
      get: (x: number, y: number) => roomName === "E4N60" && x === 2 && y === 2
        ? TERRAIN_MASK_SWAMP
        : 0,
    })),
  } as unknown as GameMap;
}

function createSource(): { room: Room; spawn: StructureSpawn } {
  const room = {
    name: "E3N59",
    storage: { pos: { x: 25, y: 25, roomName: "E3N59" }, store: { getFreeCapacity: () => 100_000 } },
    terminal: null,
    find: jest.fn(() => []),
  } as unknown as Room;
  const spawn = {
    id: "spawn" as Id<StructureSpawn>,
    room,
    pos: { x: 24, y: 25, roomName: "E3N59" } as RoomPosition,
    isActive: () => true,
  } as unknown as StructureSpawn;
  return { room, spawn };
}

function mockSearch(results: Array<{ path: TestPosition[]; incomplete: boolean; ops: number }>): void {
  (global as typeof global & { PathFinder: unknown }).PathFinder = {
    search: jest.fn(() => results.shift() ?? { path: [], incomplete: false, ops: 1 }),
  };
}

describe("powerBankPathing", () => {
  it("uses actual body weight, terrain and road tiles for travel ETA", () => {
    reset();
    const path: TestPosition[] = [
      { x: 1, y: 1, roomName: "E4N60" },
      { x: 2, y: 2, roomName: "E4N60" },
    ];
    const roads = new Map([["E4N60", new Set(["1:1"])]]);
    const combatBody = [MOVE, MOVE, ATTACK, ATTACK] as BodyPartConstant[];
    const haulerBody = [CARRY, CARRY, MOVE] as BodyPartConstant[];

    expect(estimatePathTravelTicks(path, combatBody, false, roads)).toBe(6);
    expect(estimatePathTravelTicks(path, haulerBody, false, roads)).toBe(2);
    expect(estimatePathTravelTicks(path, haulerBody, true, roads)).toBe(11);
  });

  it("rejects an incomplete search even when it returns a non-empty partial path", () => {
    reset();
    const { room, spawn } = createSource();
    Game.rooms[room.name] = room;
    Game.rooms.E4N60 = { name: "E4N60", find: jest.fn(() => []) } as unknown as Room;
    Game.spawns[spawn.name] = spawn;
    mockSearch([{ path: [{ x: 20, y: 20, roomName: "E4N60" }], incomplete: true, ops: 6000 }]);

    const result = planPowerBankTravel({
      sourceRoom: room,
      targetRoom: "E4N60",
      bankPos: { x: 21, y: 20 },
      routeRooms: ["E3N59", "E4N60"],
      profile: derivePowerBankTierProfile(6)!,
      energyCapacity: 2500,
    });

    expect(result.status).toBe("ops_exhausted");
    expect(result.combatPath).toEqual([]);
  });

  it("computes separate combat, empty-hauler and loaded-return timing from complete paths", () => {
    reset();
    const { room, spawn } = createSource();
    Game.rooms[room.name] = room;
    Game.rooms.E4N60 = { name: "E4N60", find: jest.fn(() => []) } as unknown as Room;
    Game.spawns[spawn.name] = spawn;
    mockSearch([
      { path: [{ x: 2, y: 2, roomName: "E4N60" }], incomplete: false, ops: 100 },
      { path: [{ x: 2, y: 2, roomName: "E4N60" }], incomplete: false, ops: 100 },
      { path: [
        { x: 2, y: 2, roomName: "E4N60" },
        { x: 25, y: 25, roomName: "E3N59" },
      ], incomplete: false, ops: 100 },
    ]);

    const result = planPowerBankTravel({
      sourceRoom: room,
      targetRoom: "E4N60",
      bankPos: { x: 3, y: 2 },
      routeRooms: ["E3N59", "E4N60"],
      profile: derivePowerBankTierProfile(6)!,
      energyCapacity: 2500,
    });

    expect(result.status).toBe("complete");
    expect(result.combatTravelTicks).toBe(5);
    expect(result.haulerOutboundTravelTicks).toBe(1);
    expect(result.haulerReturnTravelTicks).toBe(6);
    expect(result.confidence).toBe("observed");
    expect(result.routeRooms).toEqual(["E3N59", "E4N60"]);
  });
});

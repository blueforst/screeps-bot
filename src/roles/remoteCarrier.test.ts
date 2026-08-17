import { remoteCarrierRole } from "@/roles/remoteCarrier";
import { moveToTargetRoom } from "@/roles/shared";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  Game.time += 1;
  Game.rooms = {};
  Memory.data = undefined;
  clearMarketActionArbiterForTest();
  clearMarketSaleExposureReservationsForTest();
  (Game as Game & { map: GameMap }).map = {
    getRoomLinearDistance: jest.fn(() => 1),
    findRoute: jest.fn(() => [{ room: "W4N5", exit: FIND_EXIT_LEFT }] as ReturnType<GameMap["findRoute"]>),
  } as unknown as GameMap;
  (global as typeof global & { RoomPosition: typeof RoomPosition }).RoomPosition = class RoomPositionMock {
    public constructor(
      public x: number,
      public y: number,
      public roomName: string,
    ) {}
  } as typeof RoomPosition;
  (global as typeof global & { PathFinder: typeof PathFinder }).PathFinder = {
    search: jest.fn(() => ({
      path: Array.from({ length: 42 }, (_, index) => ({ x: index % 50, y: 25, roomName: "W5N5" })),
      ops: 42,
      cost: 42,
      incomplete: false,
    })),
  } as unknown as typeof PathFinder;
});

function createStore(resources: Partial<Record<ResourceConstant, number>>, capacity = 800): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: (resource?: ResourceConstant) => {
      if (resource === undefined) {
        return Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
      }

      return resources[resource] || 0;
    },
    getFreeCapacity: () => capacity - Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0),
  } as unknown as StoreDefinition;
}



function createHomeRoom(name: string, storageX = 10, storageY = 20): Room {
  const room = {
    name,
    storage: {
      pos: { x: storageX, y: storageY, roomName: name } as RoomPosition,
      store: createStore({}, 100000),
    } as StructureStorage,
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

describe("remoteCarrierRole", () => {

  it("leaves home when lifetime can cover a round trip plus buffer", () => {
    const home = createHomeRoom("W1N1", 11, 20);
    const creep = {
      name: "remote-carrier-1",
      ticksToLive: 134,
      room: home,
      memory: { configName: "W1N1:haul:W5N7:carrier:HAUL" },
      store: createStore({}, 800),
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    const prepared = remoteCarrierRole("W5N7").prepare?.(creep);

    expect(creep.suicide).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W5N7", undefined, { travelRange: 3, reusePath: 10 });
    expect(prepared).toBe(false);
  });

  it("does not suicide while returning with carried resources", () => {
    const creep = {
      name: "remote-carrier-1",
      ticksToLive: 1,
      room: { name: "W5N5" } as Room,
      memory: { configName: "W1N1:haul:W5N5:carrier:HAUL" },
      store: createStore({ [RESOURCE_CATALYZED_UTRIUM_ACID]: 800 }, 800),
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    const delivered = remoteCarrierRole("W5N5").target?.(creep);

    expect(creep.suicide).not.toHaveBeenCalled();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N1", undefined, { travelRange: 3, reusePath: 10 });
    expect(delivered).toBe(false);
  });
});

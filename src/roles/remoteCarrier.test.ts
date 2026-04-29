import { remoteCarrierRole } from "@/roles/remoteCarrier";

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

beforeEach(() => {
  Game.rooms = {};
  (Game as Game & { map: GameMap }).map = {
    findRoute: jest.fn(() => [{ room: "W4N5", exit: FIND_EXIT_LEFT }] as ReturnType<GameMap["findRoute"]>),
  } as unknown as GameMap;
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

function createRoom(name: string, target: AnyStoreStructure): Room {
  return {
    name,
    find: jest.fn((type: FindConstant) => (type === FIND_STRUCTURES ? [target] : [])),
  } as unknown as Room;
}

function createRemoteContainer(amount: number): AnyStoreStructure {
  return {
    id: "remote-container",
    structureType: STRUCTURE_CONTAINER,
    pos: { getRangeTo: () => 1 } as unknown as RoomPosition,
    store: createStore({ [RESOURCE_CATALYZED_UTRIUM_ACID]: amount }, 2000),
  } as unknown as AnyStoreStructure;
}

describe("remoteCarrierRole", () => {
  it("stays in source mode after a partial withdraw", () => {
    const target = createRemoteContainer(1000);
    const room = createRoom("W5N5", target);
    let carried = 0;
    const creep = {
      name: "remote-carrier-1",
      room,
      memory: {},
      pos: { getRangeTo: () => 1 } as unknown as RoomPosition,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return carried;
          }

          return resource === RESOURCE_CATALYZED_UTRIUM_ACID ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 100;
        return OK;
      }),
    } as unknown as Creep;

    const shouldReturnHome = remoteCarrierRole("W5N5").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(target, RESOURCE_CATALYZED_UTRIUM_ACID);
    expect(shouldReturnHome).toBe(false);
  });

  it("returns home after a withdraw fills its carry store", () => {
    const target = createRemoteContainer(1000);
    const room = createRoom("W5N5", target);
    let carried = 0;
    const creep = {
      name: "remote-carrier-1",
      room,
      memory: {},
      pos: { getRangeTo: () => 1 } as unknown as RoomPosition,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return carried;
          }

          return resource === RESOURCE_CATALYZED_UTRIUM_ACID ? carried : 0;
        },
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => {
        carried = 800;
        return OK;
      }),
    } as unknown as Creep;

    const shouldReturnHome = remoteCarrierRole("W5N5").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(target, RESOURCE_CATALYZED_UTRIUM_ACID);
    expect(shouldReturnHome).toBe(true);
  });

  it("suicides after returning when remaining lifetime is below route estimate buffer", () => {
    const creep = {
      name: "remote-carrier-1",
      ticksToLive: 99,
      room: { name: "W5N5" } as Room,
      memory: { configName: "W1N1:haul:W5N5:carrier:HAUL" },
      store: createStore({ [RESOURCE_CATALYZED_UTRIUM_ACID]: 800 }, 800),
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    const delivered = remoteCarrierRole("W5N5").target?.(creep);

    expect(creep.suicide).toHaveBeenCalledTimes(1);
    expect(delivered).toBe(false);
  });

  it("keeps returning home when lifetime can cover the route estimate buffer", () => {
    const creep = {
      name: "remote-carrier-1",
      ticksToLive: 100,
      room: { name: "W5N5" } as Room,
      memory: { configName: "W1N1:haul:W5N5:carrier:HAUL" },
      store: createStore({ [RESOURCE_CATALYZED_UTRIUM_ACID]: 800 }, 800),
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    const delivered = remoteCarrierRole("W5N5").target?.(creep);

    expect(creep.suicide).not.toHaveBeenCalled();
    expect(delivered).toBe(false);
  });
});

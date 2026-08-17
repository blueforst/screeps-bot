import { POWER_BANK_PATROL_ROOMS } from "@/runtime/powerBankConstants";
import { runPowerBankObserver, hasPowerBankObserverCoverage } from "@/runtime/powerBankObserver";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createOwnedRoom(name: string, structures: Structure[] = []): Room {
  return {
    name,
    controller: { my: true, level: 8 } as StructureController,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) return structures;
      return [];
    }),
  } as unknown as Room;
}


function createObserver(room: Room): StructureObserver {
  return {
    id: `${room.name}-observer` as Id<StructureObserver>,
    structureType: STRUCTURE_OBSERVER,
    room,
    pos: { x: 10, y: 10, roomName: room.name } as RoomPosition,
    isActive: () => true,
    observeRoom: jest.fn(() => OK),
  } as unknown as StructureObserver;
}


describe("powerBankObserver", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Game.rooms = {};
    Memory.data = {};
    Memory.runtime = {};
    Game.map = {
      ...Game.map,
      getRoomLinearDistance: jest.fn(() => 1),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
    } as unknown as GameMap;
  });

  it("schedules observer patrol rooms round-robin", () => {
    const ownedRoom = createOwnedRoom("E3N59");
    const observer = createObserver(ownedRoom);
    (ownedRoom.find as jest.Mock).mockImplementation((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) return [observer];
      return [];
    });
    Game.rooms[ownedRoom.name] = ownedRoom;

    runPowerBankObserver();
    runPowerBankObserver();

    expect(observer.observeRoom).toHaveBeenNthCalledWith(1, POWER_BANK_PATROL_ROOMS[0]);
    expect(observer.observeRoom).toHaveBeenNthCalledWith(2, POWER_BANK_PATROL_ROOMS[1]);
    expect(Memory.runtime?.powerBankObserver?.lastObservedRooms).toEqual([POWER_BANK_PATROL_ROOMS[1]]);
  });

  it("reports full coverage only when observers can reach every patrol room", () => {
    const ownedRoom = createOwnedRoom("E3N59");
    const observer = createObserver(ownedRoom);
    (ownedRoom.find as jest.Mock).mockImplementation((type: FindConstant) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) return [observer];
      return [];
    });
    Game.rooms[ownedRoom.name] = ownedRoom;
    (Game.map.getRoomLinearDistance as jest.Mock).mockImplementation((_from: string, to: string) =>
      to === POWER_BANK_PATROL_ROOMS[0] ? 11 : 1,
    );

    expect(hasPowerBankObserverCoverage()).toBe(false);

    (Game.map.getRoomLinearDistance as jest.Mock).mockReturnValue(1);
    resetRuntimeServices();
    registerRuntimeServices();

    expect(hasPowerBankObserverCoverage()).toBe(true);
  });
});

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

function createObservedRoom(name: string, structures: Structure[] = []): Room {
  return {
    name,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_STRUCTURES) return structures;
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

function createPowerBank(roomName: string): StructurePowerBank {
  return {
    id: "bank-0" as Id<StructurePowerBank>,
    structureType: STRUCTURE_POWER_BANK,
    pos: { x: 25, y: 25, roomName } as RoomPosition,
    hits: 2_000_000,
    power: 5000,
    ticksToDecay: 5000,
  } as unknown as StructurePowerBank;
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

  it("scans visible patrol rooms and records power bank discoveries", () => {
    const ownedRoom = createOwnedRoom("E3N59");
    const bank = createPowerBank("E3N60");
    Game.rooms[ownedRoom.name] = ownedRoom;
    Game.rooms.E3N60 = createObservedRoom("E3N60", [bank as unknown as Structure]);

    runPowerBankObserver();

    expect(Memory.data?.powerBankHarvest?.[bank.id]).toMatchObject({
      id: bank.id,
      status: "discovered",
      targetRoom: "E3N60",
      hits: 2_000_000,
      power: 5000,
    });
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

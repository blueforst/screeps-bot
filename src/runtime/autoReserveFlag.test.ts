import { runAutoReserveFlags } from "@/runtime/autoReserveFlag";

function createRoom(name: string, storageEnergy: number, level = 4, terminalEnergy = 0): Room {
  const storage = {
    pos: { x: 20, y: 20, roomName: name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? storageEnergy : 0,
    },
  } as unknown as StructureStorage;
  const room = {
    name,
    controller: { my: true, level } as StructureController,
    storage,
    terminal: {
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? terminalEnergy : 0,
      },
    } as unknown as StructureTerminal,
    createFlag: jest.fn((_pos: RoomPosition, flagName?: string) => flagName || name),
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

function createAutoFlag(room: Room, x = 20, y = 20): Flag {
  const flag = {
    name: `RESERVE_${room.name}`,
    pos: { x, y, roomName: room.name },
    remove: jest.fn(() => OK),
    setPosition: jest.fn(() => OK),
  } as unknown as Flag;
  Game.flags[flag.name] = flag;
  return flag;
}

function setRoomPolicy(roomName: string, energyFloor: number, energyTarget: number): void {
  Memory.cfg = {
    resourceControl: {
      rooms: {
        [roomName]: { energyFloor, energyTarget },
      },
    },
  };
}

describe("runAutoReserveFlags", () => {
  beforeEach(() => {
    Game.rooms = {};
    Game.flags = {};
    Memory.cfg = {};
  });

  it("creates the auto reserve flag below the room's configured energyFloor", () => {
    const room = createRoom("W1N1", 74_999);
    setRoomPolicy(room.name, 75_000, 110_000);
    runAutoReserveFlags();
    expect(room.createFlag).toHaveBeenCalledWith(room.storage?.pos, "RESERVE_W1N1");
  });

  it("does not create the auto reserve flag at the configured energyFloor", () => {
    const room = createRoom("W1N2", 40_000);
    setRoomPolicy(room.name, 40_000, 60_000);
    runAutoReserveFlags();
    expect(room.createFlag).not.toHaveBeenCalled();
  });

  it("keeps the auto reserve flag below the configured energyTarget", () => {
    const room = createRoom("W1N3", 90_000);
    setRoomPolicy(room.name, 60_000, 100_000);
    const flag = createAutoFlag(room);
    runAutoReserveFlags();
    expect(flag.remove).not.toHaveBeenCalled();
  });

  it("removes the auto reserve flag at the configured energyTarget", () => {
    const room = createRoom("W1N4", 60_000);
    setRoomPolicy(room.name, 40_000, 60_000);
    const flag = createAutoFlag(room);
    runAutoReserveFlags();
    expect(flag.remove).toHaveBeenCalled();
  });

  it("uses storage energy only when entering worker reserve mode", () => {
    const room = createRoom("W1N5", 90_000, 4, 250_000);
    setRoomPolicy(room.name, 100_000, 150_000);
    runAutoReserveFlags();
    expect(room.createFlag).toHaveBeenCalledWith(room.storage?.pos, "RESERVE_W1N5");
  });

  it("does not manage a room before storage is built", () => {
    const room = createRoom("W1N6", 10_000);
    delete (room as Room & { storage?: StructureStorage }).storage;
    runAutoReserveFlags();
    expect(room.createFlag).not.toHaveBeenCalled();
  });

  it("moves an existing auto reserve flag back to storage while below floor", () => {
    const room = createRoom("W1N7", 10_000);
    setRoomPolicy(room.name, 100_000, 150_000);
    const flag = createAutoFlag(room, 10, 10);
    runAutoReserveFlags();
    expect(flag.setPosition).toHaveBeenCalledWith(room.storage?.pos);
    expect(room.createFlag).not.toHaveBeenCalled();
  });
});

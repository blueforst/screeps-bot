import { runAutoReserveFlags } from "@/runtime/autoReserveFlag";

function createRoom(name: string, energy: number, level = 4): Room {
  const storage = {
    pos: { x: 20, y: 20, roomName: name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_ENERGY ? energy : 0,
    },
  } as unknown as StructureStorage;

  const room = {
    name,
    controller: { my: true, level } as StructureController,
    storage,
    createFlag: jest.fn((_pos: RoomPosition, flagName?: string) => flagName || name),
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

describe("runAutoReserveFlags", () => {
  beforeEach(() => {
    Game.rooms = {};
    Game.flags = {};
  });

  it("creates a room-suffixed reserve flag at storage when energy is critical", () => {
    const room = createRoom("W1N1", 49_999);

    runAutoReserveFlags();

    expect(room.createFlag).toHaveBeenCalledWith(room.storage?.pos, "RESERVE_W1N1");
  });

  it("does not create a reserve flag before storage is built", () => {
    const room = createRoom("W1N2", 10_000);
    delete (room as Room & { storage?: StructureStorage }).storage;

    runAutoReserveFlags();

    expect(room.createFlag).not.toHaveBeenCalled();
  });

  it("keeps the reserve flag during the recovery hysteresis band", () => {
    const room = createRoom("W1N3", 70_000);
    const flag = {
      name: "RESERVE_W1N3",
      pos: { x: 20, y: 20, roomName: room.name },
      remove: jest.fn(() => OK),
      setPosition: jest.fn(() => OK),
    } as unknown as Flag;
    Game.flags.RESERVE_W1N3 = flag;

    runAutoReserveFlags();

    expect(flag.remove).not.toHaveBeenCalled();
    expect(room.createFlag).not.toHaveBeenCalled();
  });

  it("removes the auto reserve flag after energy recovers safely", () => {
    const room = createRoom("W1N4", 80_000);
    const flag = {
      name: "RESERVE_W1N4",
      pos: { x: 20, y: 20, roomName: room.name },
      remove: jest.fn(() => OK),
      setPosition: jest.fn(() => OK),
    } as unknown as Flag;
    Game.flags.RESERVE_W1N4 = flag;

    runAutoReserveFlags();

    expect(flag.remove).toHaveBeenCalled();
  });

  it("moves an existing auto reserve flag back to storage while critical", () => {
    const room = createRoom("W1N5", 10_000);
    const flag = {
      name: "RESERVE_W1N5",
      pos: { x: 10, y: 10, roomName: room.name },
      remove: jest.fn(() => OK),
      setPosition: jest.fn(() => OK),
    } as unknown as Flag;
    Game.flags.RESERVE_W1N5 = flag;

    runAutoReserveFlags();

    expect(flag.setPosition).toHaveBeenCalledWith(room.storage?.pos);
    expect(room.createFlag).not.toHaveBeenCalled();
  });
});

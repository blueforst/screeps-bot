import { runHubByFlag } from "@/runtime/hubFlag";

function createOwnedRoom(name: string): Room {
  return {
    name,
    controller: { my: true, level: 7 } as StructureController,
  } as unknown as Room;
}

function createNonOwnedRoom(name: string): Room {
  return {
    name,
    controller: { my: false, level: 0 } as StructureController,
  } as unknown as Room;
}

function createFlag(name: string, roomName: string): Flag {
  return {
    name,
    pos: { x: 25, y: 25, roomName } as RoomPosition,
    remove: jest.fn(() => OK),
  } as unknown as Flag;
}

describe("runHubByFlag", () => {
  beforeEach(() => {
    Game.flags = {};
    Game.rooms = {};
    Memory.cfg = {};
    Memory.runtime = {};
  });

  it("owned visible room: flag consumed, hubRoomName written, needsPlan=true", () => {
    const room = createOwnedRoom("W1N1");
    Game.rooms["W1N1"] = room;
    const flag = createFlag("HUB", "W1N1");
    Game.flags["HUB"] = flag;

    runHubByFlag();

    expect(flag.remove).toHaveBeenCalledTimes(1);
    expect(Memory.cfg?.hub?.enabled).toBe(true);
    expect(Memory.cfg?.hub?.hubRoomName).toBe("W1N1");
    expect(Memory.runtime?.hub?.needsPlan).toBe(true);
  });

  it("non-owned room: flag NOT consumed, status=blocked", () => {
    const room = createNonOwnedRoom("W1N1");
    Game.rooms["W1N1"] = room;
    const flag = createFlag("HUB", "W1N1");
    Game.flags["HUB"] = flag;

    runHubByFlag();

    expect(flag.remove).not.toHaveBeenCalled();
    expect(Memory.runtime?.hub?.status).toBe("blocked");
    expect(Memory.cfg?.hub?.enabled).toBeFalsy();
  });

  it("invisible room (not in Game.rooms): flag NOT consumed, status=blocked", () => {
    const flag = createFlag("HUB", "W1N1");
    Game.flags["HUB"] = flag;
    // No room in Game.rooms

    runHubByFlag();

    expect(flag.remove).not.toHaveBeenCalled();
    expect(Memory.runtime?.hub?.status).toBe("blocked");
    expect(Memory.cfg?.hub?.enabled).toBeFalsy();
  });

  it("already configured hub in different room: flag NOT consumed, status=blocked", () => {
    const room = createOwnedRoom("W2N2");
    Game.rooms["W2N2"] = room;
    const flag = createFlag("HUB", "W2N2");
    Game.flags["HUB"] = flag;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
      },
    };

    runHubByFlag();

    expect(flag.remove).not.toHaveBeenCalled();
    expect(Memory.runtime?.hub?.status).toBe("blocked");
    // hubRoomName should remain unchanged
    expect(Memory.cfg?.hub?.hubRoomName).toBe("W1N1");
  });

  it("flag in same room as already-configured hub: re-applies defaults (idempotent), flag consumed", () => {
    const room = createOwnedRoom("W1N1");
    Game.rooms["W1N1"] = room;
    const flag = createFlag("HUB", "W1N1");
    Game.flags["HUB"] = flag;

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        reservePerRoom: 9999,
      },
    };

    runHubByFlag();

    expect(flag.remove).toHaveBeenCalledTimes(1);
    expect(Memory.cfg?.hub?.enabled).toBe(true);
    expect(Memory.cfg?.hub?.hubRoomName).toBe("W1N1");
    // User override preserved
    expect(Memory.cfg?.hub?.reservePerRoom).toBe(9999);
    expect(Memory.runtime?.hub?.needsPlan).toBe(true);
  });
});

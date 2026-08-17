import { runHubByFlag } from "@/runtime/hubFlag";

function createOwnedRoom(name: string): Room {
  return {
    name,
    controller: { my: true, level: 7 } as StructureController,
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

  it("no HUB flag present: complete no-op, memory untouched", () => {
    Memory.cfg = {};
    Memory.runtime = {};

    runHubByFlag();

    expect(Memory.cfg.hub).toBeUndefined();
    expect(Memory.runtime.hub).toBeUndefined();
  });
});

import { DEFAULT_ROOM_TYPE, getRoomType, isOwnedManagedRoom, isRoomType } from "@/runtime/roomTypes";

describe("roomTypes", () => {
  it("defaults rooms to normal when no explicit type is configured", () => {
    expect(getRoomType("W1N1")).toBe(DEFAULT_ROOM_TYPE);
    expect(isOwnedManagedRoom("W1N1")).toBe(true);
  });

  it("reads explicit room type from Memory.cfg.rooms", () => {
    Memory.cfg = {
      rooms: {
        W1N1: { type: "industrial" },
        W2N2: { type: "reserved" },
      },
    };

    expect(getRoomType("W1N1")).toBe("industrial");
    expect(getRoomType("W2N2")).toBe("reserved");
    expect(isOwnedManagedRoom("W1N1")).toBe(true);
    expect(isOwnedManagedRoom("W2N2")).toBe(false);
  });

  it("falls back to normal for invalid runtime values", () => {
    Memory.cfg = {
      rooms: {
        W1N1: {},
      },
    };
    Object.assign(Memory.cfg.rooms?.W1N1 ?? {}, { type: "unknown" });

    expect(isRoomType("unknown")).toBe(false);
    expect(getRoomType("W1N1")).toBe("normal");
  });
});

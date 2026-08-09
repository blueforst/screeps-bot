import { getSafeZonePlanRevision } from "@/runtime/safeZone";

const ROOM_NAME = "W1N1";

beforeEach(() => {
  Memory.data = {} as NonNullable<Memory["data"]>;
});

describe("getSafeZonePlanRevision", () => {
  test("规划不存在时返回 null", () => {
    expect(getSafeZonePlanRevision(ROOM_NAME)).toBeNull();
  });

  test("返回 SafeZone cache 使用的 room planner savedAt", () => {
    Memory.data.roomPlanner = {
      [ROOM_NAME]: {
        layout: {},
        timestamp: "test",
        savedAt: 12345,
      },
    };

    expect(getSafeZonePlanRevision(ROOM_NAME)).toBe(12345);
  });
});

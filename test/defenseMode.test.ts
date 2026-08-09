jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
  getCreepConfigService: jest.fn(),
  getMemoryService: jest.fn(),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(),
}));

import { runDefenseMode, isDefenseMode, isOffensiveWarCreep, getPlayerHostiles, clearDefenseModeCacheForTest } from "@/runtime/defenseMode";
import { getTickContextService, getCreepConfigService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";

function makePos(x: number, y: number, roomName: string) {
  return { x, y, roomName };
}

function makeHostile(overrides: Record<string, unknown> = {}): Creep {
  const owner = (overrides.owner ?? { username: "Enemy" }) as { username: string };
  return {
    id: `hostile_${Math.random().toString(36).slice(2, 6)}` as Id<Creep>,
    pos: makePos(25, 25, "W1N1"),
    owner,
    getActiveBodyparts: jest.fn(() => 0),
    ...overrides,
  } as unknown as Creep;
}

function makeRoomWithFind(items: Creep[] = [], roomName = "W1N1"): Room {
  return {
    name: roomName,
    find: jest.fn((_type: number, opts?: { filter?: (c: Creep) => boolean }) => {
      return opts?.filter ? items.filter(opts.filter) : items;
    }),
  } as unknown as Room;
}

function makeCreep(overrides: Record<string, unknown> = {}): Creep {
  return {
    name: `creep_${Math.random().toString(36).slice(2, 6)}`,
    memory: { configName: "W1N1:worker:0" },
    ...overrides,
  } as unknown as Creep;
}

const ROOM_W1N1 = "W1N1";
const ROOM_W2N2 = "W2N2";

beforeEach(() => {
  jest.clearAllMocks();
  clearDefenseModeCacheForTest();
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  (getTickContextService as jest.Mock).mockReturnValue({
    getMyRooms: jest.fn(() => []),
    getCreepsByConfigName: jest.fn(() => []),
  });
  (getCreepConfigService as jest.Mock).mockReturnValue({
    get: jest.fn(() => undefined),
    list: jest.fn(() => ({})),
  });
  Game.time = 100;
});

describe("isDefenseMode", () => {

  test("returns false when safe zone exists but no player hostiles", () => {
    const safeZone = new Set([25 * 50 + 25]);
    (getSafeZone as jest.Mock).mockReturnValue(safeZone);
    const room = makeRoomWithFind([], ROOM_W1N1);
    (getTickContextService as jest.Mock).mockReturnValue({
      getMyRooms: jest.fn(() => [room]),
      getCreepsByConfigName: jest.fn(() => []),
    });
    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
  });

  test("returns true when hostiles present and the safe zone exists", () => {
    const safeZone = new Set([25 * 50 + 25]);
    (getSafeZone as jest.Mock).mockReturnValue(safeZone);

    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((part: BodyPartConstant) =>
      part === ATTACK ? 1 : 0,
    );
    const room = makeRoomWithFind([hostile], ROOM_W1N1);

    (getTickContextService as jest.Mock).mockReturnValue({
      getMyRooms: jest.fn(() => [room]),
      getCreepsByConfigName: jest.fn(() => []),
    });
    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
  });

  test("different rooms can have different states", () => {
    const safeZone = new Set([25 * 50 + 25]);

    (getSafeZone as jest.Mock).mockImplementation((rn: string) =>
      rn === ROOM_W1N1 ? safeZone : new Set(),
    );

    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((part: BodyPartConstant) =>
      part === ATTACK ? 1 : 0,
    );

    const room1 = makeRoomWithFind([hostile], ROOM_W1N1);
    const room2 = makeRoomWithFind([], ROOM_W2N2);

    (getTickContextService as jest.Mock).mockReturnValue({
      getMyRooms: jest.fn(() => [room1, room2]),
      getCreepsByConfigName: jest.fn(() => []),
    });

    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(isDefenseMode(ROOM_W2N2)).toBe(false);
  });
});

describe("getPlayerHostiles (shared predicate)", () => {

  test("includes player creeps with RANGED_ATTACK parts", () => {
    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === RANGED_ATTACK ? 2 : 0,
    );
    const room = makeRoomWithFind([hostile]);
    expect(getPlayerHostiles(room)).toHaveLength(1);
  });
});

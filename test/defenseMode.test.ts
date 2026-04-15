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
  test("returns false when no safe zone exists", () => {
    (getSafeZone as jest.Mock).mockReturnValue(new Set());
    const room = makeRoomWithFind([], ROOM_W1N1);
    (getTickContextService as jest.Mock).mockReturnValue({
      getMyRooms: jest.fn(() => [room]),
      getCreepsByConfigName: jest.fn(() => []),
    });
    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
  });

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

  test("returns true when hostiles are present inside a room with a safe zone", () => {
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

  test("returns false for rooms not computed", () => {
    runDefenseMode();
    expect(isDefenseMode("UNKNOWN")).toBe(false);
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

  test("resets state on new tick", () => {
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

    Game.time = 100;
    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);

    Game.time = 101;
    const roomCleared = makeRoomWithFind([], ROOM_W1N1);
    (getTickContextService as jest.Mock).mockReturnValue({
      getMyRooms: jest.fn(() => [roomCleared]),
      getCreepsByConfigName: jest.fn(() => []),
    });
    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
  });
});

describe("isOffensiveWarCreep", () => {
  function setupConfig(role: string): void {
    const configService = {
      get: jest.fn(() => ({ role, args: [] })),
      list: jest.fn(() => ({})),
    };
    (getCreepConfigService as jest.Mock).mockReturnValue(configService);
  }

  test("returns true for meleeAttacker role", () => {
    setupConfig("meleeAttacker");
    const creep = makeCreep({ memory: { configName: "W1N1:war:W3N3:meleeAttacker:0" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(true);
  });

  test("returns true for healer role", () => {
    setupConfig("healer");
    const creep = makeCreep({ memory: { configName: "W1N1:war:W3N3:healer:0" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(true);
  });

  test("returns false for homeDefender role", () => {
    setupConfig("homeDefender");
    const creep = makeCreep({ memory: { configName: "W1N1:homeDefense:defender:0" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });

  test("returns false for worker role", () => {
    setupConfig("worker");
    const creep = makeCreep({ memory: { configName: "W1N1:worker:0" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });

  test("returns false for carrier role", () => {
    setupConfig("carrier");
    const creep = makeCreep({ memory: { configName: "W1N1:carrier:0" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });

  test("returns false for harvester role", () => {
    setupConfig("harvester");
    const creep = makeCreep({ memory: { configName: "W1N1:harvester:src1" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });

  test("returns false for colonizerHarvester role", () => {
    setupConfig("colonizerHarvester");
    const creep = makeCreep({ memory: { configName: "W1N1:colonize:W3N3:harvester:src1" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });

  test("returns false when creep has no configName", () => {
    const creep = makeCreep({ memory: {} });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });

  test("returns false when config not found", () => {
    const configService = {
      get: jest.fn(() => undefined),
      list: jest.fn(() => ({})),
    };
    (getCreepConfigService as jest.Mock).mockReturnValue(configService);
    const creep = makeCreep({ memory: { configName: "nonexistent" } });
    expect(isOffensiveWarCreep(creep as Creep)).toBe(false);
  });
});

describe("getPlayerHostiles (shared predicate)", () => {
  test("excludes Source Keeper creeps", () => {
    const sk = makeHostile({ owner: { username: "Source Keeper" } });
    (sk.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === ATTACK ? 5 : 0,
    );
    const room = makeRoomWithFind([sk]);
    expect(getPlayerHostiles(room)).toHaveLength(0);
  });

  test("excludes Invader creeps without WORK parts", () => {
    const invader = makeHostile({ owner: { username: "Invader" } });
    (invader.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === ATTACK ? 3 : 0,
    );
    const room = makeRoomWithFind([invader]);
    expect(getPlayerHostiles(room)).toHaveLength(0);
  });

  test("includes Invader creeps WITH WORK parts", () => {
    const invader = makeHostile({ owner: { username: "Invader" } });
    (invader.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === WORK ? 1 : 0,
    );
    const room = makeRoomWithFind([invader]);
    expect(getPlayerHostiles(room)).toHaveLength(1);
  });

  test("includes player creeps with ATTACK parts", () => {
    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === ATTACK ? 2 : 0,
    );
    const room = makeRoomWithFind([hostile]);
    expect(getPlayerHostiles(room)).toHaveLength(1);
  });

  test("includes player creeps with RANGED_ATTACK parts", () => {
    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === RANGED_ATTACK ? 2 : 0,
    );
    const room = makeRoomWithFind([hostile]);
    expect(getPlayerHostiles(room)).toHaveLength(1);
  });

  test("includes player creeps with WORK parts", () => {
    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === WORK ? 3 : 0,
    );
    const room = makeRoomWithFind([hostile]);
    expect(getPlayerHostiles(room)).toHaveLength(1);
  });

  test("excludes player creeps with only non-dangerous parts", () => {
    const hostile = makeHostile();
    (hostile.getActiveBodyparts as jest.Mock).mockImplementation((p: BodyPartConstant) =>
      p === MOVE ? 5 : 0,
    );
    const room = makeRoomWithFind([hostile]);
    expect(getPlayerHostiles(room)).toHaveLength(0);
  });
});

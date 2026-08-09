jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: jest.fn(),
  getCreepConfigService: jest.fn(),
  getMemoryService: jest.fn(),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(),
  getSafeZonePlanRevision: jest.fn(),
}));

import {
  clearDefenseModeCacheForTest,
  getPlayerHostiles,
  isDefenseMode,
  runDefenseMode,
} from "@/runtime/defenseMode";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { getSafeZone, getSafeZonePlanRevision } from "@/runtime/safeZone";

const ROOM_W1N1 = "W1N1";
const ROOM_W2N2 = "W2N2";
const SAFE_ZONE = new Set([25 * 50 + 25]);

function makePos(x: number, y: number, roomName: string) {
  return { x, y, roomName };
}

function makeHostile(overrides: Record<string, unknown> = {}): Creep {
  const owner = (overrides.owner ?? { username: "Enemy" }) as { username: string };
  return {
    id: `hostile_${Math.random().toString(36).slice(2, 6)}` as Id<Creep>,
    pos: makePos(25, 25, ROOM_W1N1),
    owner,
    getActiveBodyparts: jest.fn(() => 0),
    ...overrides,
  } as unknown as Creep;
}

function withActiveParts(creep: Creep, ...parts: BodyPartConstant[]): Creep {
  const activeParts = new Set(parts);
  (creep.getActiveBodyparts as jest.Mock).mockImplementation((part: BodyPartConstant) =>
    activeParts.has(part) ? 1 : 0,
  );
  return creep;
}

function makeRoomWithFind(items: Creep[] = [], roomName = ROOM_W1N1): Room {
  return {
    name: roomName,
    find: jest.fn((_type: number, opts?: { filter?: (creep: Creep) => boolean }) =>
      opts?.filter ? items.filter(opts.filter) : items,
    ),
  } as unknown as Room;
}

function useMyRooms(rooms: Room[]) {
  const tickContext = {
    getMyRooms: jest.fn(() => rooms),
    getCreepsByConfigName: jest.fn(() => []),
  };
  (getTickContextService as jest.Mock).mockReturnValue(tickContext);
  return tickContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearDefenseModeCacheForTest();
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  (getSafeZonePlanRevision as jest.Mock).mockReturnValue(null);
  useMyRooms([]);
  (getCreepConfigService as jest.Mock).mockReturnValue({
    get: jest.fn(() => undefined),
    list: jest.fn(() => ({})),
  });
  Game.time = 100;
});

describe("current-tick Defense Mode snapshot", () => {
  test("首次读取发生在显式 updater 之前时仍返回当前状态", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room = makeRoomWithFind([hostile]);
    useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
  });

  test("显式清空模块 heap cache 后在同一 tick 重新构建", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostiles = [withActiveParts(makeHostile(), ATTACK)];
    const room = makeRoomWithFind(hostiles);
    const tickContext = useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    hostiles.length = 0;
    clearDefenseModeCacheForTest();

    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(2);
  });

  test("global reset 对应的全新模块实例在同一 tick 冷读时不默认 false", () => {
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room = makeRoomWithFind([hostile]);

    jest.isolateModules(() => {
      const isolatedRuntimeServices = require("@/runtime/runtimeServices") as typeof import(
        "@/runtime/runtimeServices"
      );
      const isolatedSafeZone = require("@/runtime/safeZone") as typeof import("@/runtime/safeZone");
      (isolatedRuntimeServices.getTickContextService as jest.Mock).mockReturnValue({
        getMyRooms: jest.fn(() => [room]),
        getCreepsByConfigName: jest.fn(() => []),
      });
      (isolatedSafeZone.getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
      (isolatedSafeZone.getSafeZonePlanRevision as jest.Mock).mockReturnValue(100);

      const isolatedDefenseMode = require("@/runtime/defenseMode") as typeof import(
        "@/runtime/defenseMode"
      );
      expect(isolatedDefenseMode.isDefenseMode(ROOM_W1N1)).toBe(true);
    });
  });

  test("规划 revision 稳定时同一 epoch 复用 snapshot，显式 updater 不重复扫描", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostiles = [withActiveParts(makeHostile(), ATTACK)];
    const room = makeRoomWithFind(hostiles);
    const tickContext = useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    hostiles.length = 0;
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    runDefenseMode();

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(1);
    expect(room.find).toHaveBeenCalledTimes(1);
  });

  test("显式 updater 先预热时，后续读取复用同一 snapshot", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostiles = [withActiveParts(makeHostile(), ATTACK)];
    const room = makeRoomWithFind(hostiles);
    const tickContext = useMyRooms([room]);

    runDefenseMode();
    hostiles.length = 0;

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(1);
    expect(room.find).toHaveBeenCalledTimes(1);
  });

  test("tick 变化时重建并反映 hostile 消失和再次出现", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostiles = [withActiveParts(makeHostile(), ATTACK)];
    const room = makeRoomWithFind(hostiles);
    const tickContext = useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    hostiles.length = 0;
    Game.time += 1;
    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    hostiles.push(withActiveParts(makeHostile(), HEAL));
    Game.time += 1;
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);

    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(3);
  });

  test("固定 updater 在规划 revision 同 tick 变化时原子重建 snapshot", () => {
    let safeZone = new Set<number>();
    let planRevision: number | null = null;
    (getSafeZone as jest.Mock).mockImplementation(() => safeZone);
    (getSafeZonePlanRevision as jest.Mock).mockImplementation(() => planRevision);
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room = makeRoomWithFind([hostile]);
    const tickContext = useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    safeZone = SAFE_ZONE;
    planRevision = Game.time;
    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    runDefenseMode();
    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    runDefenseMode();

    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(2);
    expect(room.find).toHaveBeenCalledTimes(1);
  });

  test("相同 tick 替换 Game 对象时重新请求 current TickContext", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const currentRoom = makeRoomWithFind([withActiveParts(makeHostile(), ATTACK)]);
    const currentTickContext = useMyRooms([currentRoom]);
    const originalGame = Game;

    try {
      expect(isDefenseMode(ROOM_W1N1)).toBe(true);
      const replacementGame = { ...originalGame, time: originalGame.time } as Game;
      (global as unknown as { Game: Game }).Game = replacementGame;
      const replacementRoom = makeRoomWithFind([]);
      const replacementTickContext = useMyRooms([replacementRoom]);

      expect(isDefenseMode(ROOM_W1N1)).toBe(false);
      expect(currentTickContext.getMyRooms).toHaveBeenCalledTimes(1);
      expect(replacementTickContext.getMyRooms).toHaveBeenCalledTimes(1);
    } finally {
      (global as unknown as { Game: Game }).Game = originalGame;
      clearDefenseModeCacheForTest();
    }
  });

  test("同一 snapshot 隔离两个己方房间并对未知房间返回 false", () => {
    (getSafeZone as jest.Mock).mockReturnValue(SAFE_ZONE);
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room1 = makeRoomWithFind([hostile], ROOM_W1N1);
    const room2 = makeRoomWithFind([], ROOM_W2N2);
    const tickContext = useMyRooms([room1, room2]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(isDefenseMode(ROOM_W2N2)).toBe(false);
    expect(isDefenseMode("W9N9")).toBe(false);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(1);
  });

  test("无规划安全区时保持 false 且不扫描 hostile", () => {
    const room = makeRoomWithFind([withActiveParts(makeHostile(), ATTACK)]);
    useMyRooms([room]);

    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    expect(room.find).not.toHaveBeenCalled();
  });

  test("多房构建失败不发布半份 snapshot，并在下一次调用完整重试", () => {
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room1 = makeRoomWithFind([hostile], ROOM_W1N1);
    const room2 = makeRoomWithFind([], ROOM_W2N2);
    const tickContext = useMyRooms([room1, room2]);
    let shouldFail = true;
    (getSafeZone as jest.Mock).mockImplementation((roomName: string) => {
      if (roomName === ROOM_W2N2 && shouldFail) throw new Error("safe-zone failure");
      return SAFE_ZONE;
    });

    expect(() => isDefenseMode(ROOM_W1N1)).toThrow("safe-zone failure");
    expect(room1.find).toHaveBeenCalledTimes(1);
    shouldFail = false;

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(2);
    expect(room1.find).toHaveBeenCalledTimes(2);
    expect(room2.find).toHaveBeenCalledTimes(1);
  });

  test("规划 revision 重建失败后使旧代失效，普通读取会完整重试", () => {
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const room1 = makeRoomWithFind([hostile], ROOM_W1N1);
    const room2 = makeRoomWithFind([], ROOM_W2N2);
    const tickContext = useMyRooms([room1, room2]);
    let hasPlan = false;
    let shouldFail = true;
    (getSafeZonePlanRevision as jest.Mock).mockImplementation(() => (hasPlan ? Game.time : null));
    (getSafeZone as jest.Mock).mockImplementation((roomName: string) => {
      if (!hasPlan) return new Set();
      if (roomName === ROOM_W2N2 && shouldFail) throw new Error("refreshed safe-zone failure");
      return SAFE_ZONE;
    });

    expect(isDefenseMode(ROOM_W1N1)).toBe(false);
    hasPlan = true;
    expect(() => runDefenseMode()).toThrow("refreshed safe-zone failure");
    expect(room1.find).toHaveBeenCalledTimes(1);
    shouldFail = false;

    expect(isDefenseMode(ROOM_W1N1)).toBe(true);
    expect(tickContext.getMyRooms).toHaveBeenCalledTimes(3);
    expect(room1.find).toHaveBeenCalledTimes(2);
    expect(room2.find).toHaveBeenCalledTimes(1);
  });
});

describe("getPlayerHostiles shared predicate", () => {
  const dangerousParts: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, WORK, HEAL];

  test("优先复用 TickContext 的 hostile scan cache", () => {
    const hostile = withActiveParts(makeHostile(), ATTACK);
    const getHostileCreeps = jest.fn(() => [hostile]);
    (getTickContextService as jest.Mock).mockReturnValue({
      getRoomContext: jest.fn(() => ({ getHostileCreeps })),
      getMyRooms: jest.fn(() => []),
      getCreepsByConfigName: jest.fn(() => []),
    });
    const room = makeRoomWithFind([]);

    expect(getPlayerHostiles(room)).toEqual([hostile]);
    expect(getHostileCreeps).toHaveBeenCalledTimes(1);
    expect(room.find).not.toHaveBeenCalled();
  });

  test.each(dangerousParts)("普通玩家带 %s 时纳入", (part) => {
    const hostile = withActiveParts(makeHostile(), part);
    expect(getPlayerHostiles(makeRoomWithFind([hostile]))).toHaveLength(1);
  });

  const npcCases: Array<[string, BodyPartConstant[], boolean]> = [
    ["Source Keeper", [ATTACK, WORK, HEAL], false],
    ["Invader", [ATTACK], false],
    ["Invader", [RANGED_ATTACK], false],
    ["Invader", [WORK], true],
    ["Invader", [HEAL], true],
    ["Enemy", [], false],
  ];

  test.each(npcCases)("%s 携带 %j 的纳入结果为 %s", (username, parts, expected) => {
    const hostile = withActiveParts(makeHostile({ owner: { username } }), ...parts);
    expect(getPlayerHostiles(makeRoomWithFind([hostile]))).toHaveLength(expected ? 1 : 0);
  });
});

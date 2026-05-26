import {
  countFreeAdjacentTiles,
  cleanupStaleDiscoveries,
  recordPowerBankDiscovery,
  ensureDiscoveryStore,
} from "@/runtime/powerBankDiscovery";
import { POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { createMockPowerBank } from "@mock/powerBank";

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

const createMockTerrain = (grid: number[][]) => ({
  get: (x: number, y: number) => grid[y]?.[x] ?? 0,
});

const makeTask = (overrides: Partial<PowerBankHarvestTask> = {}): PowerBankHarvestTask => ({
  id: overrides.id ?? "pb-test",
  status: overrides.status ?? POWER_BANK_STATUS.DISCOVERED,
  sourceRoom: overrides.sourceRoom ?? "",
  targetRoom: overrides.targetRoom ?? "E0N60",
  bankId: overrides.bankId ?? "pb-test",
  bankPos: overrides.bankPos ?? { x: 25, y: 25 },
  hits: overrides.hits ?? 2_000_000,
  power: overrides.power ?? 5000,
  ticksToDecay: overrides.ticksToDecay ?? 5000,
  freeTiles: overrides.freeTiles ?? 8,
  discoveredTick: overrides.discoveredTick ?? 1,
  lastSeenTick: overrides.lastSeenTick ?? 1,
  haulerIds: overrides.haulerIds ?? [],
  boostLabs: overrides.boostLabs ?? [],
  compoundTransferTaskIds: overrides.compoundTransferTaskIds ?? [],
});

describe("powerBankDiscovery", () => {
  beforeEach(() => {
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
    Memory.data = {};
    if (!Game.map) {
      (Game as any).map = {} as GameMap;
    }
  });

  describe("countFreeAdjacentTiles", () => {
    it("returns 8 for open plains terrain around position", () => {
      const allPlains = Array.from({ length: 50 }, () => Array(50).fill(0));
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(allPlains) as any);

      const pos = new RoomPosition(25, 25, "E0N60") as unknown as RoomPosition;
      expect(countFreeAdjacentTiles(pos)).toBe(8);
    });

    it("returns 0 when all adjacent tiles are wall", () => {
      const grid = Array.from({ length: 50 }, () => Array(50).fill(1));
      const pos = new RoomPosition(25, 25, "E0N60") as unknown as RoomPosition;
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(grid) as any);

      expect(countFreeAdjacentTiles(pos)).toBe(0);
    });

    it("counts swamp tiles as free", () => {
      const grid = Array.from({ length: 50 }, () => Array(50).fill(0));
      grid[24][25] = 2;
      grid[26][25] = 2;
      const pos = new RoomPosition(25, 25, "E0N60") as unknown as RoomPosition;
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(grid) as any);

      expect(countFreeAdjacentTiles(pos)).toBe(8);
    });

    it("handles edge positions (x=0) by skipping out-of-bounds", () => {
      const grid = Array.from({ length: 50 }, () => Array(50).fill(0));
      const pos = new RoomPosition(0, 25, "E0N60") as unknown as RoomPosition;
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(grid) as any);

      expect(countFreeAdjacentTiles(pos)).toBe(5);
    });

    it("handles corner position (0,0)", () => {
      const grid = Array.from({ length: 50 }, () => Array(50).fill(0));
      const pos = new RoomPosition(0, 0, "E0N60") as unknown as RoomPosition;
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(grid) as any);

      expect(countFreeAdjacentTiles(pos)).toBe(3);
    });
  });

  describe("recordPowerBankDiscovery", () => {
    it("creates a discovery task keyed by bank id", () => {
      Game.time = 100;
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);

      const bank = createMockPowerBank({ id: "pb-1", x: 25, y: 25, roomName: "E3N60", hits: 2000000, power: 5000, ticksToDecay: 4000 });
      recordPowerBankDiscovery(bank);

      const store = ensureDiscoveryStore();
      expect(store["pb-1"]).toBeDefined();
      expect(store["pb-1"].status).toBe(POWER_BANK_STATUS.DISCOVERED);
      expect(store["pb-1"].targetRoom).toBe("E3N60");
      expect(store["pb-1"].hits).toBe(2000000);
      expect(store["pb-1"].power).toBe(5000);
      expect(store["pb-1"].ticksToDecay).toBe(4000);
      expect(store["pb-1"].freeTiles).toBe(8);
      expect(store["pb-1"].discoveredTick).toBe(100);
      expect(store["pb-1"].lastSeenTick).toBe(100);
      expect(store["pb-1"].sourceRoom).toBe("");
    });

    it("updates lastSeenTick and stats on duplicate sightings", () => {
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);

      const bank = createMockPowerBank({ id: "pb-1", roomName: "E3N60", hits: 2000000 });

      Game.time = 100;
      recordPowerBankDiscovery(bank);

      Game.time = 200;
      const updatedBank = createMockPowerBank({ id: "pb-1", roomName: "E3N60", hits: 1500000, power: 5000, ticksToDecay: 3800 });
      recordPowerBankDiscovery(updatedBank);

      const store = ensureDiscoveryStore();
      const task = store["pb-1"];
      expect(task.discoveredTick).toBe(100);
      expect(task.lastSeenTick).toBe(200);
      expect(task.hits).toBe(1500000);
      expect(task.ticksToDecay).toBe(3800);
    });

    it("records wall-blocked banks with 0 free tiles", () => {
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(1))) as any);

      const bank = createMockPowerBank({ id: "pb-wall", roomName: "E3N60" });
      recordPowerBankDiscovery(bank);

      const store = ensureDiscoveryStore();
      expect(store["pb-wall"].freeTiles).toBe(0);
    });

    it("ignores power banks outside configured patrol rooms", () => {
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);

      const bank = createMockPowerBank({ id: "pb-outside", roomName: "W0N55" });
      recordPowerBankDiscovery(bank);

      expect(ensureDiscoveryStore()["pb-outside"]).toBeUndefined();
    });
  });

  describe("cleanupStaleDiscoveries", () => {
    it("removes stale discovered tasks", () => {
      const store = ensureDiscoveryStore();
      store["pb-old"] = makeTask({ id: "pb-old", lastSeenTick: 1 });

      Game.time = 1000;
      cleanupStaleDiscoveries();

      expect(store["pb-old"]).toBeUndefined();
    });

    it("keeps recently seen discovered tasks", () => {
      const store = ensureDiscoveryStore();
      store["pb-recent"] = makeTask({ id: "pb-recent", discoveredTick: 800, lastSeenTick: 900 });

      Game.time = 1000;
      cleanupStaleDiscoveries();

      expect(store["pb-recent"]).toBeDefined();
    });

    it("does not remove tasks that progressed beyond discovered", () => {
      const store = ensureDiscoveryStore();
      store["pb-active"] = makeTask({
        id: "pb-active",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: "E5N55",
        lastSeenTick: 1,
      });

      Game.time = 1000;
      cleanupStaleDiscoveries();

      expect(store["pb-active"]).toBeDefined();
    });
  });
});

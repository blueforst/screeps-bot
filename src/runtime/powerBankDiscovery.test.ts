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
  });

  describe("recordPowerBankDiscovery", () => {

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
  });

  describe("cleanupStaleDiscoveries", () => {
    it("removes stale discovered tasks", () => {
      const store = ensureDiscoveryStore();
      store["pb-old"] = makeTask({ id: "pb-old", lastSeenTick: 1 });

      Game.time = 1000;
      cleanupStaleDiscoveries();

      expect(store["pb-old"]).toBeUndefined();
    });
  });
});

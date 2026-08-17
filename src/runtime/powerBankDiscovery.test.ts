import {
  countFreeAdjacentTiles,
  recordPowerBankDiscovery,
  ensureDiscoveryStore,
} from "@/runtime/powerBankDiscovery";
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
});

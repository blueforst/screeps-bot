import { isSpawnActive, clearSpawnActiveCacheForTest } from "@/runtime/tickContext";

function makeSpawn(overrides: Record<string, unknown> = {}): StructureSpawn {
  return {
    id: `spawn_${Math.random().toString(36).slice(2, 8)}` as Id<StructureSpawn>,
    ...overrides,
  } as unknown as StructureSpawn;
}

beforeEach(() => {
  clearSpawnActiveCacheForTest();
  Game.time = 100;
});

describe("isSpawnActive", () => {

  test("calls isActive() only once per spawn within a tick", () => {
    const isActive = jest.fn(() => true);
    const spawn = makeSpawn({ isActive });

    isSpawnActive(spawn);
    isSpawnActive(spawn);
    isSpawnActive(spawn);

    expect(isActive).toHaveBeenCalledTimes(1);
  });

  test("caches false results without re-invoking isActive()", () => {
    const isActive = jest.fn(() => false);
    const spawn = makeSpawn({ isActive });

    expect(isSpawnActive(spawn)).toBe(false);
    expect(isSpawnActive(spawn)).toBe(false);

    expect(isActive).toHaveBeenCalledTimes(1);
  });
});

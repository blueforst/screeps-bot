import { reconcileSpawnQueueOwnership } from "@/runtime/spawnQueueOwnership";
import { clearSpawnActiveCacheForTest } from "@/runtime/tickContext";

function createSpawn(name: string, active: boolean, queue: string[]): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    memory: { spawnList: [...queue] },
    spawning: null,
    isActive: jest.fn(() => active),
  } as unknown as StructureSpawn;
}

function reconcile(
  spawns: StructureSpawn[],
  knownConfigNames: string[],
  spawningConfigNames: string[] = [],
): void {
  reconcileSpawnQueueOwnership(spawns, {
    knownConfigNames: new Set(knownConfigNames),
    spawningConfigNames: new Set(spawningConfigNames),
  });
}

describe("spawnQueueOwnership", () => {
  beforeEach(() => {
    clearSpawnActiveCacheForTest();
    Game.time += 1;
  });

  it("把 inactive owner 原子迁移到最小负载 active Spawn，并保留前置请求位置", () => {
    const configName = "W1N1:worker:0";
    const inactive = createSpawn("Spawn1", false, [configName]);
    const activeA = createSpawn("Spawn2", true, ["active-before", "active-after"]);
    const activeB = createSpawn("Spawn3", true, ["busy-a", "busy-b", "busy-c"]);

    reconcile(
      [inactive, activeB, activeA],
      [configName, "active-before", "active-after", "busy-a", "busy-b", "busy-c"],
    );

    expect(inactive.memory.spawnList).toEqual([]);
    expect(activeA.memory.spawnList).toEqual([configName, "active-before", "active-after"]);
    expect(activeB.memory.spawnList).toEqual(["busy-a", "busy-b", "busy-c"]);

    clearSpawnActiveCacheForTest();
    Game.time += 1;
    const onceName = "W1N1:war:claimer:0";
    const onceInactive = createSpawn("OnceInactive", false, [onceName]);
    const onceActive = createSpawn("OnceActive", true, ["active-a", "active-b", onceName]);

    reconcile(
      [onceInactive, onceActive],
      [onceName, "active-a", "active-b"],
    );

    expect(onceInactive.memory.spawnList).toEqual([]);
    expect(onceActive.memory.spawnList).toEqual([onceName, "active-a", "active-b"]);
  });

  it("先收敛 active 重复项，再按同代快照的规范化负载稳定分散", () => {
    const inactiveOnly = "a0";
    const sharedA = "z0";
    const sharedB = "z1";
    const activeA = createSpawn("SpawnA", true, [sharedA, sharedB]);
    const activeB = createSpawn("SpawnB", true, [sharedA, sharedB]);
    const inactive = createSpawn("SpawnI", false, [inactiveOnly]);

    reconcile(
      [inactive, activeB, activeA],
      [inactiveOnly, sharedA, sharedB],
    );

    expect(activeA.memory.spawnList).toEqual([sharedA, inactiveOnly]);
    expect(activeB.memory.spawnList).toEqual([sharedB]);
    expect(inactive.memory.spawnList).toEqual([]);
  });

  it("混合 duplicate 与多 source migration 时保留 canonical placement 和 source FIFO", () => {
    const active = createSpawn("SpawnA", true, ["a", "z"]);
    const inactiveA = createSpawn("SpawnI-A", false, ["a"]);
    const inactiveZ = createSpawn("SpawnI-Z", false, ["z", "m"]);

    reconcile([inactiveZ, active, inactiveA], ["a", "z", "m"]);

    expect(active.memory.spawnList).toEqual(["a", "z", "m"]);
    expect(active.memory.spawnList!.indexOf("a")).toBeLessThan(active.memory.spawnList!.indexOf("m"));
    expect(inactiveA.memory.spawnList).toEqual([]);
    expect(inactiveZ.memory.spawnList).toEqual([]);
  });

  it("全部 inactive 时保留确定性 owner，并清除 missing、spawning 与重复残项", () => {
    const configName = "W1N1:worker:0";
    const spawnA = createSpawn("SpawnA", false, ["keep", configName]);
    const spawnB = createSpawn("SpawnB", false, [configName]);

    reconcile([spawnB, spawnA], [configName, "keep"]);

    expect(spawnA.memory.spawnList).toEqual(["keep"]);
    expect(spawnB.memory.spawnList).toEqual([configName]);

    clearSpawnActiveCacheForTest();
    Game.time += 1;
    const spawning = "W1N1:worker:0";
    const keepA = "W1N1:worker:1";
    const keepB = "W1N1:worker:2";
    const cleanupA = createSpawn("CleanupA", true, ["missing", spawning, keepA]);
    const cleanupB = createSpawn("CleanupB", true, [spawning, keepB]);

    reconcile([cleanupA, cleanupB], [spawning, keepA, keepB], [spawning]);

    expect(cleanupA.memory.spawnList).toEqual([keepA]);
    expect(cleanupB.memory.spawnList).toEqual([keepB]);
  });
});

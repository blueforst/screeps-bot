import { reconcileSpawnQueueOwnership } from "@/runtime/spawnQueueOwnership";
import { clearSpawnActiveCacheForTest } from "@/runtime/tickContext";
import type { CreepConfig } from "@/types/system";

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

  it("把 inactive owner 原子迁移到负载最小的 active Spawn，并保留无关顺序", () => {
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
  });

  it("保留位置最靠前的 active owner，并收敛单队列重复项", () => {
    const configName = "W1N1:worker:0";
    const activeA = createSpawn("SpawnA", true, ["keep-a", configName, configName]);
    const activeB = createSpawn("SpawnB", true, [configName, "keep-b"]);
    const inactive = createSpawn("SpawnC", false, [configName]);

    reconcile([inactive, activeB, activeA], [configName, "keep-a", "keep-b"]);

    expect(activeA.memory.spawnList).toEqual(["keep-a"]);
    expect(activeB.memory.spawnList).toEqual([configName, "keep-b"]);
    expect(inactive.memory.spawnList).toEqual([]);
  });

  it("active 已有尾部副本时仍保留 inactive toFront 请求的原始索引", () => {
    const configName = "W1N1:war:claimer:0";
    const inactive = createSpawn("SpawnA", false, [configName]);
    const active = createSpawn("SpawnB", true, ["active-a", "active-b", configName]);

    reconcile(
      [inactive, active],
      [configName, "active-a", "active-b"],
    );

    expect(inactive.memory.spawnList).toEqual([]);
    expect(active.memory.spawnList).toEqual([configName, "active-a", "active-b"]);
  });

  it("先收敛 active 跨副本，再按规范化后的真实负载迁移 inactive request", () => {
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

  it("用同一代快照选择 active duplicate owner，并按规范化负载分散", () => {
    const activeA = createSpawn("SpawnA", true, ["a", "b"]);
    const activeB = createSpawn("SpawnB", true, ["a", "b"]);

    reconcile([activeB, activeA], ["a", "b"]);

    expect(activeA.memory.spawnList).toEqual(["a"]);
    expect(activeB.memory.spawnList).toEqual(["b"]);
  });

  it("批量迁移同一 inactive 队列时保留落到同一 owner 的相对顺序", () => {
    const activeA = createSpawn("SpawnA", true, []);
    const activeB = createSpawn("SpawnB", true, []);
    const inactive = createSpawn("SpawnI", false, ["a", "b", "c"]);

    reconcile([inactive, activeB, activeA], ["a", "b", "c"]);

    expect(activeA.memory.spawnList).toEqual(["a", "c"]);
    expect(activeB.memory.spawnList).toEqual(["b"]);
    expect(inactive.memory.spawnList).toEqual([]);
  });

  it("多个 inactive source 汇入同一 active owner 时不反转任一 source FIFO", () => {
    const active = createSpawn("SpawnA", true, []);
    const inactiveA = createSpawn("SpawnI-A", false, ["a", "b"]);
    const inactiveB = createSpawn("SpawnI-B", false, ["c"]);

    reconcile([inactiveB, active, inactiveA], ["a", "b", "c"]);

    expect(active.memory.spawnList).toEqual(["a", "c", "b"]);
    expect(active.memory.spawnList!.indexOf("a")).toBeLessThan(active.memory.spawnList!.indexOf("b"));
    expect(inactiveA.memory.spawnList).toEqual([]);
    expect(inactiveB.memory.spawnList).toEqual([]);
  });

  it("duplicate 收敛与 inactive migration 混合时仍从同一快照保留 FIFO", () => {
    const active = createSpawn("SpawnA", true, ["a", "z"]);
    const inactiveA = createSpawn("SpawnI-A", false, ["a"]);
    const inactiveZ = createSpawn("SpawnI-Z", false, ["z", "m"]);

    reconcile([inactiveZ, active, inactiveA], ["a", "z", "m"]);

    expect(active.memory.spawnList).toEqual(["a", "z", "m"]);
    expect(inactiveA.memory.spawnList).toEqual([]);
    expect(inactiveZ.memory.spawnList).toEqual([]);
  });

  it("冲突副本中由 canonical active source 决定 mixed placement 顺序", () => {
    const active = createSpawn("SpawnA", true, ["z"]);
    const inactive = createSpawn("SpawnI", false, ["m", "z"]);

    reconcile([inactive, active], ["m", "z"]);

    expect(active.memory.spawnList).toEqual(["z", "m"]);
    expect(inactive.memory.spawnList).toEqual([]);
  });

  it("多个 canonical source 同索引迁移时按 source Spawn 名稳定合并", () => {
    const active = createSpawn("Active", true, []);
    const inactiveZ = createSpawn("SpawnZ", false, ["a"]);
    const inactiveA = createSpawn("SpawnA", false, ["z"]);

    reconcile([inactiveZ, active, inactiveA], ["a", "z"]);

    expect(active.memory.spawnList).toEqual(["z", "a"]);
  });

  it("全部 Spawn inactive 时保留一个确定性 owner", () => {
    const configName = "W1N1:worker:0";
    const spawnA = createSpawn("SpawnA", false, ["keep", configName]);
    const spawnB = createSpawn("SpawnB", false, [configName]);

    reconcile([spawnB, spawnA], [configName, "keep"]);

    expect(spawnA.memory.spawnList).toEqual(["keep"]);
    expect(spawnB.memory.spawnList).toEqual([configName]);
  });

  it("清除 missing 与 spawning 残项，但保留不同配置", () => {
    const spawning = "W1N1:worker:0";
    const keepA = "W1N1:worker:1";
    const keepB = "W1N1:worker:2";
    const spawnA = createSpawn("SpawnA", true, ["missing", spawning, keepA]);
    const spawnB = createSpawn("SpawnB", true, [spawning, keepB]);

    reconcile([spawnA, spawnB], [spawning, keepA, keepB], [spawning]);

    expect(spawnA.memory.spawnList).toEqual([keepA]);
    expect(spawnB.memory.spawnList).toEqual([keepB]);
  });

  it("迁移 spawnOnce request 时不修改 queuedAt", () => {
    const configName = "W1N1:war:once";
    const config = {
      role: "claimer",
      args: [],
      roomName: "W1N1",
      spawnOnce: { queuedAt: Game.time - 50 },
    } as CreepConfig;
    const inactive = createSpawn("SpawnA", false, [configName]);
    const active = createSpawn("SpawnB", true, []);

    reconcile([inactive, active], [configName]);

    expect(inactive.memory.spawnList).toEqual([]);
    expect(active.memory.spawnList).toEqual([configName]);
    expect(config.spawnOnce?.queuedAt).toBe(Game.time - 50);
  });
});

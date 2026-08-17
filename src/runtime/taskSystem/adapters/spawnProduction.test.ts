import {
  snapshotSpawnProduction,
  spawnProductionAdapter,
  type SpawnProductionStatusView,
} from "@/runtime/taskSystem/adapters/spawnProduction";

function createRoom(name: string): Room {
  return { name } as Room;
}

function createSpawn(
  name: string,
  roomName: string,
  spawningName?: string,
): StructureSpawn {
  return {
    name,
    room: createRoom(roomName),
    spawning: spawningName ? { name: spawningName } : null,
  } as unknown as StructureSpawn;
}

function createCreep(name: string, roomName: string, spawning = false): Creep {
  return {
    name,
    room: createRoom(roomName),
    spawning,
  } as unknown as Creep;
}

function setRawSpawnQueue(spawnName: string, queue: unknown[]): void {
  Memory.spawns = Memory.spawns || {};
  Memory.spawns[spawnName] = { spawnList: queue } as unknown as SpawnMemory;
}

function setRawCreepConfigName(creepName: string, configName: unknown): void {
  Memory.creeps[creepName] = { configName } as unknown as CreepMemory;
}

function getEntry(
  entries: readonly SpawnProductionStatusView[],
  localId: string,
): SpawnProductionStatusView {
  const entry = entries.find((candidate) => candidate.ref.localId === localId);
  if (!entry) throw new Error(`missing spawn production entry ${localId}`);
  return entry;
}

describe("spawn production task-system adapter", () => {
  test("projects the overlapping lifecycle with stable identity and authorities", () => {
    const configName = "W1N1:worker:slot:0->primary";
    const config = { role: "worker" as const, args: [], roomName: "W1N1" };
    const queue = [configName];
    const queuedSpawn = createSpawn("Spawn-queued", "W1N1");
    const spawningSpawn = createSpawn("Spawn-spawning", "W1N1", "worker-new");
    const oldCreep = createCreep("worker-old", "W8N8");
    const spawningCreep = createCreep("worker-new", "W1N1", true);
    Memory.data = { creepConfigs: { [configName]: config } };
    setRawSpawnQueue(queuedSpawn.name, queue);
    setRawCreepConfigName(spawningCreep.name, configName);
    setRawCreepConfigName(oldCreep.name, configName);
    Game.spawns = {
      [spawningSpawn.name]: spawningSpawn,
      [queuedSpawn.name]: queuedSpawn,
    };
    Game.creeps = {
      [spawningCreep.name]: spawningCreep,
      [oldCreep.name]: oldCreep,
    };

    const memoryBefore = JSON.stringify(Memory);
    const result = snapshotSpawnProduction();
    const entry = getEntry(result.entries, configName);

    expect(spawnProductionAdapter.system).toBe("spawn-production");
    expect(entry.ref).toEqual({
      system: "spawn-production",
      namespace: "spawnPlanner",
      scope: { kind: "global" },
      localId: configName,
    });
    expect(entry.activity).toBe("running");
    expect(entry.sourceState).toBe("desired+queued+spawning+materialized");
    expect(entry.facts.map((fact) => fact.kind)).toEqual([
      "desired",
      "queued",
      "spawning",
      "materialized",
    ]);
    expect(entry.authorities).toEqual([
      { role: "assignee", id: "worker-old", component: "materialized" },
      { role: "executor", id: "Spawn-spawning", component: "worker-new" },
      { role: "queue_owner", id: "Spawn-queued", component: "W1N1" },
    ]);
    expect(entry.activity).not.toBe("terminal");
    expect(entry.issues).toEqual([]);
    expect(JSON.stringify(Memory)).toBe(memoryBefore);
    expect(Memory.data!.creepConfigs![configName]).toBe(config);
    expect(Memory.spawns![queuedSpawn.name].spawnList).toBe(queue);
  });

  test("fails closed and sorts copied facts for duplicate queue references", () => {
    const configName = "W6N6:worker:0";
    const config = { role: "worker" as const, args: [], roomName: "W6N6" };
    const queueA = [configName];
    const queueZ = [configName, configName];
    Memory.data = { creepConfigs: { [configName]: config } };
    const spawnZ = createSpawn("SpawnZ", "W6N6");
    const spawnA = createSpawn("SpawnA", "W6N6");
    Game.spawns = { SpawnZ: spawnZ, SpawnA: spawnA };
    setRawSpawnQueue("SpawnZ", queueZ);
    setRawSpawnQueue("SpawnA", queueA);

    const first = getEntry(snapshotSpawnProduction().entries, configName);
    Game.spawns = { SpawnA: spawnA, SpawnZ: spawnZ };
    const second = getEntry(snapshotSpawnProduction().entries, configName);

    expect(first).toEqual(second);
    expect(first.facts.filter((fact) => fact.kind === "queued")).toEqual([
      { kind: "queued", spawnName: "SpawnA", roomName: "W6N6", queueIndex: 0 },
      { kind: "queued", spawnName: "SpawnZ", roomName: "W6N6", queueIndex: 0 },
      { kind: "queued", spawnName: "SpawnZ", roomName: "W6N6", queueIndex: 1 },
    ]);
    expect(first.issues.map((issue) => issue.code)).toEqual([
      "spawn-duplicate-queue-reference",
      "spawn-multiple-queue-owners",
    ]);
    expect(first.activity).toBe("unknown");
    expect(queueA).toEqual([configName]);
    expect(queueZ).toEqual([configName, configName]);

    (first.facts as unknown as Array<Record<string, unknown>>)[0].kind = "changed";
    expect(config.role).toBe("worker");
    expect(getEntry(snapshotSpawnProduction().entries, configName).facts[0].kind).toBe("desired");
  });
});

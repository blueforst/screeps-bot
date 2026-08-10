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

function createCreep(
  name: string,
  roomName: string,
  spawning = false,
): Creep {
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
  test("projects desired, queued, spawning, and materialized overlap without terminal completion", () => {
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
    const queueBefore = [...queue];
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
    expect(queue).toEqual(queueBefore);
    expect(Memory.data!.creepConfigs![configName]).toBe(config);
    expect(Memory.spawns![queuedSpawn.name].spawnList).toBe(queue);
  });

  test("keeps a materialized ordinary config desired instead of inferring completion", () => {
    const configName = "W2N2:carrier:0";
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "carrier", args: [], roomName: "W2N2" },
      },
    };
    Game.creeps.carrier = createCreep("carrier", "W3N3");
    setRawCreepConfigName("carrier", configName);

    const entry = getEntry(snapshotSpawnProduction().entries, configName);

    expect(entry.activity).toBe("desired");
    expect(entry.sourceState).toBe("desired+materialized");
    expect(entry.facts.map((fact) => fact.kind)).toEqual(["desired", "materialized"]);
    expect(entry.activity).not.toBe("terminal");
  });

  test("projects the real transient success window after mountSpawn consumes the config", () => {
    const configName = "W2N2:manual:maxcarrier:100";
    const consumedConfigStore = {};
    Memory.data = { creepConfigs: consumedConfigStore };
    const spawn = createSpawn("Spawn1", "W2N2", "carrier-new");
    Game.spawns = { Spawn1: spawn };
    Game.creeps["carrier-new"] = createCreep("carrier-new", "W2N2", true);
    setRawCreepConfigName("carrier-new", configName);

    const entry = getEntry(snapshotSpawnProduction().entries, configName);

    expect(entry.activity).toBe("running");
    expect(entry.sourceState).toBe("transient-accepted:spawning");
    expect(entry.facts).toEqual([
      {
        kind: "spawning",
        spawnName: "Spawn1",
        roomName: "W2N2",
        creepName: "carrier-new",
      },
    ]);
    expect(entry.issues).toEqual([]);
    expect(entry.activity).not.toBe("terminal");
    expect(Memory.data!.creepConfigs).toBe(consumedConfigStore);
    expect(Memory.data!.creepConfigs).toEqual({});
  });

  test("keeps a materialized emergency transient as accepted running production", () => {
    const configName = "W2N2:emergency:defender:100";
    Game.creeps.defender = createCreep("defender", "W9N9");
    setRawCreepConfigName("defender", configName);

    const entry = getEntry(snapshotSpawnProduction().entries, configName);

    expect(entry.activity).toBe("running");
    expect(entry.sourceState).toBe("transient-accepted:materialized");
    expect(entry.facts).toEqual([
      { kind: "materialized", creepName: "defender", roomName: "W9N9" },
    ]);
    expect(entry.issues).toEqual([]);
    expect(entry.activity).not.toBe("terminal");
  });

  test.each([
    ["W2N2:manualx:defender:100", "materialized"],
    ["W2N2:emergencyx:defender:100", "materialized"],
    ["W2N2:manual:defender:100", "queued"],
  ] as const)(
    "does not broaden the mountSpawn transient rule for %s with only %s evidence",
    (configName, evidence) => {
      if (evidence === "queued") {
        Game.spawns.Spawn1 = createSpawn("Spawn1", "W2N2");
        setRawSpawnQueue("Spawn1", [configName]);
      } else {
        Game.creeps.creep = createCreep("creep", "W2N2");
        setRawCreepConfigName("creep", configName);
      }

      const entry = getEntry(snapshotSpawnProduction().entries, configName);

      expect(entry.activity).toBe("unknown");
      expect(entry.sourceState).toBe(evidence);
      expect(entry.issues).toEqual([
        expect.objectContaining({ code: "spawn-reference-missing-config" }),
      ]);
    },
  );

  test("reports the destroyed-owner spawnOnce ambiguity without repairing queuedAt", () => {
    Game.time = 100;
    const configName = "W3N3:war:once";
    const spawnOnce = { queuedAt: Game.time - 25 };
    const config = {
      role: "claimer" as const,
      args: [],
      roomName: "W3N3",
      spawnOnce,
    };
    Memory.data = { creepConfigs: { [configName]: config } };

    const entry = getEntry(snapshotSpawnProduction().entries, configName);

    expect(entry.activity).toBe("unknown");
    expect(entry.sourceState).toBe("desired");
    expect(entry.facts).toEqual([
      {
        kind: "desired",
        roomName: "W3N3",
        role: "claimer",
        spawnOnceQueuedAt: Game.time - 25,
      },
    ]);
    expect(entry.issues).toEqual([
      expect.objectContaining({ code: "spawn-once-observation-ambiguous" }),
    ]);
    expect(config.spawnOnce).toBe(spawnOnce);
    expect(config.spawnOnce.queuedAt).toBe(Game.time - 25);
  });

  test("fails closed for malformed configs and missing queue references while isolating valid identities", () => {
    const validId = "valid:config->id";
    const unknownRoleId = "unknown-role";
    const malformedId = "malformed";
    const missingId = "missing:config->id";
    Memory.data = {
      creepConfigs: {
        [validId]: { role: "worker", args: [], roomName: "W4N4" },
        [unknownRoleId]: { role: "not-a-role", args: [], roomName: "W4N4" },
        [malformedId]: 7,
      },
    } as unknown as Memory["data"];
    const queue = [missingId, 7, "", validId];
    const spawn = createSpawn("Spawn1", "W4N4");
    Game.spawns = { Spawn1: spawn };
    setRawSpawnQueue("Spawn1", queue);

    const result = snapshotSpawnProduction();
    const valid = getEntry(result.entries, validId);
    const missing = getEntry(result.entries, missingId);
    const unknownRole = getEntry(result.entries, unknownRoleId);
    const malformed = getEntry(result.entries, malformedId);

    expect(valid.activity).toBe("available");
    expect(valid.issues).toEqual([]);
    expect(missing.activity).toBe("unknown");
    expect(missing.issues).toEqual([
      expect.objectContaining({ code: "spawn-reference-missing-config" }),
    ]);
    expect(unknownRole.activity).toBe("unknown");
    expect(unknownRole.issues).toEqual([
      expect.objectContaining({ code: "spawn-config-unknown-role" }),
    ]);
    expect(malformed.activity).toBe("unknown");
    expect(malformed.issues).toEqual([
      expect.objectContaining({ code: "spawn-config-malformed" }),
    ]);
    expect(result.invalidCount).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "spawn-queue-reference-invalid",
      "spawn-queue-reference-invalid",
    ]);
    expect(result.entries.map((entry) => entry.ref.localId)).toEqual([
      malformedId,
      missingId,
      unknownRoleId,
      validId,
    ]);
    expect(result.entries).toHaveLength(4);
    expect(queue).toEqual([missingId, 7, "", validId]);
  });

  test("reports sparse args and invalid body elements instead of accepting malformed configs", () => {
    const sparseArgs = new Array<string>(1);
    const invalidBody = ["work", "not-a-body-part"];
    const oversizedBody = Array.from(
      { length: MAX_CREEP_SIZE + 1 },
      () => "move",
    );
    Memory.data = {
      creepConfigs: {
        "sparse-args": { role: "worker", args: sparseArgs, roomName: "W5N5" },
        "invalid-body": {
          role: "worker",
          args: [],
          roomName: "W5N5",
          body: invalidBody,
        },
        "oversized-body": {
          role: "worker",
          args: [],
          roomName: "W5N5",
          body: oversizedBody,
        },
      },
    } as unknown as Memory["data"];

    const result = snapshotSpawnProduction();

    expect(getEntry(result.entries, "sparse-args").activity).toBe("unknown");
    expect(getEntry(result.entries, "sparse-args").issues).toEqual([
      expect.objectContaining({ code: "spawn-config-invalid-args" }),
    ]);
    expect(getEntry(result.entries, "invalid-body").activity).toBe("unknown");
    expect(getEntry(result.entries, "invalid-body").issues).toEqual([
      expect.objectContaining({ code: "spawn-config-invalid-body" }),
    ]);
    expect(getEntry(result.entries, "oversized-body").activity).toBe("unknown");
    expect(getEntry(result.entries, "oversized-body").issues).toEqual([
      expect.objectContaining({ code: "spawn-config-invalid-body" }),
    ]);
    expect(Object.prototype.hasOwnProperty.call(sparseArgs, 0)).toBe(false);
    expect(invalidBody).toEqual(["work", "not-a-body-part"]);
    expect(oversizedBody).toHaveLength(MAX_CREEP_SIZE + 1);
  });

  test("reads queues and config references from raw Memory without touching engine memory getters", () => {
    const configName = "W5N5:worker:0";
    const queue = [configName];
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "worker", args: [], roomName: "W5N5" },
      },
    };
    const spawn = createSpawn("Spawn1", "W5N5", "spawning-creep");
    const spawningCreep = createCreep("spawning-creep", "W5N5", true);
    const liveCreep = createCreep("live-creep", "W5N5");
    let spawnMemoryGetterCalls = 0;
    let spawningMemoryGetterCalls = 0;
    let liveMemoryGetterCalls = 0;
    const spawnPrototype = Object.create(Object.getPrototypeOf(spawn));
    Object.defineProperty(spawnPrototype, "memory", {
      configurable: true,
      get: () => {
        spawnMemoryGetterCalls += 1;
        (Memory as Memory & { getterSideEffect?: boolean }).getterSideEffect = true;
        return { spawnList: ["wrong-config"] };
      },
    });
    Object.setPrototypeOf(spawn, spawnPrototype);
    const spawningPrototype = Object.create(Object.getPrototypeOf(spawningCreep));
    Object.defineProperty(spawningPrototype, "memory", {
      configurable: true,
      get: () => {
        spawningMemoryGetterCalls += 1;
        throw new Error("spawning creep memory getter must not be read");
      },
    });
    Object.setPrototypeOf(spawningCreep, spawningPrototype);
    const livePrototype = Object.create(Object.getPrototypeOf(liveCreep));
    Object.defineProperty(livePrototype, "memory", {
      configurable: true,
      get: () => {
        liveMemoryGetterCalls += 1;
        Memory.creeps.injected = { configName: "wrong-config" } as CreepMemory;
        return Memory.creeps.injected;
      },
    });
    Object.setPrototypeOf(liveCreep, livePrototype);
    Game.spawns = { Spawn1: spawn };
    Game.creeps = {
      "spawning-creep": spawningCreep,
      "live-creep": liveCreep,
    };
    setRawSpawnQueue("Spawn1", queue);
    setRawCreepConfigName("spawning-creep", configName);
    setRawCreepConfigName("live-creep", configName);

    const memoryRootKeys = Object.keys(Memory);
    const memoryBefore = JSON.stringify(Memory);
    const rawSpawnStore = Memory.spawns;
    const rawSpawnRecord = Memory.spawns!.Spawn1;
    const rawCreepStore = Memory.creeps;
    const rawSpawningRecord = Memory.creeps["spawning-creep"];
    const rawLiveRecord = Memory.creeps["live-creep"];

    const result = snapshotSpawnProduction();
    const entry = getEntry(result.entries, configName);

    expect(entry.activity).toBe("running");
    expect(entry.facts.map((fact) => fact.kind)).toEqual([
      "desired",
      "queued",
      "spawning",
      "materialized",
    ]);
    expect(result.invalidCount).toBe(0);
    expect(spawnMemoryGetterCalls).toBe(0);
    expect(spawningMemoryGetterCalls).toBe(0);
    expect(liveMemoryGetterCalls).toBe(0);
    expect(Object.keys(Memory)).toEqual(memoryRootKeys);
    expect(JSON.stringify(Memory)).toBe(memoryBefore);
    expect(Memory.spawns).toBe(rawSpawnStore);
    expect(Memory.spawns!.Spawn1).toBe(rawSpawnRecord);
    expect(Memory.creeps).toBe(rawCreepStore);
    expect(Memory.creeps["spawning-creep"]).toBe(rawSpawningRecord);
    expect(Memory.creeps["live-creep"]).toBe(rawLiveRecord);
    expect(Memory.spawns!.Spawn1.spawnList).toBe(queue);
  });

  test("fails closed for room mismatches and stale transient queue references", () => {
    const roomMismatch = "W5N5:worker:mismatch";
    const transient = "W5N5:manual:maxcarrier:123";
    Memory.data = {
      creepConfigs: {
        [roomMismatch]: { role: "worker", args: [], roomName: "W5N5" },
      },
    };
    Game.spawns = {
      WrongRoom: createSpawn("WrongRoom", "W8N8"),
      Spawn1: createSpawn("Spawn1", "W5N5", "carrier-new"),
    };
    setRawSpawnQueue("WrongRoom", [roomMismatch]);
    setRawSpawnQueue("Spawn1", [transient]);
    setRawCreepConfigName("carrier-new", transient);

    const result = snapshotSpawnProduction();
    const mismatched = getEntry(result.entries, roomMismatch);
    const staleTransient = getEntry(result.entries, transient);

    expect(mismatched.activity).toBe("unknown");
    expect(mismatched.issues).toEqual([
      expect.objectContaining({ code: "spawn-reference-room-mismatch" }),
    ]);
    expect(staleTransient.activity).toBe("unknown");
    expect(staleTransient.issues).toEqual([
      expect.objectContaining({ code: "spawn-transient-stale-queue-reference" }),
    ]);
    expect(staleTransient.issues.some(
      (issue) => issue.code === "spawn-reference-missing-config",
    )).toBe(false);
  });

  test("skips unprovable live identities and rooms while preserving legal siblings", () => {
    const validConfig = "W5N5:worker:valid";
    Memory.data = {
      creepConfigs: {
        [validConfig]: { role: "worker", args: [], roomName: "W5N5" },
      },
    };
    const validCreep = createCreep("valid-creep", "W5N5");
    const emptyIdentity = {
      name: "",
      room: createRoom("W5N5"),
      spawning: false,
    } as unknown as Creep;
    const roomless = {
      name: "roomless",
      room: {},
      spawning: false,
    } as unknown as Creep;
    Game.creeps = {
      "valid-creep": validCreep,
      "": emptyIdentity,
      roomless,
      malformed: 7 as unknown as Creep,
    };
    setRawCreepConfigName("valid-creep", validConfig);
    setRawCreepConfigName("", "must-not-be-projected");
    setRawCreepConfigName("roomless", "must-not-be-projected-either");

    const result = snapshotSpawnProduction();
    const valid = getEntry(result.entries, validConfig);

    expect(valid.activity).toBe("desired");
    expect(valid.facts.map((fact) => fact.kind)).toEqual(["desired", "materialized"]);
    expect(result.invalidCount).toBe(3);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "spawn-live-identity-invalid",
      "spawn-live-record-malformed",
      "spawn-live-room-invalid",
    ]);
    expect(result.entries.map((entry) => entry.ref.localId)).toEqual([validConfig]);
    expect(valid.authorities).not.toContainEqual(
      expect.objectContaining({ role: "assignee", id: "" }),
    );
  });

  test("bounds entry and system diagnostics while retaining the full invalid count", () => {
    const configName = "W7N7:worker:bounded";
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "worker", args: [], roomName: "W7N7" },
      },
    };
    const sourceQueues: unknown[][] = [];
    for (let index = 0; index < 60; index += 1) {
      const spawnName = `Spawn${index}`;
      const queue: unknown[] = [null, null, configName];
      sourceQueues.push(queue);
      Game.spawns[spawnName] = createSpawn(spawnName, "W8N8");
      setRawSpawnQueue(spawnName, queue);
    }

    const first = snapshotSpawnProduction();
    const firstEntry = getEntry(first.entries, configName);
    Game.spawns = Object.fromEntries(
      Object.entries(Game.spawns).reverse(),
    ) as Record<string, StructureSpawn>;
    const second = snapshotSpawnProduction();
    const secondEntry = getEntry(second.entries, configName);

    expect(first.invalidCount).toBe(120);
    expect(first.issues).toHaveLength(100);
    expect(firstEntry.issues).toHaveLength(50);
    expect(firstEntry.activity).toBe("unknown");
    expect(second.issues).toEqual(first.issues);
    expect(secondEntry.issues).toEqual(firstEntry.issues);
    expect(sourceQueues.every((queue) => queue.length === 3)).toBe(true);
  });

  test("returns an empty snapshot without ensuring Memory stores or changing source identities", () => {
    expect(Memory.data).toBeUndefined();
    const gameSpawns = Game.spawns;
    const gameCreeps = Game.creeps;
    const memoryRootKeys = Object.keys(Memory);
    const memorySpawns = Memory.spawns;
    const memoryCreeps = Memory.creeps;
    const privateKeys = Object.keys(global).filter((key) => key.startsWith("__"));

    const result = snapshotSpawnProduction();

    expect(result).toEqual({ entries: [], invalidCount: 0, issues: [] });
    expect(Memory.data).toBeUndefined();
    expect(Game.spawns).toBe(gameSpawns);
    expect(Game.creeps).toBe(gameCreeps);
    expect(Object.keys(Memory)).toEqual(memoryRootKeys);
    expect(Memory.spawns).toBe(memorySpawns);
    expect(Memory.creeps).toBe(memoryCreeps);
    expect(Object.keys(global).filter((key) => key.startsWith("__"))).toEqual(privateKeys);
  });

  test("sorts copied facts deterministically without sort-in-place or output backflow", () => {
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

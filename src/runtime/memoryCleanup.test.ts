import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { clearPickupReservationStoreForTest, getPickupReservationsByRoom } from "@/runtime/energyPickupReservation";
import { reserveProductionResource, listProductionReservations } from "@/runtime/resourceReservation";
import { bootstrapRooms } from "@/runtime/bootstrap";
import {
  clearWorkerTaskBoardForTest,
  peekWorkerTasksByRoom,
  refreshWorkerTasks,
} from "@/runtime/workerTaskPool";
import type { CreepConfig } from "@/types/system";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

const SUPPORTED_ROLE_NAMES = [
  "harvester",
  "mineralHarvester",
  "miner",
  "carrier",
  "worker",
  "upgrader",
  "hubUpgrader",
  "scout",
  "claimer",
  "colonizerHarvester",
  "colonizerWorker",
  "meleeAttacker",
  "healer",
  "homeDefender",
  "crossShardClaimer",
  "crossShardColonizerHarvester",
  "crossShardColonizerWorker",
  "flagScout",
  "remoteCarrier",
  "remoteMiningCarrier",
  "powerBankScout",
  "powerBankAttacker",
  "powerBankHealer",
  "powerBankHauler",
  "remoteMiningReserver",
  "remoteWorker",
  "remoteDefender",
] as const satisfies readonly CreepMemory["role"][];

const UNSUPPORTED_ROLE_NAMES = ["unknownRole", "constructor", "toString", "__proto__"] as const;

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createOwnedRoom(name: string): Room {
  return {
    name,
    memory: {} as RoomMemory,
    controller: {
      my: true,
      level: 8,
    } as StructureController,
    find: () => [],
  } as unknown as Room;
}

function createNormalRepairRoom(name: string): Room {
  const room = createOwnedRoom(name);
  room.controller!.level = 5;
  room.controller!.id = `${name}-controller` as Id<StructureController>;
  room.memory.workerConstructionTier = 3;
  const rampart = {
    id: `${name}-rampart`,
    room,
    structureType: STRUCTURE_RAMPART,
    hits: 6_000,
    hitsMax: 100_000,
  } as StructureRampart;
  room.find = ((type: FindConstant) => {
    if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
      return [rampart];
    }
    return [];
  }) as Room["find"];
  return room;
}

function createManagedCreep(configName: string, role: CreepMemory["role"]): Creep {
  return {
    memory: {
      configName,
      role,
    } as CreepMemory,
  } as unknown as Creep;
}

type ManagedWorkforceRole = "harvester" | "miner" | "mineralHarvester" | "carrier" | "worker";

interface CanonicalManagedConfigFixture {
  configName: string;
  config: CreepConfig;
}

function createCanonicalManagedConfig(
  roomName: string,
  role: ManagedWorkforceRole,
  discriminator: string | number,
): CanonicalManagedConfigFixture {
  const discriminatorText = String(discriminator);
  const args = role === "carrier" || role === "worker" ? [] : [discriminatorText];
  return {
    configName: `${roomName}:${role}:${discriminatorText}`,
    config: { role, args, roomName },
  };
}

function createSpawn(
  name: string,
  room: Room,
  queue: string[],
  options: { active?: boolean; spawningName?: string } = {},
): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    room,
    memory: { spawnList: [...queue] },
    spawning: options.spawningName ? ({ name: options.spawningName } as Spawning) : null,
    isActive: jest.fn(() => options.active ?? true),
  } as unknown as StructureSpawn;
}

function snapshotManagedGcState(): {
  configs: Record<string, CreepConfig>;
  queues: Record<string, string[]>;
} {
  return {
    configs: Object.fromEntries(
      Object.entries(Memory.data?.creepConfigs ?? {}).map(([configName, config]) => [
        configName,
        { ...config, args: [...config.args] },
      ]),
    ),
    queues: Object.fromEntries(
      Object.values(Game.spawns).map((spawn) => [spawn.name, [...(spawn.memory.spawnList ?? [])]]),
    ),
  };
}

describe("runMemoryCleanup", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearPickupReservationStoreForTest();
    clearWorkerTaskBoardForTest();
    Game.time = 17;
    Game.rooms = {
      W1N1: createOwnedRoom("W1N1"),
    };
    Game.creeps = {};
    Game.spawns = {};
    getPickupReservationsByRoom("W2N2").target1 = {
      kind: "structure",
      claims: {
        DeadCarrier: {
          amount: 50,
          until: 10,
        },
      },
    };
    Memory.creeps = {};
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("does not prune link network cache outside the 17-tick cleanup cadence", () => {
    Game.time = 18;
    Memory.runtime = {
      linkNetwork: {
        W1N1: {
          updatedAt: 10,
          senderIds: ["owned-sender"],
          receiverIds: ["owned-receiver"],
        },
        W9N9: {
          updatedAt: 11,
          senderIds: ["unseen-sender"],
          receiverIds: ["unseen-receiver"],
        },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Memory.runtime?.linkNetwork).toEqual({
      W1N1: {
        updatedAt: 10,
        senderIds: ["owned-sender"],
        receiverIds: ["owned-receiver"],
      },
      W9N9: {
        updatedAt: 11,
        senderIds: ["unseen-sender"],
        receiverIds: ["unseen-receiver"],
      },
    });
  });

  it("keeps owned link cache and prunes visible-lost and unseen rooms on tick 17", () => {
    const visibleLostRoom = createOwnedRoom("W2N2");
    visibleLostRoom.controller!.my = false;
    Game.rooms = {
      W1N1: createOwnedRoom("W1N1"),
      W2N2: visibleLostRoom,
    };
    Memory.runtime = {
      linkNetwork: {
        W1N1: {
          updatedAt: 10,
          senderIds: ["owned-sender"],
          receiverIds: ["owned-receiver"],
        },
        W2N2: {
          updatedAt: 11,
          senderIds: ["lost-sender"],
          receiverIds: ["lost-receiver"],
        },
        W9N9: {
          updatedAt: 12,
          senderIds: ["unseen-sender"],
          receiverIds: ["unseen-receiver"],
        },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Memory.runtime?.linkNetwork).toEqual({
      W1N1: {
        updatedAt: 10,
        senderIds: ["owned-sender"],
        receiverIds: ["owned-receiver"],
      },
    });
  });

  it("preserves an empty link network container after pruning its last stale room", () => {
    Memory.runtime = {
      linkNetwork: {
        W9N9: {
          updatedAt: 12,
          senderIds: ["unseen-sender"],
          receiverIds: ["unseen-receiver"],
        },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Memory.runtime?.linkNetwork).toEqual({});
  });

  it("does not create link network memory when no cache exists", () => {
    Memory.runtime = undefined;

    runMemoryCleanup();

    expect(Memory.runtime?.linkNetwork).toBeUndefined();
  });

  it("continues cleaning dead creep memory while pruning stale link cache", () => {
    Memory.creeps.DeadWorker = {
      role: "worker",
    } as CreepMemory;
    Memory.runtime = {
      linkNetwork: {
        W9N9: {
          updatedAt: 12,
          senderIds: ["unseen-sender"],
          receiverIds: ["unseen-receiver"],
        },
      },
    } as Memory["runtime"];

    runMemoryCleanup();

    expect(Memory.creeps.DeadWorker).toBeUndefined();
    expect(Memory.runtime?.linkNetwork).toEqual({});
  });

  it("leaves visible managed-room canonical configs to bootstrap without scanning workforce policy", () => {
    Game.time = 51;
    const room = createOwnedRoom("W5N1");
    room.controller!.level = 5;
    room.memory.workerConstructionTier = 3;
    const findSpy = jest.fn(() => []);
    room.find = findSpy as Room["find"];
    Game.rooms = { [room.name]: room };
    const surplus = createCanonicalManagedConfig(room.name, "worker", 9);
    Memory.data = {
      creepConfigs: {
        [surplus.configName]: surplus.config,
      },
    } as Memory["data"];
    const spawn = createSpawn("Spawn1", room, [surplus.configName]);
    Game.spawns = { [spawn.name]: spawn };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[surplus.configName]).toEqual(surplus.config);
    expect(spawn.memory.spawnList).toEqual([surplus.configName]);
    expect(findSpy).not.toHaveBeenCalled();
    expect(room.memory.workerConstructionTier).toBe(3);
  });

  it("independently observes cleanup, normal-repair refresh, and bootstrap workforce in tick 51", () => {
    Game.time = 51;
    const room = createNormalRepairRoom("W5N1");
    Game.rooms = { [room.name]: room };
    const bonusWorker = createCanonicalManagedConfig(room.name, "worker", 1);
    Memory.data = {
      creepConfigs: {
        [bonusWorker.configName]: bonusWorker.config,
      },
    } as Memory["data"];
    const spawn = createSpawn("Spawn1", room, [bonusWorker.configName]);
    Game.spawns = { [spawn.name]: spawn };

    expect(peekWorkerTasksByRoom(room.name)).toEqual({});

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[bonusWorker.configName]).toEqual(bonusWorker.config);
    expect(spawn.memory.spawnList).toEqual([bonusWorker.configName]);
    expect(room.memory.workerConstructionTier).toBe(3);
    expect(peekWorkerTasksByRoom(room.name)).toEqual({});

    refreshWorkerTasks();

    expect(Object.values(peekWorkerTasksByRoom(room.name))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "repair",
          repairMode: "normal",
          status: "active",
        }),
      ]),
    );
    expect(room.memory.workerConstructionTier).toBe(3);

    bootstrapRooms();

    expect(Memory.data?.creepConfigs?.[bonusWorker.configName]).toEqual(bonusWorker.config);
    expect(spawn.memory.spawnList).toEqual([bonusWorker.configName]);
    expect(room.memory.workerConstructionTier).toBe(0);
    expect(Memory.data?.creepConfigs?.[`${room.name}:worker:0`]).toEqual({
      role: "worker",
      args: [],
      roomName: room.name,
    });
  });

  it("preserves a queued-only manual max-carrier config and its queue request", () => {
    const room = Game.rooms.W1N1;
    const configName = `${room.name}:manual:maxcarrier:${Game.time}`;
    const config: CreepConfig = {
      role: "carrier",
      args: [],
      roomName: room.name,
      body: [CARRY, MOVE],
    };
    const spawn = createSpawn("Spawn1", room, [configName]);
    Game.spawns = { [spawn.name]: spawn };
    Memory.data = { creepConfigs: { [configName]: config } };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[configName]).toEqual(config);
    expect(spawn.memory.spawnList).toEqual([configName]);
  });

  it.each([
    {
      mismatch: "role",
      configName: "W6N6:worker:0",
      config: { role: "carrier", args: [], roomName: "W6N6" } as CreepConfig,
    },
    {
      mismatch: "args",
      configName: "W6N6:carrier:0",
      config: { role: "carrier", args: ["unexpected"], roomName: "W6N6" } as CreepConfig,
    },
    {
      mismatch: "roomName",
      configName: "W6N6:worker:0",
      config: { role: "worker", args: [], roomName: "W6N7" } as CreepConfig,
    },
  ])("preserves canonical-looking $mismatch mismatch config and queue fail-safe", ({ configName, config }) => {
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [configName]);
    Game.spawns = { [spawn.name]: spawn };
    Memory.data = { creepConfigs: { [configName]: config } };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[configName]).toEqual(config);
    expect(spawn.memory.spawnList).toEqual([configName]);
  });

  it("retires idle and live canonical configs when a visible owned room becomes reserved", () => {
    const room = createOwnedRoom("W4N4");
    Game.rooms = { [room.name]: room };
    Memory.cfg = { rooms: { [room.name]: { type: "reserved" } } };
    const idle = createCanonicalManagedConfig(room.name, "worker", 0);
    const live = createCanonicalManagedConfig(room.name, "carrier", 0);
    Memory.data = {
      creepConfigs: {
        [idle.configName]: idle.config,
        [live.configName]: live.config,
      },
    };
    Game.creeps.LiveCarrier = createManagedCreep(live.configName, live.config.role);
    const spawn = createSpawn("Spawn1", room, [idle.configName, live.configName]);
    Game.spawns = { [spawn.name]: spawn };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[idle.configName]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[live.configName]).toEqual({
      role: live.config.role,
      args: live.config.args,
    });
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("deletes an idle lost-room config and orphans live configs for all five managed roles", () => {
    const lostRoomName = "W9N9";
    const idle = createCanonicalManagedConfig(lostRoomName, "worker", 8);
    const liveConfigs = [
      createCanonicalManagedConfig(lostRoomName, "harvester", "source-h"),
      createCanonicalManagedConfig(lostRoomName, "miner", "source-m"),
      createCanonicalManagedConfig(lostRoomName, "mineralHarvester", "mineral-a"),
      createCanonicalManagedConfig(lostRoomName, "carrier", 0),
      createCanonicalManagedConfig(lostRoomName, "worker", 0),
    ];
    Memory.data = {
      creepConfigs: Object.fromEntries(
        [idle, ...liveConfigs].map(({ configName, config }) => [configName, config]),
      ),
    };
    Game.creeps = Object.fromEntries(
      liveConfigs.map(({ configName, config }, index) => [
        `LiveManaged${index}`,
        createManagedCreep(configName, config.role),
      ]),
    );
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [
      idle.configName,
      ...liveConfigs.map(({ configName }) => configName),
    ]);
    Game.spawns = { [spawn.name]: spawn };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[idle.configName]).toBeUndefined();
    for (const { configName, config } of liveConfigs) {
      expect(Memory.data?.creepConfigs?.[configName]).toEqual({
        role: config.role,
        args: config.args,
      });
    }
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("still owns canonical configs carrying body, name, and spawnOnce extensions", () => {
    const lostRoomName = "W2N2";
    const idle = createCanonicalManagedConfig(lostRoomName, "worker", 0);
    const live = createCanonicalManagedConfig(lostRoomName, "carrier", 0);
    const extendedIdle: CreepConfig = {
      ...idle.config,
      body: [WORK, MOVE],
      name: "ExtendedIdleWorker",
      spawnOnce: { queuedAt: Game.time - 1 },
    };
    const extendedLive: CreepConfig = {
      ...live.config,
      body: [CARRY, MOVE],
      name: "ExtendedLiveCarrier",
      spawnOnce: { queuedAt: Game.time },
    };
    Memory.data = {
      creepConfigs: {
        [idle.configName]: extendedIdle,
        [live.configName]: extendedLive,
      },
    };
    Game.creeps.ExtendedLiveCarrier = createManagedCreep(live.configName, live.config.role);
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [idle.configName, live.configName]);
    Game.spawns = { [spawn.name]: spawn };
    const expectedOrphan = { ...extendedLive };
    delete expectedOrphan.roomName;

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs?.[idle.configName]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[live.configName]).toEqual(expectedOrphan);
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("preserves Game.creeps spawning and Spawn-memory in-flight references before dead-memory cleanup", () => {
    const lostRoomName = "W8N8";
    const gameSpawning = createCanonicalManagedConfig(lostRoomName, "worker", 0);
    const memorySpawning = createCanonicalManagedConfig(lostRoomName, "carrier", 0);
    Memory.data = {
      creepConfigs: {
        [gameSpawning.configName]: gameSpawning.config,
        [memorySpawning.configName]: memorySpawning.config,
      },
    };
    const gameSpawningName = "GameSpawningWorker";
    Game.creeps[gameSpawningName] = {
      ...createManagedCreep(gameSpawning.configName, gameSpawning.config.role),
      name: gameSpawningName,
      spawning: true,
    } as Creep;
    Memory.creeps[gameSpawningName] = {
      role: gameSpawning.config.role,
      configName: gameSpawning.configName,
    } as CreepMemory;
    const memorySpawningName = "MemorySpawningCarrier";
    Memory.creeps[memorySpawningName] = {
      role: memorySpawning.config.role,
      configName: memorySpawning.configName,
    } as CreepMemory;
    const spawnA = createSpawn("SpawnA", Game.rooms.W1N1, [gameSpawning.configName], {
      spawningName: gameSpawningName,
    });
    const spawnB = createSpawn("SpawnB", Game.rooms.W1N1, [memorySpawning.configName], {
      spawningName: memorySpawningName,
    });
    Game.spawns = { [spawnA.name]: spawnA, [spawnB.name]: spawnB };

    runMemoryCleanup();

    for (const { configName, config } of [gameSpawning, memorySpawning]) {
      expect(Memory.data?.creepConfigs?.[configName]).toEqual({
        role: config.role,
        args: config.args,
      });
    }
    expect(Memory.creeps[gameSpawningName]).toBeDefined();
    expect(Memory.creeps[memorySpawningName]).toBeDefined();
    expect(spawnA.memory.spawnList).toEqual([]);
    expect(spawnB.memory.spawnList).toEqual([]);
  });

  it("does not treat isolated creep Memory or queue-only production intent as live references", () => {
    const lostRoomName = "W7N7";
    const isolatedMemory = createCanonicalManagedConfig(lostRoomName, "worker", 0);
    const queueOnly = createCanonicalManagedConfig(lostRoomName, "carrier", 0);
    Memory.data = {
      creepConfigs: {
        [isolatedMemory.configName]: isolatedMemory.config,
        [queueOnly.configName]: queueOnly.config,
      },
    };
    const deadCreepName = "DeadManagedWorker";
    Memory.creeps[deadCreepName] = {
      role: isolatedMemory.config.role,
      configName: isolatedMemory.configName,
    } as CreepMemory;
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [queueOnly.configName]);
    Game.spawns = { [spawn.name]: spawn };

    runMemoryCleanup();

    expect(Memory.creeps[deadCreepName]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[isolatedMemory.configName]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[queueOnly.configName]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual([]);
  });

  it("retires multi-Spawn duplicates independently of Game.spawns enumeration order", () => {
    const unrelated = ["manual:keep-a", "manual:keep-b", "manual:keep-c", "manual:keep-d"];
    const runScenario = (spawnOrder: readonly ["SpawnActive" | "SpawnInactive", "SpawnActive" | "SpawnInactive"]) => {
      resetRuntimeServices();
      const stale = createCanonicalManagedConfig("W6N6", "worker", 0);
      Memory.data = {
        creepConfigs: {
          [stale.configName]: stale.config,
          ...Object.fromEntries(
            unrelated.map((configName) => [configName, { role: "flagScout", args: [] } as CreepConfig]),
          ),
        },
      };
      const activeSpawn = createSpawn(
        "SpawnActive",
        Game.rooms.W1N1,
        [stale.configName, unrelated[0], stale.configName, unrelated[1], stale.configName],
        { active: true },
      );
      const inactiveSpawn = createSpawn(
        "SpawnInactive",
        Game.rooms.W1N1,
        [unrelated[2], stale.configName, unrelated[3], stale.configName],
        { active: false },
      );
      const spawns = { SpawnActive: activeSpawn, SpawnInactive: inactiveSpawn };
      Game.spawns = Object.fromEntries(spawnOrder.map((spawnName) => [spawnName, spawns[spawnName]]));

      runMemoryCleanup();

      return {
        staleConfig: Memory.data?.creepConfigs?.[stale.configName],
        unrelatedConfigsPresent: unrelated.map(
          (configName) => Memory.data?.creepConfigs?.[configName] !== undefined,
        ),
        queues: {
          SpawnActive: [...(activeSpawn.memory.spawnList ?? [])],
          SpawnInactive: [...(inactiveSpawn.memory.spawnList ?? [])],
        },
      };
    };
    const expected = {
      staleConfig: undefined,
      unrelatedConfigsPresent: unrelated.map(() => true),
      queues: {
        SpawnActive: unrelated.slice(0, 2),
        SpawnInactive: unrelated.slice(2),
      },
    };

    const forward = runScenario(["SpawnActive", "SpawnInactive"]);
    const reverse = runScenario(["SpawnInactive", "SpawnActive"]);

    expect(forward).toEqual(expected);
    expect(reverse).toEqual(expected);
    expect(reverse).toEqual(forward);
  });

  it("is idempotent after deleting idle configs, orphaning live configs, and filtering queues", () => {
    const lostRoomName = "W3N3";
    const idle = createCanonicalManagedConfig(lostRoomName, "worker", 0);
    const live = createCanonicalManagedConfig(lostRoomName, "carrier", 0);
    const manualConfigName = `${lostRoomName}:manual:maxcarrier:${Game.time}`;
    Memory.data = {
      creepConfigs: {
        [idle.configName]: idle.config,
        [live.configName]: live.config,
        [manualConfigName]: { role: "carrier", args: [], roomName: lostRoomName },
      },
    };
    Game.creeps.LiveCarrier = createManagedCreep(live.configName, live.config.role);
    const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [
      idle.configName,
      live.configName,
      manualConfigName,
    ]);
    Game.spawns = { [spawn.name]: spawn };

    runMemoryCleanup();
    const afterFirstCleanup = snapshotManagedGcState();

    runMemoryCleanup();

    expect(snapshotManagedGcState()).toEqual(afterFirstCleanup);
  });

  it("removes foreign room pickup reservation memory after claims expire", () => {
    runMemoryCleanup();

    expect(getPickupReservationsByRoom("W2N2")).toEqual({});
  });

  it("removes expired production reservations via gcProductionReservations", () => {
    reserveProductionResource("W1N1", "energy" as ResourceConstant, 500, "expiredCarrier");
    const store = Memory.runtime!.resourceReservations!;
    store["W1N1:energy:expiredCarrier"].expiresAt = Game.time - 1;

    reserveProductionResource("W1N1", "energy" as ResourceConstant, 300, "activeCarrier");

    runMemoryCleanup();

    const remaining = listProductionReservations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].holderId).toBe("activeCarrier");
  });

  it("removes recovery runtime entries whose room flag is false or missing", () => {
    Memory.cfg = {
      energyPickup: {
        terminalBootstrapRecoveryRooms: {
          W1N1: true,
          W2N2: false,
        },
      },
    };
    Memory.runtime = {
      energyPickup: {
        terminalBootstrapRecovery: {
          W1N1: { healthySince: 10, lastObservedAt: 16 },
          W2N2: { healthySince: 11, lastObservedAt: 16 },
          W3N3: { healthySince: 12, lastObservedAt: 16 },
        },
      },
    };

    runMemoryCleanup();

    expect(Memory.runtime?.energyPickup?.terminalBootstrapRecovery).toEqual({
      W1N1: { healthySince: 10, lastObservedAt: 16 },
    });
  });

  it("removes empty recovery runtime containers during periodic cleanup", () => {
    Memory.cfg = {
      energyPickup: {
        terminalBootstrapRecoveryRooms: {},
      },
    };
    Memory.runtime = {
      energyPickup: {
        terminalBootstrapRecovery: {
          W2N2: { lastObservedAt: 16 },
        },
      },
    };

    runMemoryCleanup();

    expect(Memory.runtime?.energyPickup).toBeUndefined();
  });

  it.each(SUPPORTED_ROLE_NAMES)(
    "keeps generic config and same-cadence queue entry for supported role %s",
    (role) => {
      const configName = `manual:role-catalog:${role}`;
      const config: CreepConfig = { role, args: [] };
      const spawn = createSpawn("Spawn1", Game.rooms.W1N1, [configName]);
      Game.spawns = { [spawn.name]: spawn };
      Memory.data = { creepConfigs: { [configName]: config } };

      runMemoryCleanup();

      expect(Memory.data?.creepConfigs?.[configName]).toEqual(config);
      expect(spawn.memory.spawnList).toEqual([configName]);
    },
  );

  it.each(UNSUPPORTED_ROLE_NAMES)(
    "deletes unsupported role %s before trimming its queue entry on the next cleanup pass",
    (role) => {
      const invalidConfigName = `manual:invalid-role:${role}`;
      const validConfigName = "manual:valid-role:flagScout";
      const invalidConfig = { role, args: [] } as unknown as CreepConfig;
      const validConfig: CreepConfig = { role: "flagScout", args: [] };
      const originalQueue = [invalidConfigName, validConfigName, invalidConfigName];
      const spawn = createSpawn("Spawn1", Game.rooms.W1N1, originalQueue);
      Game.spawns = { [spawn.name]: spawn };
      Memory.data = {
        creepConfigs: {
          [invalidConfigName]: invalidConfig,
          [validConfigName]: validConfig,
        },
      };

      runMemoryCleanup();

      expect(Memory.data?.creepConfigs?.[invalidConfigName]).toBeUndefined();
      expect(Memory.data?.creepConfigs?.[validConfigName]).toEqual(validConfig);
      expect(spawn.memory.spawnList).toEqual(originalQueue);

      Game.time += 17;
      runMemoryCleanup();

      expect(spawn.memory.spawnList).toEqual([validConfigName]);
    },
  );

  it("delegates generic role validity to the shared role catalog gate", () => {
    const catalogOnlyRole = "catalogOnlyRole";
    const catalogConfigName = "manual:catalog-gate:accepted";
    const rejectedConfigName = "manual:catalog-gate:rejected";
    Memory.data = {
      creepConfigs: {
        [catalogConfigName]: { role: catalogOnlyRole, args: [] } as unknown as CreepConfig,
        [rejectedConfigName]: { role: "worker", args: [] },
      },
    };

    jest.doMock(
      "@/types/roleCatalog",
      () => ({
        isRoleName: (value: unknown): boolean => value === catalogOnlyRole,
      }),
      { virtual: true },
    );

    try {
      jest.isolateModules(() => {
        const isolatedModule = require("@/runtime/memoryCleanup") as typeof import("@/runtime/memoryCleanup");
        isolatedModule.runMemoryCleanup();
      });
    } finally {
      jest.dontMock("@/types/roleCatalog");
    }

    expect(Memory.data?.creepConfigs?.[catalogConfigName]).toEqual({
      role: catalogOnlyRole,
      args: [],
    });
    expect(Memory.data?.creepConfigs?.[rejectedConfigName]).toBeUndefined();
  });

  it("keeps supported non-legacy creep configs for active specialized roles", () => {
    Memory.data = {
      creepConfigs: {
        mineralConfig: { role: "mineralHarvester", args: [] },
        defenderConfig: { role: "homeDefender", args: [] },
        scoutConfig: { role: "flagScout", args: [] },
      },
    };
    Game.creeps = {
      MineralHarvester1: createManagedCreep("mineralConfig", "mineralHarvester"),
      HomeDefender1: createManagedCreep("defenderConfig", "homeDefender"),
      FlagScout1: createManagedCreep("scoutConfig", "flagScout"),
    };

    runMemoryCleanup();

    expect(Memory.data?.creepConfigs).toMatchObject({
      mineralConfig: { role: "mineralHarvester" },
      defenderConfig: { role: "homeDefender" },
      scoutConfig: { role: "flagScout" },
    });
  });

  it("removes stale powerbank boost prep and boost pause when task no longer exists", () => {
    Memory.runtime = {
      powerBankBoost: {
        "pb-ghost": {
          taskId: "pb-ghost",
          sourceRoomName: "W1N1",
          labs: {
            [RESOURCE_CATALYZED_UTRIUM_ACID]: {
              labId: "W1N1-lab-1",
              compound: RESOURCE_CATALYZED_UTRIUM_ACID,
            },
          },
        },
      },
      synthesisControl: {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W1N1: {
            stage: "idle",
            lastTransitionAt: Game.time,
            boostPause: {
              reason: "powerBankBoost",
              taskId: "pb-ghost",
              createdTick: Game.time - 200,
              pausedPlan: null,
              pausedStage: "synthesizing",
            },
          },
        },
      },
    } as unknown as Memory["runtime"];
    Memory.data = {
      powerBankHarvest: {},
    } as Memory["data"];

    runMemoryCleanup();

    expect(Memory.runtime?.powerBankBoost?.["pb-ghost"]).toBeUndefined();
    expect((Memory.runtime as any).synthesisControl.rooms.W1N1.boostPause).toBeUndefined();
  });
});

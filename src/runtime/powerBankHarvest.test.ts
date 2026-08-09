import { runPowerBankHarvest } from "@/runtime/powerBankHarvest";
import { POWER_BANK_STATUS, getPowerBankConfigName } from "@/runtime/powerBankConstants";
import { getCreepConfigService, registerRuntimeServices } from "@/runtime/runtimeServices";
import { clearDefenseModeCacheForTest } from "@/runtime/defenseMode";
import { mountSpawn } from "@/mount/mountSpawn";
import { isSynthesisPaused } from "@/runtime/synthesisControl";
import { createMockStore, createMockPowerBankCreep, createMockPowerBank, createMockLab } from "@mock/powerBank";
import { MockPos } from "@mock/powerBank";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type PowerBankTestMemory = CreepMemory & { taskId?: string };
type StructureSpawnTestGlobal = typeof global & {
  StructureSpawn: {
    prototype: {
      mainSpawn: (this: StructureSpawn, configName: string) => boolean;
    };
  };
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const SOURCE_ROOM = "E5N55";
const SECONDARY_SOURCE_ROOM = "E6N55";
const TARGET_ROOM = "E0N60";
const PATROL_SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

function makeTask(overrides: Partial<PowerBankHarvestTask> = {}): PowerBankHarvestTask {
  return {
    id: overrides.id ?? "pb-test",
    status: overrides.status ?? POWER_BANK_STATUS.DISCOVERED,
    sourceRoom: overrides.sourceRoom ?? "",
    targetRoom: overrides.targetRoom ?? TARGET_ROOM,
    bankId: overrides.bankId ?? "bank-0",
    bankPos: overrides.bankPos ?? { x: 25, y: 25 },
    hits: overrides.hits ?? 2_000_000,
    power: overrides.power ?? 5000,
    ticksToDecay: overrides.ticksToDecay ?? 5000,
    freeTiles: overrides.freeTiles ?? 8,
    discoveredTick: overrides.discoveredTick ?? 1,
    lastSeenTick: overrides.lastSeenTick ?? 1,
    attackerId: overrides.attackerId,
    healerId: overrides.healerId,
    haulerIds: overrides.haulerIds ?? [],
    boostLabs: overrides.boostLabs ?? [],
    compoundTransferTaskIds: overrides.compoundTransferTaskIds ?? [],
    tier: overrides.tier,
    routeDistance: overrides.routeDistance ?? 5,
    haulerCount: overrides.haulerCount,
    failReason: overrides.failReason,
    terminalTick: overrides.terminalTick,
    attackerReady: overrides.attackerReady,
    healerReady: overrides.healerReady,
    haulingStartedTick: overrides.haulingStartedTick,
    haulingEmptySince: overrides.haulingEmptySince,
    reinforcement: overrides.reinforcement,
    bankExpiresAt: overrides.bankExpiresAt,
    stageEnteredAt: overrides.stageEnteredAt,
    lastProgressAt: overrides.lastProgressAt,
    lastBankHits: overrides.lastBankHits,
    lastBankProgressAt: overrides.lastBankProgressAt,
    lastVisibleAt: overrides.lastVisibleAt,
    blocker: overrides.blocker,
    nextAttemptAt: overrides.nextAttemptAt,
    activeGeneration: overrides.activeGeneration,
    activeIndex: overrides.activeIndex,
    combatReady: overrides.combatReady,
    primaryBoostOwnerId: overrides.primaryBoostOwnerId,
    primaryBoostLabs: overrides.primaryBoostLabs,
    routeRooms: overrides.routeRooms,
    avoidRooms: overrides.avoidRooms,
    plannedDps: overrides.plannedDps,
    plannedHps: overrides.plannedHps,
    plannedTtk: overrides.plannedTtk,
    plannedKillTick: overrides.plannedKillTick,
    minimumCombatTtl: overrides.minimumCombatTtl,
    bankGoneTick: overrides.bankGoneTick,
    haulingDeadlineAt: overrides.haulingDeadlineAt,
    observedPower: overrides.observedPower,
    pickedUpPower: overrides.pickedUpPower,
    deliveredPower: overrides.deliveredPower,
    lostPower: overrides.lostPower,
    outcome: overrides.outcome,
    terminalCleanupDone: overrides.terminalCleanupDone,
  };
}

function setupOwnedRoom(
  roomName: string,
  opts: {
    rcl?: number;
    energyCapacity?: number;
    compounds?: Partial<Record<ResourceConstant, number>>;
    spawnCount?: number;
    storeCapacity?: number;
    labCount?: number;
  } = {},
): Room {
  const compounds = opts.compounds ?? {
    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
    [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
  };
  const storageResources = {
    [RESOURCE_ENERGY]: 50_000,
    ...compounds,
  } as Record<string, number>;
  const labs = Array.from({ length: opts.labCount ?? 2 }, (_, index) => createMockLab({
    id: `${roomName}-lab${index}`,
    roomName,
    store: { [RESOURCE_ENERGY]: 3000 },
  }));
  const room = {
    name: roomName,
    controller: { my: true, level: opts.rcl ?? 8 },
    energyCapacityAvailable: opts.energyCapacity ?? 12_000,
    storage: {
      store: createMockStore(storageResources, opts.storeCapacity ?? 100_000),
    },
    terminal: {
      store: createMockStore({}, opts.storeCapacity ?? 50_000),
      cooldown: 0,
    },
    find: jest.fn(() => labs),
  } as unknown as Room;
  Game.rooms[roomName] = room;

  for (let index = 1; index <= (opts.spawnCount ?? 1); index += 1) {
    Game.spawns[`${roomName}-spawn${index}`] = {
      name: `${roomName}-spawn${index}`,
      room,
      memory: { spawnList: [] },
      spawning: null,
      isActive: () => true,
      renewCreep: jest.fn((_creep: Creep) => OK),
    } as unknown as StructureSpawn;
  }

  return room;
}

function setupSourceRoom(opts: { rcl?: number; energyCapacity?: number; hasStorage?: boolean; hasTerminal?: boolean; spawnCount?: number } = {}): void {
  const rcl = opts.rcl ?? 8;
  const energyCapacity = opts.energyCapacity ?? 12_000;
  const spawnCount = opts.spawnCount ?? 1;
  const storage = opts.hasStorage !== false
    ? {
        store: createMockStore({
          [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
          [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
          [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
        }),
      }
    : null;
  const terminal = opts.hasTerminal !== false
    ? { store: createMockStore({}), cooldown: 0 }
    : null;

  const room = {
    name: SOURCE_ROOM,
    controller: { my: true, level: rcl },
    energyCapacityAvailable: energyCapacity,
    storage,
    terminal,
    find: () => [],
  } as unknown as Room;

  Game.rooms[SOURCE_ROOM] = room;

  for (let index = 1; index <= spawnCount; index += 1) {
    const spawn = {
      name: `${SOURCE_ROOM}-spawn${index}`,
      room,
      memory: { spawnList: [] },
      spawning: null,
      isActive: () => true,
      renewCreep: jest.fn((_creep: Creep) => OK),
    } as unknown as StructureSpawn;

    Game.spawns[spawn.name] = spawn;
  }
}

function setupTargetRoom(): void {
  Game.rooms[TARGET_ROOM] = {
    name: TARGET_ROOM,
    find: () => [],
  } as unknown as Room;
}

function setupGameMap(): void {
  if (!Game.map) (Game as any).map = {} as GameMap;
  Game.map.getRoomLinearDistance = jest.fn(() => 5);
  Game.map.findRoute = jest.fn(() => [{ room: "corridor", exit: FIND_EXIT_RIGHT }]);
}

function setupStore(): Record<string, PowerBankHarvestTask> {
  if (!Memory.data) Memory.data = {};
  Memory.data.powerBankHarvest = {};
  Memory.data.powerBankHarvestHistory = [];
  return Memory.data.powerBankHarvest;
}

function addTask(task: PowerBankHarvestTask): void {
  const store = Memory.data!.powerBankHarvest!;
  store[task.id] = task;
}

function getTask(id: string): PowerBankHarvestTask | undefined {
  return Memory.data?.powerBankHarvest?.[id];
}

function mockPrepareBoosts(status: "preparing" | "ready" | "failed", labs: string[] = []): jest.SpyInstance {
  const mod = require("@/runtime/powerBankBoost");
  return jest.spyOn(mod, "prepareBoosts").mockReturnValue({ status, labs });
}

function mockReleaseBoostLabs(): jest.SpyInstance {
  const mod = require("@/runtime/powerBankBoost");
  return jest.spyOn(mod, "releaseBoostLabs").mockImplementation(() => {});
}

function mockAssessViability(viable: boolean, reasons: string[] = []): jest.SpyInstance {
  const mod = require("@/runtime/powerBankViability");
  return jest.spyOn(mod, "assessViability").mockReturnValue({
    viable,
    reasons,
    estimates: {
      ttk: 3000,
      dps: 1920,
      hitbackDPS: 960,
      healerHPS: 336,
      timeBudget: 4000,
      haulerCount: 4,
      haulDepartTick: 3100,
    },
  });
}

function mockSelectBodyTier(tierKind: string): jest.SpyInstance {
  const mod = require("@/runtime/powerBankViability");
  return jest.spyOn(mod, "selectBodyTier").mockReturnValue({
    attackerTier: tierKind,
    healerTier: tierKind,
  });
}

function setupOwnedCombatPair(options: {
  taskId: string;
  generation?: number;
  index?: number;
  roomName?: string;
  attackerId?: string;
  healerId?: string;
  attackerName?: string;
  healerName?: string;
  ticksToLive?: number;
}): { attacker: Creep; healer: Creep } {
  const generation = options.generation ?? 0;
  const index = options.index ?? generation;
  const roomName = options.roomName ?? TARGET_ROOM;
  const attackerConfigName = getPowerBankConfigName(
    SOURCE_ROOM,
    TARGET_ROOM,
    "attacker",
    index,
    options.taskId,
    generation,
  );
  const healerConfigName = getPowerBankConfigName(
    SOURCE_ROOM,
    TARGET_ROOM,
    "healer",
    index,
    options.taskId,
    generation,
  );
  const attacker = createMockPowerBankCreep("powerBankAttacker", {
    name: options.attackerName ?? `attacker-g${generation}`,
    id: options.attackerId ?? `attacker-g${generation}-id`,
    roomName,
    x: 24,
    y: 24,
    memory: {
      role: "powerBankAttacker",
      taskId: options.taskId,
      configName: attackerConfigName,
      pairGeneration: generation,
    } as Partial<CreepMemory>,
    body: [
      { type: TOUGH as BodyPartConstant, hits: 100 },
      { type: ATTACK as BodyPartConstant, hits: 100 },
      { type: MOVE as BodyPartConstant, hits: 100 },
    ],
  });
  const healer = createMockPowerBankCreep("powerBankHealer", {
    name: options.healerName ?? `healer-g${generation}`,
    id: options.healerId ?? `healer-g${generation}-id`,
    roomName,
    x: 25,
    y: 24,
    memory: {
      role: "powerBankHealer",
      taskId: options.taskId,
      configName: healerConfigName,
      pairGeneration: generation,
    } as Partial<CreepMemory>,
    body: [
      { type: HEAL as BodyPartConstant, hits: 100 },
      { type: MOVE as BodyPartConstant, hits: 100 },
    ],
  });
  if (options.ticksToLive !== undefined) {
    (attacker as Creep & { ticksToLive: number }).ticksToLive = options.ticksToLive;
    (healer as Creep & { ticksToLive: number }).ticksToLive = options.ticksToLive;
  }
  Game.creeps[attacker.name] = attacker;
  Game.creeps[healer.name] = healer;
  return { attacker, healer };
}

function mockObjects(...objects: Array<{ id: string }>): void {
  Game.getObjectById = jest.fn((id: string) =>
    objects.find((object) => object.id === id) ?? null,
  ) as unknown as typeof Game.getObjectById;
}

describe("powerBankHarvest", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    Game.time = 100;
    Game.creeps = {};
    Game.spawns = {};
    Game.rooms = {};
    Memory.creeps = {};
    setupGameMap();
    setupStore();
    jest.restoreAllMocks();
    clearDefenseModeCacheForTest();
    mockPrepareBoosts("ready");
  });

  describe("boosting", () => {

    it("writes taskId into attacker and healer creep memory when transitioning to travelling", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      // Remove taskId pre-populated by mock factory
      delete (attacker.memory as any).taskId;
      delete (healer.memory as any).taskId;

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        id: "pb-taskid-test",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-taskid-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect((attacker.memory as any).taskId).toBe("pb-taskid-test");
      expect((healer.memory as any).taskId).toBe("pb-taskid-test");
    });
  });

  describe("attacking", () => {

    it("creates hauler configs while attacking when bank is near destruction", () => {
      setupSourceRoom({ energyCapacity: 12_000 });

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-id",
        roomName: TARGET_ROOM,
        memory: {
          role: "powerBankHealer",
          taskId: "pb-test",
        } as Partial<CreepMemory>,
        body: [
          { type: HEAL as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      const bank = createMockPowerBank({ id: "bank-0", hits: 100_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        if (id === "bank-0") return bank;
        return null;
      }) as typeof Game.getObjectById;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
        combatReady: true,
        bankId: "bank-0",
        power: 5000,
      }));

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      const haulerConfigs = Object.entries(configs).filter(([, config]) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(4);
      expect(haulerConfigs[0][1]).toMatchObject({
        args: [TARGET_ROOM, ""],
        roomName: SOURCE_ROOM,
      });
      expect(getTask("pb-test")!.haulerCount).toBe(4);
    });

    it("removes stale primary configs when a promoted reinforcement is already active", () => {
      setupSourceRoom({ energyCapacity: 12_000 });

      const activeAttackerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1);
      const activeHealerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 1);
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-1",
        id: "attacker-id",
        roomName: TARGET_ROOM,
        memory: {
          role: "powerBankAttacker",
          configName: activeAttackerConfig,
          taskId: "pb-test",
        } as Partial<CreepMemory>,
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-1",
        id: "healer-id",
        roomName: TARGET_ROOM,
        memory: {
          role: "powerBankHealer",
          configName: activeHealerConfig,
          taskId: "pb-test",
        } as Partial<CreepMemory>,
      });
      Game.creeps[attacker.name] = attacker;
      Game.creeps[healer.name] = healer;

      const bank = createMockPowerBank({ id: "bank-0", hits: 500_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      const primaryAttacker = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const primaryHealer = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      const configStore = getCreepConfigService();
      configStore.add(primaryAttacker, "powerBankAttacker", TARGET_ROOM, "");
      configStore.add(primaryHealer, "powerBankHealer", TARGET_ROOM, "");
      configStore.add(activeAttackerConfig, "powerBankAttacker", TARGET_ROOM, "");
      configStore.add(activeHealerConfig, "powerBankHealer", TARGET_ROOM, "");
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [primaryAttacker, primaryHealer];

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
        bankId: "bank-0",
        routeDistance: 2,
        tier: 6,
      }));

      runPowerBankHarvest();

      expect(configStore.get(primaryAttacker)).toBeUndefined();
      expect(configStore.get(primaryHealer)).toBeUndefined();
      expect(configStore.get(activeAttackerConfig)).toBeDefined();
      expect(configStore.get(activeHealerConfig)).toBeDefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
    });
  });

  describe("cleanup", () => {

    it("removes task from memory after cleanup delay", () => {
      mockReleaseBoostLabs();

      addTask(makeTask({
        status: POWER_BANK_STATUS.COMPLETE,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        terminalTick: 100,
      }));

      Game.time = 250;
      runPowerBankHarvest();

      expect(getTask("pb-test")).toBeUndefined();
    });
  });

  describe("renewing synchronization", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("uses routeDistance * 2 + 50 as minimum TTL threshold", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 69;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        routeDistance: 10,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.RENEWING);
    });
  });

  describe("parallel boost preparation", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("processPreparingBoosts advances to SPAWNING when prepareBoosts returns 'preparing'", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("preparing", ["lab-1", "lab-2"]);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.SPAWNING);
      expect(task.boostLabs).toEqual(["lab-1", "lab-2"]);
    });
  });

  describe("abort cleanup completeness at each state", () => {
    it("cleanup at preparing_boosts: releases labs, removes configs, sets terminal tick", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      configStore.add(attackerName, "powerBankAttacker", TARGET_ROOM);

      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
        boostLabs: ["lab-a", "lab-b"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      expect(getTask("pb-test")).toBeUndefined();
      const history = Memory.data?.powerBankHarvestHistory ?? [];
      expect(history[history.length - 1]).toMatchObject({
        taskId: "pb-test",
        status: POWER_BANK_STATUS.ABORTED,
        failReason: "defense_mode",
        terminalTick: Game.time,
      });

      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

    it("cleanup at boosting: releases labs and removes configs on defense abort", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const healerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(healerName, "powerBankHealer", TARGET_ROOM);

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-b0"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      expect(getTask("pb-test")).toBeUndefined();
      const history = Memory.data?.powerBankHarvestHistory ?? [];
      expect(history[history.length - 1]).toMatchObject({
        taskId: "pb-test",
        status: POWER_BANK_STATUS.ABORTED,
        terminalTick: Game.time,
      });
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });
  });

  describe("patrol scout maintenance", () => {
    const SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

    it("removes stale scout config when observer coverage becomes complete", () => {
      setupSourceRoom();
      const configStore = getCreepConfigService();
      configStore.add(SCOUT_CONFIG_NAME, "powerBankScout", SOURCE_ROOM);
      const observerModule = require("@/runtime/powerBankObserver");
      jest.spyOn(observerModule, "hasPowerBankObserverCoverage").mockReturnValue(true);

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      expect(configs[SCOUT_CONFIG_NAME]).toBeUndefined();
    });
  });

  describe("terminal cleanup neutralizes task-bound creeps", () => {

    it("releases stale boost prep and boostPause even when terminal task has no boostLabs snapshot", () => {
      Memory.runtime = {
        powerBankBoost: {
          "pb-stale-boost": {
            taskId: "pb-stale-boost",
            sourceRoomName: SOURCE_ROOM,
            labs: {
              [RESOURCE_CATALYZED_UTRIUM_ACID]: {
                labId: "lab-stale",
                compound: RESOURCE_CATALYZED_UTRIUM_ACID,
              },
            },
          },
        },
        synthesisControl: {
          rooms: {
            [SOURCE_ROOM]: {
              stage: "idle",
              lastTransitionAt: 100,
              boostPause: {
                reason: "powerBankBoost",
                taskId: "pb-stale-boost",
                createdTick: 100,
                pausedPlan: null,
                pausedStage: "idle",
              },
            },
          },
        },
      } as unknown as Memory["runtime"];

      addTask(makeTask({
        id: "pb-stale-boost",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        boostLabs: [],
        failReason: "boost_failed_before_snapshot",
        terminalTick: 100,
      }));

      runPowerBankHarvest();

      expect(Memory.runtime?.powerBankBoost?.["pb-stale-boost"]).toBeUndefined();
      expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].boostPause).toBeUndefined();
    });
  });

  describe("bounded lifecycle manager contracts", () => {
    it.each([
      POWER_BANK_STATUS.PREPARING_BOOSTS,
      POWER_BANK_STATUS.SPAWNING,
      POWER_BANK_STATUS.RENEWING,
      POWER_BANK_STATUS.BOOSTING,
      POWER_BANK_STATUS.TRAVELLING,
    ] as PowerBankHarvestStatus[])(
      "terminates %s at deadline before spending or invoking Screeps APIs",
      (status) => {
        setupSourceRoom();
        const prepareSpy = require("@/runtime/powerBankBoost").prepareBoosts as jest.Mock;
        prepareSpy.mockClear();
        const releaseSpy = mockReleaseBoostLabs();
        const renewSpies = Object.values(Game.spawns).map((spawn) => spawn.renewCreep as jest.Mock);

        addTask(makeTask({
          id: `pb-deadline-${status}`,
          status,
          sourceRoom: SOURCE_ROOM,
          tier: 8,
          bankExpiresAt: Game.time,
          stageEnteredAt: Game.time,
          activeGeneration: 0,
          activeIndex: 0,
          primaryBoostOwnerId: `pb-deadline-${status}:primary:g0`,
        }));

        runPowerBankHarvest();

        expect(getTask(`pb-deadline-${status}`)).toBeUndefined();
        expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
          taskId: `pb-deadline-${status}`,
          status: POWER_BANK_STATUS.FAILED,
          failReason: "bank_expired",
          terminalTick: Game.time,
        }));
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(releaseSpy).not.toHaveBeenCalled();
        for (const renewSpy of renewSpies) expect(renewSpy).not.toHaveBeenCalled();
        expect(Object.values(getCreepConfigService().list())
          .filter((config) => config.taskId === `pb-deadline-${status}`))
          .toHaveLength(0);
      },
    );

    it("refreshes attack progress only when observed bank hits decrease", () => {
      setupSourceRoom();
      const pair = setupOwnedCombatPair({ taskId: "pb-progress" });
      const bank = createMockPowerBank({ id: "bank-progress", hits: 499_000, ticksToDecay: 5000 });
      mockObjects(pair.attacker as Creep & { id: string }, pair.healer as Creep & { id: string }, bank as StructurePowerBank & { id: string });
      addTask(makeTask({
        id: "pb-progress",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        bankId: "bank-progress",
        attackerId: pair.attacker.id as string,
        healerId: pair.healer.id as string,
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        lastBankHits: 500_000,
        lastBankProgressAt: 1,
        stageEnteredAt: 1,
        bankExpiresAt: 5100,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-progress")).toMatchObject({
        lastBankHits: 499_000,
        lastBankProgressAt: Game.time,
        lastProgressAt: Game.time,
      });
    });

    it("requests a replacement generation after 100 ticks without bank damage", () => {
      Game.time = 300;
      setupSourceRoom();
      const pair = setupOwnedCombatPair({ taskId: "pb-stalled" });
      const bank = createMockPowerBank({ id: "bank-stalled", hits: 500_000, ticksToDecay: 5000 });
      mockObjects(pair.attacker as Creep & { id: string }, pair.healer as Creep & { id: string }, bank as StructurePowerBank & { id: string });
      addTask(makeTask({
        id: "pb-stalled",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        bankId: "bank-stalled",
        attackerId: pair.attacker.id as string,
        healerId: pair.healer.id as string,
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        routeDistance: 2,
        lastBankHits: 500_000,
        lastBankProgressAt: Game.time - 101,
        stageEnteredAt: 100,
        bankExpiresAt: Game.time + 5000,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-stalled")?.reinforcement).toMatchObject({
        generation: 1,
        index: 1,
        stage: "spawning",
        combatReady: false,
        boostOwnerId: "pb-stalled:reinforcement:g1",
      });
    });

    it("fails after 250 ticks without attack progress instead of waiting forever", () => {
      Game.time = 400;
      setupSourceRoom();
      const getObjectSpy = jest.fn(() => null);
      Game.getObjectById = getObjectSpy as unknown as typeof Game.getObjectById;
      addTask(makeTask({
        id: "pb-stalled-terminal",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
        lastBankProgressAt: Game.time - 251,
        lastVisibleAt: Game.time,
        stageEnteredAt: 100,
        bankExpiresAt: Game.time + 5000,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-stalled-terminal")).toBeUndefined();
      expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
        taskId: "pb-stalled-terminal",
        status: POWER_BANK_STATUS.FAILED,
        failReason: "attack_no_progress",
      }));
      expect(getObjectSpy).not.toHaveBeenCalled();
    });

    it("fails within the visibility grace when the target and every combat member are gone", () => {
      Game.time = 200;
      setupSourceRoom();
      delete Game.rooms[TARGET_ROOM];
      addTask(makeTask({
        id: "pb-lost-vision",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
        attackerId: undefined,
        healerId: undefined,
        lastVisibleAt: Game.time - 76,
        lastBankProgressAt: Game.time,
        stageEnteredAt: 100,
        bankExpiresAt: Game.time + 5000,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-lost-vision")).toBeUndefined();
      expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
        taskId: "pb-lost-vision",
        status: POWER_BANK_STATUS.FAILED,
        failReason: "lost_vision_and_combat_pair",
      }));
    });
  });

  describe("generation and owner isolation contracts", () => {
    it("promotes a ready g1 when the still-live g0 loses combat parts and retires only g0 assets", () => {
      setupSourceRoom();
      const generationZero = setupOwnedCombatPair({ taskId: "pb-broken-g0" });
      const generationOne = setupOwnedCombatPair({
        taskId: "pb-broken-g0",
        generation: 1,
        index: 1,
      });
      const brokenAttackPart = generationZero.attacker.body.find((part) => part.type === ATTACK)!;
      brokenAttackPart.hits = 0;

      const generationZeroAttackerConfig = generationZero.attacker.memory.configName!;
      const generationZeroHealerConfig = generationZero.healer.memory.configName!;
      const generationOneAttackerConfig = generationOne.attacker.memory.configName!;
      const generationOneHealerConfig = generationOne.healer.memory.configName!;
      const configStore = Memory.data!.creepConfigs ??= {};
      configStore[generationZeroAttackerConfig] = {
        role: "powerBankAttacker",
        args: [TARGET_ROOM, ""],
        roomName: SOURCE_ROOM,
        taskId: "pb-broken-g0",
        powerBankGeneration: 0,
      };
      configStore[generationZeroHealerConfig] = {
        role: "powerBankHealer",
        args: [TARGET_ROOM, ""],
        roomName: SOURCE_ROOM,
        taskId: "pb-broken-g0",
        powerBankGeneration: 0,
      };
      configStore[generationOneAttackerConfig] = {
        role: "powerBankAttacker",
        args: [TARGET_ROOM, ""],
        roomName: SOURCE_ROOM,
        taskId: "pb-broken-g0",
        powerBankGeneration: 1,
      };
      configStore[generationOneHealerConfig] = {
        role: "powerBankHealer",
        args: [TARGET_ROOM, ""],
        roomName: SOURCE_ROOM,
        taskId: "pb-broken-g0",
        powerBankGeneration: 1,
      };
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [
        generationZeroAttackerConfig,
        generationZeroHealerConfig,
      ];

      const bank = createMockPowerBank({ id: "bank-broken-g0", hits: 1_000_000, ticksToDecay: 5000 });
      mockObjects(
        generationZero.attacker as Creep & { id: string },
        generationZero.healer as Creep & { id: string },
        generationOne.attacker as Creep & { id: string },
        generationOne.healer as Creep & { id: string },
        bank as StructurePowerBank & { id: string },
      );
      addTask(makeTask({
        id: "pb-broken-g0",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        bankId: "bank-broken-g0",
        attackerId: generationZero.attacker.id as string,
        healerId: generationZero.healer.id as string,
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        routeDistance: 2,
        bankExpiresAt: Game.time + 5000,
        lastBankProgressAt: Game.time,
        reinforcement: {
          index: 1,
          generation: 1,
          stage: "attacking",
          attackerId: generationOne.attacker.id as string,
          healerId: generationOne.healer.id as string,
          attackerReady: true,
          healerReady: true,
          combatReady: true,
          boostOwnerId: "pb-broken-g0:reinforcement:g1",
          boostLabs: [],
        },
      }));

      runPowerBankHarvest();

      expect(getTask("pb-broken-g0")).toMatchObject({
        activeGeneration: 1,
        activeIndex: 1,
        attackerId: generationOne.attacker.id,
        healerId: generationOne.healer.id,
        combatReady: true,
      });
      expect(getTask("pb-broken-g0")?.reinforcement).toBeUndefined();
      expect(generationZero.attacker.suicide).toHaveBeenCalledTimes(1);
      expect(generationZero.healer.suicide).toHaveBeenCalledTimes(1);
      expect((generationZero.attacker.memory as PowerBankTestMemory).taskId).toBeUndefined();
      expect((generationZero.healer.memory as PowerBankTestMemory).taskId).toBeUndefined();
      expect(generationOne.attacker.suicide).not.toHaveBeenCalled();
      expect(generationOne.healer.suicide).not.toHaveBeenCalled();
      expect(getCreepConfigService().get(generationZeroAttackerConfig)).toBeUndefined();
      expect(getCreepConfigService().get(generationZeroHealerConfig)).toBeUndefined();
      expect(getCreepConfigService().get(generationOneAttackerConfig)).toBeDefined();
      expect(getCreepConfigService().get(generationOneHealerConfig)).toBeDefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
    });

    it("promotes g1 and immediately allocates a distinct g2 replacement when required", () => {
      setupSourceRoom();
      const generationOne = setupOwnedCombatPair({
        taskId: "pb-generations",
        generation: 1,
        index: 1,
        ticksToLive: 100,
      });
      const bank = createMockPowerBank({ id: "bank-generations", hits: 500_000, ticksToDecay: 5000 });
      mockObjects(
        generationOne.attacker as Creep & { id: string },
        generationOne.healer as Creep & { id: string },
        bank as StructurePowerBank & { id: string },
      );
      addTask(makeTask({
        id: "pb-generations",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        bankId: "bank-generations",
        attackerId: "dead-g0-attacker",
        healerId: "dead-g0-healer",
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        routeDistance: 2,
        bankExpiresAt: Game.time + 5000,
        lastBankProgressAt: Game.time,
        reinforcement: {
          index: 1,
          generation: 1,
          stage: "attacking",
          attackerId: generationOne.attacker.id as string,
          healerId: generationOne.healer.id as string,
          combatReady: true,
          boostOwnerId: "pb-generations:reinforcement:g1",
          boostLabs: [],
        },
      }));

      runPowerBankHarvest();

      const task = getTask("pb-generations")!;
      expect(task).toMatchObject({
        activeGeneration: 1,
        activeIndex: 1,
        attackerId: generationOne.attacker.id,
        healerId: generationOne.healer.id,
      });
      expect(task.reinforcement).toMatchObject({
        generation: 2,
        index: 2,
        stage: "spawning",
        boostOwnerId: "pb-generations:reinforcement:g2",
      });
      expect(getCreepConfigService().get(getPowerBankConfigName(
        SOURCE_ROOM,
        TARGET_ROOM,
        "attacker",
        2,
        "pb-generations",
        2,
      ))).toMatchObject({ taskId: "pb-generations", powerBankGeneration: 2 });
    });

    it("clears replacement readiness and returns to renewing when a member ID changes", () => {
      setupSourceRoom();
      const active = setupOwnedCombatPair({ taskId: "pb-replacement-change" });
      const replacement = setupOwnedCombatPair({
        taskId: "pb-replacement-change",
        generation: 1,
        index: 1,
        attackerId: "replacement-new-attacker",
        healerId: "replacement-healer",
        ticksToLive: 100,
      });
      const bank = createMockPowerBank({ id: "bank-replacement-change", hits: 1_000_000, ticksToDecay: 5000 });
      mockObjects(
        active.attacker as Creep & { id: string },
        active.healer as Creep & { id: string },
        replacement.attacker as Creep & { id: string },
        replacement.healer as Creep & { id: string },
        bank as StructurePowerBank & { id: string },
      );
      const releaseSpy = mockReleaseBoostLabs();
      addTask(makeTask({
        id: "pb-replacement-change",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        bankId: "bank-replacement-change",
        attackerId: active.attacker.id as string,
        healerId: active.healer.id as string,
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        routeDistance: 2,
        minimumCombatTtl: 500,
        bankExpiresAt: Game.time + 5000,
        lastBankProgressAt: Game.time,
        reinforcement: {
          index: 1,
          generation: 1,
          stage: "attacking",
          attackerId: "replacement-old-attacker",
          healerId: replacement.healer.id as string,
          attackerReady: true,
          healerReady: true,
          combatReady: true,
          boostOwnerId: "pb-replacement-change:reinforcement:g1",
          boostLabs: ["replacement-lab"],
        },
      }));

      runPowerBankHarvest();

      expect(getTask("pb-replacement-change")?.reinforcement).toMatchObject({
        stage: "renewing",
        attackerId: replacement.attacker.id,
        healerId: replacement.healer.id,
        attackerReady: false,
        combatReady: false,
        boostLabs: [],
      });
      expect(releaseSpy).toHaveBeenCalledWith(
        "pb-replacement-change:reinforcement:g1",
        SOURCE_ROOM,
      );
    });

    it("releases the finished primary boost owner without touching a preparing replacement owner", () => {
      setupSourceRoom();
      const active = setupOwnedCombatPair({ taskId: "pb-owner-isolation" });
      const bank = createMockPowerBank({ id: "bank-owner-isolation", hits: 1_000_000, ticksToDecay: 5000 });
      mockObjects(
        active.attacker as Creep & { id: string },
        active.healer as Creep & { id: string },
        bank as StructurePowerBank & { id: string },
      );
      const releaseSpy = mockReleaseBoostLabs();
      addTask(makeTask({
        id: "pb-owner-isolation",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        bankId: "bank-owner-isolation",
        attackerId: active.attacker.id as string,
        healerId: active.healer.id as string,
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        bankExpiresAt: Game.time + 5000,
        lastBankProgressAt: Game.time,
        boostLabs: ["primary-lab"],
        primaryBoostLabs: ["primary-lab"],
        primaryBoostOwnerId: "pb-owner-isolation:primary:g0",
        reinforcement: {
          index: 1,
          generation: 1,
          stage: "renewing",
          combatReady: false,
          boostOwnerId: "pb-owner-isolation:reinforcement:g1",
          boostLabs: ["reinforcement-lab"],
        },
      }));

      runPowerBankHarvest();

      expect(releaseSpy).toHaveBeenCalledWith("pb-owner-isolation:primary:g0", SOURCE_ROOM);
      expect(releaseSpy).not.toHaveBeenCalledWith("pb-owner-isolation:reinforcement:g1", SOURCE_ROOM);
      expect(getTask("pb-owner-isolation")?.reinforcement?.boostLabs).toEqual(["reinforcement-lab"]);
    });

    it("keeps configs isolated for concurrent tasks with the same source and target", () => {
      setupSourceRoom();
      addTask(makeTask({
        id: "pb-collision-a",
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
        bankExpiresAt: Game.time + 5000,
        activeGeneration: 0,
        activeIndex: 0,
      }));
      addTask(makeTask({
        id: "pb-collision-b",
        bankId: "bank-collision-b",
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
        bankExpiresAt: Game.time + 5000,
        activeGeneration: 0,
        activeIndex: 0,
      }));

      runPowerBankHarvest();

      const firstName = getPowerBankConfigName(
        SOURCE_ROOM,
        TARGET_ROOM,
        "attacker",
        0,
        "pb-collision-a",
        0,
      );
      const secondName = getPowerBankConfigName(
        SOURCE_ROOM,
        TARGET_ROOM,
        "attacker",
        0,
        "pb-collision-b",
        0,
      );
      expect(firstName).not.toBe(secondName);
      expect(getCreepConfigService().get(firstName)).toMatchObject({ taskId: "pb-collision-a" });
      expect(getCreepConfigService().get(secondName)).toMatchObject({ taskId: "pb-collision-b" });
    });
  });

  describe("hauling result and terminal contracts", () => {
    it("moves to hauling when the bank disappears without claiming success", () => {
      setupSourceRoom();
      setupTargetRoom();
      const pair = setupOwnedCombatPair({ taskId: "pb-bank-gone" });
      mockObjects(pair.attacker as Creep & { id: string }, pair.healer as Creep & { id: string });
      addTask(makeTask({
        id: "pb-bank-gone",
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        attackerId: pair.attacker.id as string,
        healerId: pair.healer.id as string,
        activeGeneration: 0,
        activeIndex: 0,
        combatReady: true,
        tier: 8,
        bankExpiresAt: Game.time + 5000,
        lastBankProgressAt: Game.time,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-bank-gone")).toMatchObject({
        status: POWER_BANK_STATUS.HAULING,
        bankGoneTick: Game.time,
        haulingStartedTick: Game.time,
      });
      expect(getTask("pb-bank-gone")?.outcome).toBeUndefined();
      expect(Memory.data?.powerBankHarvestHistory).toHaveLength(0);
    });

    it("records zero delivery as a failed contested result", () => {
      setupSourceRoom();
      setupTargetRoom();
      addTask(makeTask({
        id: "pb-zero-yield",
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        power: 5000,
        observedPower: 0,
        pickedUpPower: 0,
        deliveredPower: 0,
        haulingEmptySince: Game.time - 100,
        haulingStartedTick: Game.time - 100,
        haulingDeadlineAt: Game.time + 1000,
        stageEnteredAt: Game.time - 100,
        bankExpiresAt: Game.time + 1000,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-zero-yield")).toBeUndefined();
      expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
        taskId: "pb-zero-yield",
        status: POWER_BANK_STATUS.FAILED,
        outcome: "contested",
        failReason: "power_not_observed_or_stolen",
        deliveredPower: 0,
        lostPower: 5000,
      }));
    });

    it("records a short delivery as partial and preserves the loss amount", () => {
      setupSourceRoom();
      setupTargetRoom();
      addTask(makeTask({
        id: "pb-partial-delivery",
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        power: 5000,
        observedPower: 5000,
        pickedUpPower: 3000,
        deliveredPower: 1000,
        haulingEmptySince: Game.time - 100,
        haulingStartedTick: Game.time - 100,
        haulingDeadlineAt: Game.time + 1000,
        stageEnteredAt: Game.time - 100,
        bankExpiresAt: Game.time + 1000,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-partial-delivery")).toBeUndefined();
      expect(Memory.data?.powerBankHarvestHistory).toContainEqual(expect.objectContaining({
        taskId: "pb-partial-delivery",
        status: POWER_BANK_STATUS.COMPLETE,
        outcome: "partial",
        observedPower: 5000,
        pickedUpPower: 3000,
        deliveredPower: 1000,
        lostPower: 4000,
      }));
    });

    it("appends terminal history once and removes the active task in the same tick", () => {
      setupSourceRoom();
      addTask(makeTask({
        id: "pb-terminal-once",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        terminalTick: Game.time,
        failReason: "test_terminal",
        outcome: "failed",
      }));

      runPowerBankHarvest();
      expect(getTask("pb-terminal-once")).toBeUndefined();
      expect(Memory.data?.powerBankHarvestHistory?.filter((entry) => entry.taskId === "pb-terminal-once"))
        .toHaveLength(1);

      runPowerBankHarvest();
      expect(Memory.data?.powerBankHarvestHistory?.filter((entry) => entry.taskId === "pb-terminal-once"))
        .toHaveLength(1);
    });
  });

  describe("source candidate selection contracts", () => {
    it("uses the dynamic spawn profile for body-less queued roles and avoids the busy source", () => {
      setupOwnedRoom(SOURCE_ROOM);
      setupOwnedRoom(SECONDARY_SOURCE_ROOM);
      jest.spyOn(require("@/runtime/powerBankObserver"), "hasPowerBankObserverCoverage").mockReturnValue(true);

      const busyConfigName = `${SOURCE_ROOM}:worker:busy`;
      Memory.data!.creepConfigs ??= {};
      Memory.data!.creepConfigs[busyConfigName] = {
        role: "worker",
        args: [],
        roomName: SOURCE_ROOM,
      };
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [busyConfigName];

      const workerProfileSpy = jest.spyOn(
        require("@/config/spawnProfiles").spawnProfiles,
        "worker",
      ).mockReturnValue(Array<BodyPartConstant>(50).fill(MOVE));
      Game.map.findRoute = jest.fn((fromRoom: string) => fromRoom === SOURCE_ROOM
        ? [{ room: TARGET_ROOM, exit: FIND_EXIT_RIGHT }]
        : [
            { room: "E4N60", exit: FIND_EXIT_RIGHT },
            { room: TARGET_ROOM, exit: FIND_EXIT_RIGHT },
          ]) as typeof Game.map.findRoute;
      addTask(makeTask({
        id: "pb-busy-dynamic-source",
        hits: 100_000,
        power: 1000,
        ticksToDecay: 5000,
        discoveredTick: Game.time,
        lastSeenTick: Game.time,
        bankExpiresAt: Game.time + 5000,
      }));

      runPowerBankHarvest();

      expect(workerProfileSpy).toHaveBeenCalledWith(Game.rooms[SOURCE_ROOM]);
      expect(getTask("pb-busy-dynamic-source")).toMatchObject({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SECONDARY_SOURCE_ROOM,
        routeDistance: 2,
      });
    });

    it("skips the nearest room when its actual compounds are insufficient and selects the viable next room", () => {
      setupOwnedRoom(SOURCE_ROOM, {
        compounds: {
          [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1,
          [RESOURCE_CATALYZED_UTRIUM_ACID]: 1,
        },
      });
      setupOwnedRoom(SECONDARY_SOURCE_ROOM);
      jest.spyOn(require("@/runtime/powerBankObserver"), "hasPowerBankObserverCoverage").mockReturnValue(true);
      jest.spyOn(require("@/runtime/powerBankBoost"), "findBestDonorRoom").mockReturnValue(null);
      Game.map.findRoute = jest.fn((fromRoom: string) => fromRoom === SOURCE_ROOM
        ? [{ room: TARGET_ROOM, exit: FIND_EXIT_RIGHT }]
        : [
            { room: "E4N60", exit: FIND_EXIT_RIGHT },
            { room: TARGET_ROOM, exit: FIND_EXIT_RIGHT },
          ]) as typeof Game.map.findRoute;
      const prepareSpy = require("@/runtime/powerBankBoost").prepareBoosts as jest.Mock;
      prepareSpy.mockClear();
      addTask(makeTask({
        id: "pb-second-source",
        hits: 100_000,
        power: 1000,
        ticksToDecay: 5000,
        discoveredTick: Game.time,
        lastSeenTick: Game.time,
        bankExpiresAt: Game.time + 5000,
      }));

      runPowerBankHarvest();

      expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
      expect(getTask("pb-second-source")).toMatchObject({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SECONDARY_SOURCE_ROOM,
        routeDistance: 2,
      });
      expect(prepareSpy).not.toHaveBeenCalled();
    });

    it("excludes an ERR_NO_PATH room instead of sorting it as an infinite-distance candidate", () => {
      setupOwnedRoom(SOURCE_ROOM);
      setupOwnedRoom(SECONDARY_SOURCE_ROOM);
      jest.spyOn(require("@/runtime/powerBankObserver"), "hasPowerBankObserverCoverage").mockReturnValue(true);
      Game.map.findRoute = jest.fn((fromRoom: string) => fromRoom === SOURCE_ROOM
        ? ERR_NO_PATH
        : [{ room: TARGET_ROOM, exit: FIND_EXIT_RIGHT }]) as typeof Game.map.findRoute;
      addTask(makeTask({
        id: "pb-safe-route-source",
        hits: 100_000,
        power: 1000,
        ticksToDecay: 5000,
        discoveredTick: Game.time,
        lastSeenTick: Game.time,
        bankExpiresAt: Game.time + 5000,
      }));

      runPowerBankHarvest();

      expect(Memory.data?.powerBankHarvestHistory).toEqual([]);
      expect(getTask("pb-safe-route-source")).toMatchObject({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SECONDARY_SOURCE_ROOM,
        routeDistance: 1,
      });
    });
  });
});

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
  };
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
      Game.creeps["attacker-0"] = attacker;

      const bank = createMockPowerBank({ id: "bank-0", hits: 100_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as typeof Game.getObjectById;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
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

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("defense_mode");
      expect(task.terminalTick).toBe(Game.time);

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

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.terminalTick).toBe(Game.time);
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
});

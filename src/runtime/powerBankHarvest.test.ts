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

  describe("discovered -> viability", () => {
    it("transitions to preparing_boosts when viable", () => {
      setupSourceRoom();
      addTask(makeTask({ status: POWER_BANK_STATUS.DISCOVERED }));

      mockSelectBodyTier("rcl8");
      mockAssessViability(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.PREPARING_BOOSTS);
      expect(task.sourceRoom).toBe(SOURCE_ROOM);
      expect(task.tier).toBe(8);
    });

    it("transitions to failed when not viable", () => {
      setupSourceRoom();
      addTask(makeTask({ status: POWER_BANK_STATUS.DISCOVERED }));

      mockSelectBodyTier("rcl8");
      mockAssessViability(false, ["decay_too_soon"]);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("decay_too_soon");
    });

    it("transitions to failed when no eligible rooms", () => {
      addTask(makeTask({ status: POWER_BANK_STATUS.DISCOVERED }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("no_eligible_source_room");
    });

    it("aborts already-recorded power banks outside patrol rooms", () => {
      setupSourceRoom();
      addTask(makeTask({ status: POWER_BANK_STATUS.ATTACKING, sourceRoom: SOURCE_ROOM, targetRoom: "W0N55" }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("outside_powerbank_patrol_rooms");
    });

    it("does not refresh terminalTick for already-aborted power banks outside patrol rooms", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.ABORTED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: "W0N55",
        failReason: "outside_powerbank_patrol_rooms",
        terminalTick: Game.time - 10,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")?.terminalTick).toBe(Game.time - 10);
    });
  });

  describe("preparing_boosts", () => {
    it("real boost prep pauses active synthesis production before spawning", () => {
      setupSourceRoom();
      jest.restoreAllMocks();
      clearDefenseModeCacheForTest();

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];
      const labs = compounds.map((compound, index) =>
        createMockLab({
          id: `${SOURCE_ROOM}-boost-lab-${index + 1}`,
          roomName: SOURCE_ROOM,
          mineralType: compound as MineralConstant,
          mineralAmount: LAB_BOOST_MINERAL,
          store: { [compound]: LAB_BOOST_MINERAL },
        })
      );
      Game.rooms[SOURCE_ROOM].find = jest.fn((type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) => {
        if (type !== FIND_MY_STRUCTURES) return [];
        return opts?.filter ? labs.filter((structure) => opts.filter?.(structure)) : labs;
      }) as Room["find"];
      Game.getObjectById = jest.fn((id: string) => labs.find((lab) => lab.id === id) ?? null) as Game["getObjectById"];

      Memory.cfg = Memory.cfg ?? {};
      Memory.cfg.synthesisControl = {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          [SOURCE_ROOM]: {
            enabled: true,
            reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5000 }],
          },
        },
      };
      Memory.runtime = Memory.runtime ?? {};
      Memory.runtime.synthesisControl = {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [SOURCE_ROOM]: {
            stage: "synthesizing",
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            reagentA: RESOURCE_UTRIUM,
            reagentB: RESOURCE_HYDROGEN,
            targetAmount: 5000,
            batchSize: 500,
            reagentLabIds: [`${SOURCE_ROOM}-reagent-a`, `${SOURCE_ROOM}-reagent-b`],
            productLabIds: [`${SOURCE_ROOM}-product`],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
          },
        },
      };
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      const roomState = Memory.runtime.synthesisControl.rooms[SOURCE_ROOM];
      expect(task.status).toBe(POWER_BANK_STATUS.SPAWNING);
      expect(isSynthesisPaused(SOURCE_ROOM)).toBe(true);
      expect(roomState.boostPause?.taskId).toBe("pb-test");
      expect(roomState.boostPause?.pausedPlan?.product).toBe(RESOURCE_UTRIUM_HYDRIDE);
      expect(roomState.activeProduct).toBeUndefined();
      expect(Memory.runtime.powerBankBoost?.["pb-test"]).toBeDefined();
    });

    it("transitions to spawning when boost prep is ready", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("ready", ["lab-0", "lab-1"]);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.SPAWNING);
      expect(task.boostLabs).toEqual(["lab-0", "lab-1"]);
    });

    it("transitions to spawning when boost prep is still preparing (parallel pipeline)", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("preparing", ["lab-0"]);

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.SPAWNING);
    });

    it("stays preparing_boosts when preparing returns no labs", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("preparing", []);

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.PREPARING_BOOSTS);
    });

    it("transitions to aborted on defense mode", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(getTask("pb-test")!.failReason).toBe("defense_mode");
    });

    it("transitions to failed when boost prep fails", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("failed", []);

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.FAILED);
    });
  });

  describe("spawning", () => {
    it("creates attacker and healer configs and transitions to renewing", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.RENEWING);

      const configs = getCreepConfigService().list();
      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      expect(configs[attackerName]).toBeDefined();
      expect(configs[attackerName].role).toBe("powerBankAttacker");
      expect(configs[healerName]).toBeDefined();
      expect(configs[healerName].role).toBe("powerBankHealer");
    });

    it("transitions to aborted on defense mode", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ABORTED);
    });
  });

  describe("renewing", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("transitions to boosting when both creeps have sufficient TTL", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

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
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(false);
      expect(task.healerReady).toBe(false);
    });

    it("renews creeps and stays renewing when TTL is too low", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 500;

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
        routeDistance: 500,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.RENEWING);
    });

    it("lets a solo attacker advance to boosting while waiting for healer", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

      Game.creeps["attacker-0"] = attacker;

      addTask(makeTask({
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });

    it("aborts with invalid_lifecycle_already_boosted when creep is already boosted", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      (attacker as any).ticksToLive = 1500;

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
      }));

      mockReleaseBoostLabs();

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("invalid_lifecycle_already_boosted");
    });

    it("calls renewCreep on spawn for low-TTL creeps", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 30;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 30;

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

      const spawn = Game.spawns[`${SOURCE_ROOM}-spawn1`] as unknown as StructureSpawn;
      expect(spawn.renewCreep).toHaveBeenCalledWith(attacker);
      expect(spawn.renewCreep).toHaveBeenCalledWith(healer);
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.RENEWING);
    });

    it("sets ready flags only for creeps with sufficient TTL", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 30;

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

      const task = getTask("pb-test")!;
      expect(task.attackerReady).toBe(true);
      expect(task.healerReady).toBe(false);
      expect(task.status).toBe(POWER_BANK_STATUS.RENEWING);
    });
  });

  describe("boosting", () => {
    it("transitions to travelling when both creeps are boosted", () => {
      setupSourceRoom();
      const releaseSpy = mockReleaseBoostLabs();
      mockPrepareBoosts("ready", ["lab-0"]);

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

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-0"],
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerId).toBe("attacker-0-id");
      expect(task.healerId).toBe("healer-0-id");
      expect(task.boostLabs).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

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

    it("stays boosting when only one creep exists", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      Game.creeps["attacker-0"] = attacker;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });

    it("transitions to aborted on defense mode", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ABORTED);
    });

    it("RCL8 healer skips boost but still waits for attacker to be boosted", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.healerReady).toBe(true);
      expect(task.attackerReady).toBeFalsy();
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });

    it("waits when attacker needs boost but is not yet boosted", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(getTask("pb-test")!.healerReady).toBe(true);
    });

    it("first spawned member waits for partner", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      Game.creeps["attacker-0"] = attacker;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });
  });

  describe("travelling", () => {
    it("transitions to attacking when both creeps in target room", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: TARGET_ROOM,
        id: "attacker-id",
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: TARGET_ROOM,
        id: "healer-id",
      });
      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.TRAVELLING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
    });

    it("stays travelling when creeps not yet in target room", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        id: "attacker-id",
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        id: "healer-id",
      });
      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.TRAVELLING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.TRAVELLING);
    });

    it("clears boost movement cache once when travelling starts", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        id: "attacker-id",
        memory: {
          _move: { dest: { x: 17, y: 32, room: SOURCE_ROOM }, path: "123", time: Game.time },
        },
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        id: "healer-id",
        memory: {
          _move: { dest: { x: 16, y: 33, room: SOURCE_ROOM }, path: "456", time: Game.time },
        },
      });
      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        id: "travel-task",
        status: POWER_BANK_STATUS.TRAVELLING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
      }));

      runPowerBankHarvest();

      expect(attacker.memory._move).toBeUndefined();
      expect(healer.memory._move).toBeUndefined();
      expect((attacker.memory as CreepMemory & { powerBankTravelTaskId?: string }).powerBankTravelTaskId).toBe("travel-task");
      expect((healer.memory as CreepMemory & { powerBankTravelTaskId?: string }).powerBankTravelTaskId).toBe("travel-task");
    });

    it("transitions to aborted when creep dies in transit", () => {
      setupSourceRoom();

      const bank = createMockPowerBank({ id: "bank-0", hits: 500_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.TRAVELLING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
      }));

      mockReleaseBoostLabs();

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ABORTED);
    });
  });

  describe("attacking", () => {
    it("transitions to hauling when bank is destroyed", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", { id: "attacker-id" });
      const healer = createMockPowerBankCreep("powerBankHealer", { id: "healer-id" });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
        bankId: "bank-0",
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(attacker.suicide).toHaveBeenCalled();
      expect(healer.suicide).toHaveBeenCalled();
    });

    it("does not enter hauling or suicide combat creeps when the target room is not visible", () => {
      setupSourceRoom();
      delete Game.rooms[TARGET_ROOM];

      const attacker = createMockPowerBankCreep("powerBankAttacker", { id: "attacker-id" });
      const healer = createMockPowerBankCreep("powerBankHealer", { id: "healer-id" });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
        bankId: "bank-0",
        hits: 200,
        lastSeenTick: Game.time - 1,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
      expect(attacker.suicide).not.toHaveBeenCalled();
      expect(healer.suicide).not.toHaveBeenCalled();
    });

    it("cleans stale primary configs while target room is not visible", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      delete Game.rooms[TARGET_ROOM];

      const activeAttackerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1);
      const activeHealerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 1);
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-1",
        id: "attacker-id",
        roomName: "E5N60",
        memory: {
          role: "powerBankAttacker",
          configName: activeAttackerConfig,
          taskId: "pb-test",
        } as Partial<CreepMemory>,
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-1",
        id: "healer-id",
        roomName: "E5N60",
        memory: {
          role: "powerBankHealer",
          configName: activeHealerConfig,
          taskId: "pb-test",
        } as Partial<CreepMemory>,
      });
      Game.creeps[attacker.name] = attacker;
      Game.creeps[healer.name] = healer;
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
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
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
      expect(configStore.get(primaryAttacker)).toBeUndefined();
      expect(configStore.get(primaryHealer)).toBeUndefined();
      expect(configStore.get(activeAttackerConfig)).toBeDefined();
      expect(configStore.get(activeHealerConfig)).toBeDefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
    });

    it("cancels pending reinforcement configs when the bank is destroyed", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", { id: "attacker-id" });
      const healer = createMockPowerBankCreep("powerBankHealer", { id: "healer-id" });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        return null;
      }) as any;

      const reinforcementAttacker = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1);
      const reinforcementHealer = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 1);
      const configStore = getCreepConfigService();
      configStore.add(reinforcementAttacker, "powerBankAttacker", SOURCE_ROOM, TARGET_ROOM);
      configStore.add(reinforcementHealer, "powerBankHealer", SOURCE_ROOM, TARGET_ROOM);
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [reinforcementAttacker, reinforcementHealer];

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
        bankId: "bank-0",
        reinforcement: {
          index: 1,
          stage: "spawning",
          attackerReady: false,
          healerReady: false,
        },
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(task.reinforcement).toBeUndefined();
      expect(configStore.get(reinforcementAttacker)).toBeUndefined();
      expect(configStore.get(reinforcementHealer)).toBeUndefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
    });

    it("cancels pending reinforcement configs when the active attacker dies", () => {
      setupSourceRoom();

      const bank = createMockPowerBank({ id: "bank-0", hits: 500_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      const reinforcementAttacker = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1);
      const reinforcementHealer = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 1);
      const configStore = getCreepConfigService();
      configStore.add(reinforcementAttacker, "powerBankAttacker", SOURCE_ROOM, TARGET_ROOM);
      configStore.add(reinforcementHealer, "powerBankHealer", SOURCE_ROOM, TARGET_ROOM);
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [reinforcementAttacker, reinforcementHealer];

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        reinforcement: {
          index: 1,
          stage: "spawning",
          attackerReady: false,
          healerReady: false,
        },
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.reinforcement).toBeUndefined();
      expect(configStore.get(reinforcementAttacker)).toBeUndefined();
      expect(configStore.get(reinforcementHealer)).toBeUndefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
    });

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

    it("delays hauler configs while the bank is still far from destruction", () => {
      setupSourceRoom({ energyCapacity: 12_000, spawnCount: 3 });

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
      });
      Game.creeps["attacker-0"] = attacker;

      const bank = createMockPowerBank({ id: "bank-0", hits: 2_000_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        power: 5000,
        routeDistance: 5,
        tier: 6,
      }));

      runPowerBankHarvest();

      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(0);
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
    });

    it("queues a reinforcement pair when the active attacker cannot outlive the bank", () => {
      setupSourceRoom({ energyCapacity: 12_000 });

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
      });
      (attacker as Creep & { ticksToLive: number }).ticksToLive = 100;
      Game.creeps["attacker-0"] = attacker;

      const bank = createMockPowerBank({ id: "bank-0", hits: 500_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        routeDistance: 2,
        tier: 6,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.reinforcement).toMatchObject({ index: 1, stage: "spawning" });
      expect(getCreepConfigService().get(getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1))).toMatchObject({
        role: "powerBankAttacker",
        roomName: SOURCE_ROOM,
      });
      expect(getCreepConfigService().get(getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 1))).toMatchObject({
        role: "powerBankHealer",
        roomName: SOURCE_ROOM,
      });
    });

    it("removes primary combat configs after promoting a reinforcement attacker", () => {
      setupSourceRoom({ energyCapacity: 12_000 });

      const replacement = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-1",
        id: "replacement-attacker-id",
        roomName: TARGET_ROOM,
        memory: {
          role: "powerBankAttacker",
          configName: getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1),
          taskId: "pb-test",
        } as Partial<CreepMemory>,
      });
      Game.creeps[replacement.name] = replacement;

      const bank = createMockPowerBank({ id: "bank-0", hits: 500_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "old-attacker-id") return null;
        if (id === "replacement-attacker-id") return replacement;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      const primaryAttacker = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const primaryHealer = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      const reinforcementAttacker = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 1);
      const configStore = getCreepConfigService();
      configStore.add(primaryAttacker, "powerBankAttacker", TARGET_ROOM, "");
      configStore.add(primaryHealer, "powerBankHealer", TARGET_ROOM, "");
      configStore.add(reinforcementAttacker, "powerBankAttacker", TARGET_ROOM, "");
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [primaryAttacker, primaryHealer];

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "old-attacker-id",
        bankId: "bank-0",
        routeDistance: 2,
        tier: 6,
        reinforcement: {
          index: 1,
          stage: "attacking",
          attackerReady: true,
          healerReady: true,
          attackerId: "replacement-attacker-id",
        },
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.attackerId).toBe("replacement-attacker-id");
      expect(task.reinforcement).toBeUndefined();
      expect(configStore.get(primaryAttacker)).toBeUndefined();
      expect(configStore.get(primaryHealer)).toBeUndefined();
      expect(configStore.get(reinforcementAttacker)).toBeDefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
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

    it("accounts for serial hauler spawning when the source room has one spawn", () => {
      setupSourceRoom({ energyCapacity: 12_000, spawnCount: 1 });

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
      });
      Game.creeps["attacker-0"] = attacker;

      const bank = createMockPowerBank({ id: "bank-0", hits: 1_500_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        power: 5000,
        routeDistance: 1,
        tier: 6,
      }));

      runPowerBankHarvest();

      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(4);
    });

    it("does not overestimate hauler spawn time when multiple spawns can work in parallel", () => {
      setupSourceRoom({ energyCapacity: 12_000, spawnCount: 3 });

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
      });
      Game.creeps["attacker-0"] = attacker;

      const bank = createMockPowerBank({ id: "bank-0", hits: 1_600_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        power: 5000,
        routeDistance: 1,
        tier: 6,
      }));

      runPowerBankHarvest();

      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(0);
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
    });

    it("assigns task ids to live haulers while attacking", () => {
      setupSourceRoom({ energyCapacity: 12_000 });

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
      });
      Game.creeps["attacker-0"] = attacker;

      const configName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "hauler", 0);
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-0",
        roomName: SOURCE_ROOM,
        memory: { role: "powerBankHauler", configName } as Partial<CreepMemory>,
      });
      Game.creeps["hauler-0"] = hauler;
      Memory.creeps!["hauler-0"] = hauler.memory;

      const bank = createMockPowerBank({ id: "bank-0", hits: 100_000 });
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        power: 5000,
      }));

      runPowerBankHarvest();

      expect((hauler.memory as PowerBankTestMemory).taskId).toBe("pb-test");
    });

    it("transitions to aborted when TOUGH is broken", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 0 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-0"] = attacker;

      const bank = createMockPowerBank({ id: "bank-0" });

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
      }));

      mockReleaseBoostLabs();

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
      expect(getTask("pb-test")!.failReason).toBeUndefined();
    });

    it("stays attacking when bank still exists and TOUGH intact", () => {
      setupSourceRoom();

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

      const bank = createMockPowerBank({ id: "bank-0" });

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ATTACKING);
    });

    it("releases stale boost reservations while already attacking", () => {
      setupSourceRoom();
      const releaseSpy = mockReleaseBoostLabs();

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

      const bank = createMockPowerBank({ id: "bank-0" });

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "bank-0") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
        boostLabs: ["lab-a", "lab-b"],
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ATTACKING);
      expect(task.boostLabs).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });
  });

  describe("hauling", () => {
    it("transitions to complete when no power remains after empty hauling confirmation", () => {
      setupTargetRoom();
      Game.time = 300;

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        haulingStartedTick: 100,
        haulingEmptySince: 100,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.COMPLETE);
    });

    it("keeps hauling immediately after bank disappears even if no dropped power is visible yet", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      setupTargetRoom();
      Game.time = 300;

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        haulingStartedTick: 250,
        haulerCount: 3,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(task.terminalTick).toBeUndefined();
      expect(task.haulingEmptySince).toBe(300);
      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(0);
    });

    it("enters hauling with hauler configs when the bank disappears", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      setupTargetRoom();
      Game.time = 300;
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-id",
        roomName: TARGET_ROOM,
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-id",
        roomName: TARGET_ROOM,
      });

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-id") return attacker;
        if (id === "healer-id") return healer;
        if (id === "bank-0") return null;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        healerId: "healer-id",
        bankId: "bank-0",
        haulerCount: 3,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(task.haulingStartedTick).toBe(300);
      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(3);
      expect(attacker.suicide).toHaveBeenCalled();
      expect(healer.suicide).toHaveBeenCalled();
    });

    it("stays hauling when power resource exists", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      const targetRoom = {
        name: TARGET_ROOM,
        find: jest.fn((type: number) => {
          if (type === FIND_DROPPED_RESOURCES) {
            return [{ resourceType: RESOURCE_POWER, amount: 1000 }];
          }
          return [];
        }),
      } as unknown as Room;
      Game.rooms[TARGET_ROOM] = targetRoom;

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(getTask("pb-test")!.haulingEmptySince).toBeUndefined();
      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(4);
    });

    it("stays hauling while haulers are still carrying power", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      setupTargetRoom();

      const configStore = getCreepConfigService();
      const haulerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "hauler", 0);
      configStore.add(haulerName, "powerBankHauler", SOURCE_ROOM);
      const hauler = createMockPowerBankCreep("powerBankHauler", {
        name: "hauler-0",
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_POWER]: 500 },
        memory: { configName: haulerName },
      });
      Game.creeps[hauler.name] = hauler;

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        haulerCount: 1,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(task.haulingEmptySince).toBe(Game.time);
      expect(getCreepConfigService().get(haulerName)).toBeDefined();
    });

    it("does not create replacement haulers after the target room is empty", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      setupTargetRoom();
      Game.time = 400;

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        haulerCount: 3,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.HAULING);
      expect(task.haulingEmptySince).toBe(400);
      const haulerConfigs = Object.values(getCreepConfigService().list()).filter((config) => config.role === "powerBankHauler");
      expect(haulerConfigs).toHaveLength(0);
    });

    it("removes primary combat configs while hauling", () => {
      setupSourceRoom({ energyCapacity: 12_000 });
      setupTargetRoom();
      const configStore = getCreepConfigService();
      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(attackerName, "powerBankAttacker", TARGET_ROOM);
      configStore.add(healerName, "powerBankHealer", TARGET_ROOM);
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [attackerName, healerName];

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
      }));

      runPowerBankHarvest();

      expect(configStore.get(attackerName)).toBeUndefined();
      expect(configStore.get(healerName)).toBeUndefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([]);
    });
  });

  describe("cleanup", () => {
    it("releases labs and removes configs on terminal state", () => {
      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();

      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      configStore.add(attackerName, "powerBankAttacker", TARGET_ROOM);

      addTask(makeTask({
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        boostLabs: ["lab-0", "lab-1"],
        failReason: "test",
        terminalTick: 100,
      }));

      runPowerBankHarvest();

      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

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

    it("removes orphan powerbank configs with no active task", () => {
      setupSourceRoom();
      const configStore = getCreepConfigService();
      const staleConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "hauler", 0);
      const activeConfigName = getPowerBankConfigName(SOURCE_ROOM, "E1N60", "attacker", 0);

      configStore.add(staleConfigName, "powerBankHauler", TARGET_ROOM);
      configStore.add(activeConfigName, "powerBankAttacker", "E1N60");
      Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList = [staleConfigName, activeConfigName];

      addTask(makeTask({
        id: "active-task",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: "E1N60",
      }));

      runPowerBankHarvest();

      expect(configStore.get(staleConfigName)).toBeUndefined();
      expect(configStore.get(activeConfigName)).toBeDefined();
      expect(Game.spawns[`${SOURCE_ROOM}-spawn1`].memory.spawnList).toEqual([activeConfigName]);
    });
  });

  describe("stale cleanup", () => {
    it("removes tasks in terminal state for over 100 ticks", () => {
      mockReleaseBoostLabs();

      addTask(makeTask({
        id: "pb-stale",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        failReason: "old",
        terminalTick: 1,
      }));

      Game.time = 200;
      runPowerBankHarvest();

      expect(getTask("pb-stale")).toBeUndefined();
    });

    it("keeps recently terminal tasks", () => {
      mockReleaseBoostLabs();

      addTask(makeTask({
        id: "pb-recent",
        status: POWER_BANK_STATUS.COMPLETE,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        terminalTick: 95,
      }));

      Game.time = 100;
      runPowerBankHarvest();

      expect(getTask("pb-recent")).toBeDefined();
    });
  });

  describe("full lifecycle", () => {
    it("transitions through discovery → preparing_boosts → spawning → renewing → boosting → travelling → attacking → hauling → complete", () => {
      setupSourceRoom();
      setupTargetRoom();

      mockSelectBodyTier("rcl8");
      mockAssessViability(true);
      const boostSpy = mockPrepareBoosts("ready", ["lab-0"]);
      const releaseSpy = mockReleaseBoostLabs();

      Game.getObjectById = jest.fn(() => null) as any;

      const store = Memory.data!.powerBankHarvest!;
      store["pb-lifecycle"] = makeTask({
        id: "pb-lifecycle",
        status: POWER_BANK_STATUS.DISCOVERED,
        targetRoom: TARGET_ROOM,
        hits: 2_000_000,
        power: 5000,
        ticksToDecay: 5000,
        freeTiles: 8,
      });

      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.PREPARING_BOOSTS);
      expect(store["pb-lifecycle"].sourceRoom).toBe(SOURCE_ROOM);

      boostSpy.mockReturnValue({ status: "ready", labs: ["lab-0"] });
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.SPAWNING);

      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.RENEWING);

      Game.time = 101;

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-life",
        id: "attacker-life-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-life",
        id: "healer-life-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;

      Game.creeps["attacker-life"] = attacker;
      Game.creeps["healer-life"] = healer;

      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.BOOSTING);

      (attacker.body[0] as any).boost = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
      (attacker.body[1] as any).boost = RESOURCE_CATALYZED_UTRIUM_ACID;

      Game.time = 102;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(store["pb-lifecycle"].attackerId).toBe("attacker-life-id");
      expect(store["pb-lifecycle"].healerId).toBe("healer-life-id");

      // Move creeps to target room
      (attacker as any).room = { name: TARGET_ROOM };
      (healer as any).room = { name: TARGET_ROOM };

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-life-id") return attacker;
        if (id === "healer-life-id") return healer;
        return null;
      }) as any;

      Game.time = 103;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.ATTACKING);

      // Bank destroyed → hauling
      Game.time = 104;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.HAULING);

      // No power resource → complete after empty hauling confirmation window
      Game.time = 105;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.HAULING);
      expect(store["pb-lifecycle"].haulingEmptySince).toBe(105);

      Game.time = 206;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.COMPLETE);

      expect(releaseSpy).toHaveBeenCalled();
    });
  });

  describe("renewing synchronization", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("both members transition to boosting in the same tick when both TTL sufficient", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

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
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(false);
      expect(task.healerReady).toBe(false);
    });

    it("waits for lower-TTL creep to be renewed before transitioning to boosting", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 40;

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

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.RENEWING);
      expect(task.attackerReady).toBe(true);
      expect(task.healerReady).toBe(false);
    });

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

  describe("boosting synchronization", () => {
    it("recomputes boost readiness from body state even when ready flags are pre-set", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        attackerReady: true,
        healerReady: true,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(false);
      expect(task.healerReady).toBe(true);
    });

    it("aborts when both creeps die during boosting", () => {
      setupSourceRoom();

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      mockReleaseBoostLabs();

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });

    it("transitions from boosting to travelling when attacker gets boosted mid-task", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);

      (attacker.body[0] as any).boost = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
      (attacker.body[1] as any).boost = RESOURCE_CATALYZED_UTRIUM_ACID;

      runPowerBankHarvest();
      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerId).toBe("attacker-0-id");
      expect(task.healerId).toBe("healer-0-id");
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

    it("processSpawning aborts to failed when boost prep fails mid-spawn", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("failed", []);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("boost_prep_failed_during_spawning");
    });

    it("processRenewing aborts to failed when boost prep fails", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

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
        routeDistance: 5,
      }));

      mockPrepareBoosts("failed", []);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("boost_prep_failed_during_renewing");
    });

    it("processBoosting aborts to failed when boost prep fails", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("failed", []);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("boost_prep_failed_during_boosting");
    });
  });

  // =====================================================================
  // Lifecycle & Waste-Prevention Integration Tests
  // =====================================================================

  describe("full lifecycle with time progression", () => {
    it("tracks Game.time through discovery → travelling → attacking → hauling → complete", () => {
      setupSourceRoom();
      setupTargetRoom();

      mockSelectBodyTier("rcl8");
      mockAssessViability(true);
      const boostSpy = mockPrepareBoosts("ready", ["lab-0"]);
      const releaseSpy = mockReleaseBoostLabs();

      Game.getObjectById = jest.fn(() => null) as any;

      Game.time = 100;
      const store = Memory.data!.powerBankHarvest!;
      store["pb-timing"] = makeTask({
        id: "pb-timing",
        status: POWER_BANK_STATUS.DISCOVERED,
        targetRoom: TARGET_ROOM,
        hits: 2_000_000,
        power: 5000,
        ticksToDecay: 5000,
        freeTiles: 8,
        discoveredTick: 100,
      });

      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.PREPARING_BOOSTS);
      expect(store["pb-timing"].sourceRoom).toBe(SOURCE_ROOM);

      Game.time = 120;
      boostSpy.mockReturnValue({ status: "ready", labs: ["lab-0"] });
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.SPAWNING);

      Game.time = 121;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.RENEWING);

      Game.time = 180;
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-timing",
        id: "attacker-timing-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-timing",
        id: "healer-timing-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;

      Game.creeps["attacker-timing"] = attacker;
      Game.creeps["healer-timing"] = healer;

      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.BOOSTING);

      (attacker.body[0] as any).boost = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
      (attacker.body[1] as any).boost = RESOURCE_CATALYZED_UTRIUM_ACID;

      Game.time = 181;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(store["pb-timing"].attackerId).toBe("attacker-timing-id");
      expect(store["pb-timing"].healerId).toBe("healer-timing-id");

      (attacker as any).room = { name: TARGET_ROOM };
      (healer as any).room = { name: TARGET_ROOM };

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-timing-id") return attacker;
        if (id === "healer-timing-id") return healer;
        return null;
      }) as any;

      Game.time = 182;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.ATTACKING);

      Game.time = 183;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.HAULING);

      Game.time = 184;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.HAULING);
      expect(store["pb-timing"].haulingEmptySince).toBe(184);

      Game.time = 285;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.COMPLETE);

      expect(releaseSpy).toHaveBeenCalled();
    });

    it("verifies no creep departs during boosting before both members ready", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);

      // Only attacker exists (not yet boosted)
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-only",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      (attacker as any).ticksToLive = 1500;

      Game.creeps["attacker-only"] = attacker;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      // Run multiple ticks — task should stay in boosting
      for (let i = 0; i < 5; i++) {
        runPowerBankHarvest();
        const task = getTask("pb-test")!;
        expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
        expect(task.attackerId).toBeFalsy();
        expect(task.healerId).toBeFalsy();
      }
    });
  });

  describe("near-expiry waste prevention", () => {
    it("rejects task when ticksToDecay is below time budget — no boost/spawn/config created", () => {
      setupSourceRoom();

      // Real viability will see ticksToDecay too low → not viable
      jest.spyOn(require("@/runtime/powerBankViability"), "assessViability").mockReturnValue({
        viable: false,
        reasons: ["decay_too_soon"],
        estimates: {
          ttk: 3000,
          dps: 1920,
          hitbackDPS: 960,
          healerHPS: 336,
          timeBudget: 5000,
          haulerCount: 4,
          haulDepartTick: 3100,
        },
      });

      addTask(makeTask({
        status: POWER_BANK_STATUS.DISCOVERED,
        targetRoom: TARGET_ROOM,
        ticksToDecay: 50,
        hits: 2_000_000,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("decay_too_soon");

      expect(task.boostLabs).toEqual([]);
      expect(task.sourceRoom).toBeFalsy();

      const configs = getCreepConfigService().list();
      const powerBankConfigs = Object.keys(configs).filter(k => k.includes("powerbank") && k !== PATROL_SCOUT_CONFIG_NAME);
      expect(powerBankConfigs).toHaveLength(0);
    });

    it("rejects task immediately at discovery when time budget exceeds ticksToDecay", () => {
      setupSourceRoom();

      mockSelectBodyTier("rcl8");
      jest.spyOn(require("@/runtime/powerBankViability"), "assessViability").mockReturnValue({
        viable: false,
        reasons: ["decay_too_soon"],
        estimates: {
          ttk: 3000,
          dps: 1920,
          hitbackDPS: 960,
          healerHPS: 336,
          timeBudget: 4500,
          haulerCount: 4,
          haulDepartTick: 3100,
        },
      });

      // Bank with ticksToDecay far below what's needed
      addTask(makeTask({
        status: POWER_BANK_STATUS.DISCOVERED,
        ticksToDecay: 100,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      // Task failed immediately — never entered preparing_boosts
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toContain("decay_too_soon");
    });
  });

  describe("insufficient compound waste prevention", () => {
    it("fails task before spawn when no XUH2O available in any room", () => {
      const storage = {
        store: createMockStore({
          [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
          [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
        }),
      };
      const terminal = { store: createMockStore({}), cooldown: 0 };

      const room = {
        name: SOURCE_ROOM,
        controller: { my: true, level: 8 },
        energyCapacityAvailable: 12_000,
        storage,
        terminal,
        find: () => [],
      } as unknown as Room;

      Game.rooms[SOURCE_ROOM] = room;

      const spawn = {
        name: `${SOURCE_ROOM}-spawn1`,
        room,
        memory: { spawnList: [] },
        spawning: null,
        isActive: () => true,
        renewCreep: jest.fn((_creep: Creep) => OK),
      } as unknown as StructureSpawn;

      Game.spawns[spawn.name] = spawn;

      mockSelectBodyTier("rcl8");
      jest.spyOn(require("@/runtime/powerBankViability"), "assessViability").mockReturnValue({
        viable: false,
        reasons: ["insufficient_boost_compound"],
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

      addTask(makeTask({
        status: POWER_BANK_STATUS.DISCOVERED,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toContain("insufficient_boost_compound");

      const configs = getCreepConfigService().list();
      const pbConfigs = Object.keys(configs).filter(k => k.includes("powerbank") && k !== PATROL_SCOUT_CONFIG_NAME);
      expect(pbConfigs).toHaveLength(0);
    });
  });

  describe("insufficient hauler timing waste prevention", () => {
    it("rejects task when haulers cannot arrive before bank despawns", () => {
      setupSourceRoom();

      mockSelectBodyTier("rcl8");
      jest.spyOn(require("@/runtime/powerBankViability"), "assessViability").mockReturnValue({
        viable: false,
        reasons: ["insufficient_hauler_timing"],
        estimates: {
          ttk: 3000,
          dps: 1920,
          hitbackDPS: 960,
          healerHPS: 336,
          timeBudget: 3500,
          haulerCount: 4,
          haulDepartTick: 3100,
        },
      });

      addTask(makeTask({
        status: POWER_BANK_STATUS.DISCOVERED,
        ticksToDecay: 500,
        routeDistance: 20,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toContain("insufficient_hauler_timing");

      const configs = getCreepConfigService().list();
      expect(Object.keys(configs).filter(k => k.includes("powerbank") && k !== PATROL_SCOUT_CONFIG_NAME)).toHaveLength(0);
    });
  });

  describe("mid-operation bank disappearance", () => {
    it("transitions to hauling when bank destroyed during attacking", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-mid",
        id: "attacker-mid-id",
        roomName: TARGET_ROOM,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-mid"] = attacker;

      Game.getObjectById = jest.fn(() => null) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-mid-id",
        bankId: "bank-mid",
      }));

      runPowerBankHarvest();

      // Bank gone → hauling
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.HAULING);
    });

    it("handles bank vanishing when attacker still alive and TOUGH intact", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-vanish",
        id: "attacker-vanish-id",
        roomName: TARGET_ROOM,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-vanish"] = attacker;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-vanish-id") return attacker;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-vanish-id",
        bankId: "bank-vanish",
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.HAULING);
    });
  });

  describe("TOUGH break abort with cleanup", () => {
    it("aborts and verifies full cleanup when TOUGH breaks during attack", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-tough",
        id: "attacker-tough-id",
        roomName: TARGET_ROOM,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 0 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-tough"] = attacker;

      const bank = createMockPowerBank({ id: "bank-tough" });

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-tough-id") return attacker;
        if (id === "bank-tough") return bank;
        return null;
      }) as any;

      const configStore = getCreepConfigService();
      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(attackerName, "powerBankAttacker", TARGET_ROOM);
      configStore.add(healerName, "powerBankHealer", TARGET_ROOM);

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-tough-id",
        bankId: "bank-tough",
        boostLabs: ["lab-tough-0", "lab-tough-1"],
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ATTACKING);
      expect(task.failReason).toBeUndefined();

      expect(task.boostLabs).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
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

    it("cleanup at spawning: removes spawn config, releases labs", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();

      addTask(makeTask({
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-s", "lab-s2"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
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

    it("cleanup at renewing: releases labs on defense mode abort", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(attackerConfigName, "powerBankAttacker", TARGET_ROOM);
      configStore.add(healerConfigName, "powerBankHealer", TARGET_ROOM);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-renew",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-renew",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;

      Game.creeps["attacker-renew"] = attacker;
      Game.creeps["healer-renew"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-r0"],
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

    it("cleanup at travelling: releases labs on creep death in transit", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(attackerConfigName, "powerBankAttacker", TARGET_ROOM);
      configStore.add(healerConfigName, "powerBankHealer", TARGET_ROOM);

      Game.getObjectById = jest.fn(() => null) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.TRAVELLING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "dead-attacker-id",
        healerId: "dead-healer-id",
        boostLabs: ["lab-t0"],
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.terminalTick).toBe(Game.time);
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });
  });

  describe("defense mode cancellation", () => {
    it("aborts during preparing_boosts — no spawn config persists, labs released", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();

      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
        boostLabs: ["lab-d1"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("defense_mode");

      const configs = getCreepConfigService().list();
      const pbConfigs = Object.keys(configs).filter(k => k.includes("powerbank") && k !== PATROL_SCOUT_CONFIG_NAME);
      expect(pbConfigs).toHaveLength(0);

      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

    it("aborts during spawning — removes existing spawn config, releases labs", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      mockPrepareBoosts("ready", ["lab-d2"]);

      addTask(makeTask({
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-d2"],
      }));

      runPowerBankHarvest();

      const taskAfterSpawning = getTask("pb-test")!;
      const configs = getCreepConfigService().list();
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      expect(configs[attackerConfigName]).toBeDefined();
      expect(configs[healerConfigName]).toBeDefined();

      taskAfterSpawning.status = POWER_BANK_STATUS.SPAWNING;

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("defense_mode");
      expect(task.terminalTick).toBe(Game.time);

      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

    it("aborts during renewing on defense mode — releases labs", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-def",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-def",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;

      Game.creeps["attacker-def"] = attacker;
      Game.creeps["healer-def"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-d3"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("defense_mode");
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

    it("aborts during travelling on defense mode", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-travel-def",
        id: "attacker-travel-def-id",
        roomName: SOURCE_ROOM,
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-travel-def",
        id: "healer-travel-def-id",
        roomName: SOURCE_ROOM,
      });
      Game.creeps["attacker-travel-def"] = attacker;
      Game.creeps["healer-travel-def"] = healer;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-travel-def-id") return attacker;
        if (id === "healer-travel-def-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.TRAVELLING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-travel-def-id",
        healerId: "healer-travel-def-id",
        boostLabs: ["lab-d4"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("defense_mode");
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

    it("does not abort an already-attacking squad on source-room defense mode", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-atk-def",
        id: "attacker-atk-def-id",
        roomName: TARGET_ROOM,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-atk-def"] = attacker;

      const bank = createMockPowerBank({ id: "bank-atk-def" });

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-atk-def-id") return attacker;
        if (id === "bank-atk-def") return bank;
        return null;
      }) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-atk-def-id",
        bankId: "bank-atk-def",
        boostLabs: ["lab-d5"],
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ATTACKING);
      expect(task.failReason).toBeUndefined();
      expect(task.boostLabs).toEqual([]);
      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });
  });

  describe("terminal state memory cleanup", () => {
    it("cleans up task memory after cleanup delay for each terminal status", () => {
      mockReleaseBoostLabs();

      const statuses: Array<{ status: PowerBankHarvestStatus; reason?: string }> = [
        { status: POWER_BANK_STATUS.FAILED, reason: "test_fail" },
        { status: POWER_BANK_STATUS.ABORTED, reason: "test_abort" },
        { status: POWER_BANK_STATUS.COMPLETE },
      ];

      for (let i = 0; i < statuses.length; i++) {
        const s = statuses[i];
        const id = `pb-cleanup-${i}`;
        addTask(makeTask({
          id,
          status: s.status,
          sourceRoom: SOURCE_ROOM,
          targetRoom: TARGET_ROOM,
          failReason: s.reason,
          terminalTick: 100,
        }));
      }

      // Not yet expired
      Game.time = 150;
      runPowerBankHarvest();
      for (let i = 0; i < statuses.length; i++) {
        expect(getTask(`pb-cleanup-${i}`)).toBeDefined();
      }

      // Expired
      Game.time = 201;
      runPowerBankHarvest();
      for (let i = 0; i < statuses.length; i++) {
        expect(getTask(`pb-cleanup-${i}`)).toBeUndefined();
      }
    });
  });

  describe("patrol scout maintenance", () => {
    const SCOUT_CONFIG_NAME = "powerbank:patrol:scout:0";

    it("creates scout config when no scout exists and eligible room available", () => {
      setupSourceRoom();

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      expect(configs[SCOUT_CONFIG_NAME]).toBeDefined();
      expect(configs[SCOUT_CONFIG_NAME].role).toBe("powerBankScout");
      expect(configs[SCOUT_CONFIG_NAME].roomName).toBe(SOURCE_ROOM);
      expect(configs[SCOUT_CONFIG_NAME].args).toEqual([]);
    });

    it("does not create config when scout is alive", () => {
      setupSourceRoom();

      const scoutConfig = getCreepConfigService();
      scoutConfig.add(SCOUT_CONFIG_NAME, "powerBankScout", SOURCE_ROOM);

      const scout = createMockPowerBankCreep("powerBankScout", {
        name: "scout-alive",
        roomName: SOURCE_ROOM,
        memory: { configName: SCOUT_CONFIG_NAME, role: "powerBankScout" },
      });
      Game.creeps["scout-alive"] = scout;

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      const scoutConfigs = Object.keys(configs).filter(k => k === SCOUT_CONFIG_NAME);
      expect(scoutConfigs).toHaveLength(1);
    });

    it("does not create config when scout is being spawned", () => {
      setupSourceRoom();

      const configStore = getCreepConfigService();
      configStore.add(SCOUT_CONFIG_NAME, "powerBankScout", SOURCE_ROOM);

      const spawn = Game.spawns[`${SOURCE_ROOM}-spawn1`] as unknown as StructureSpawn;
      (spawn as any).spawning = {
        name: "scout-spawning",
        remainingTime: 10,
        needTime: 20,
      };
      Memory.creeps["scout-spawning"] = { configName: SCOUT_CONFIG_NAME } as any;

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      expect(configs[SCOUT_CONFIG_NAME]).toBeDefined();
    });

    it("does not create config when no eligible rooms exist", () => {
      const room = {
        name: "lowRCLRoom",
        controller: { my: true, level: 3 },
        energyCapacityAvailable: 300,
        find: () => [],
      } as unknown as Room;

      Game.rooms["lowRCLRoom"] = room;

      const spawn = {
        name: "lowRCLRoom-spawn1",
        room,
        memory: { spawnList: [] },
        spawning: null,
        isActive: () => true,
      } as unknown as StructureSpawn;

      Game.spawns[spawn.name] = spawn;

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      expect(configs[SCOUT_CONFIG_NAME]).toBeUndefined();
    });

    it("cleans stale config when scout is dead and not spawning", () => {
      setupSourceRoom();

      const configStore = getCreepConfigService();
      configStore.add(SCOUT_CONFIG_NAME, "powerBankScout", SOURCE_ROOM);

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      const scoutConfigs = Object.keys(configs).filter(k => k === SCOUT_CONFIG_NAME);
      expect(scoutConfigs).toHaveLength(1);
      expect(configs[SCOUT_CONFIG_NAME].role).toBe("powerBankScout");
    });

    it("picks nearest room to first patrol room", () => {
      const room1 = {
        name: "E8N55",
        controller: { my: true, level: 8 },
        energyCapacityAvailable: 12_000,
        storage: { store: createMockStore({}) },
        terminal: { store: createMockStore({}), cooldown: 0 },
        find: () => [],
      } as unknown as Room;
      Game.rooms["E8N55"] = room1;

      const spawn1 = {
        name: "E8N55-spawn1",
        room: room1,
        memory: { spawnList: [] },
        spawning: null,
        isActive: () => true,
        renewCreep: jest.fn(() => OK),
      } as unknown as StructureSpawn;
      Game.spawns["E8N55-spawn1"] = spawn1;

      const room2 = {
        name: "E1N55",
        controller: { my: true, level: 8 },
        energyCapacityAvailable: 12_000,
        storage: { store: createMockStore({}) },
        terminal: { store: createMockStore({}), cooldown: 0 },
        find: () => [],
      } as unknown as Room;
      Game.rooms["E1N55"] = room2;

      const spawn2 = {
        name: "E1N55-spawn1",
        room: room2,
        memory: { spawnList: [] },
        spawning: null,
        isActive: () => true,
        renewCreep: jest.fn(() => OK),
      } as unknown as StructureSpawn;
      Game.spawns["E1N55-spawn1"] = spawn2;

      Game.map.getRoomLinearDistance = jest.fn((from: string, to: string) => {
        if (to === "E0N60") {
          if (from === "E1N55") return 1;
          if (from === "E8N55") return 8;
        }
        return 5;
      });
      Game.map.findRoute = jest.fn((from: string, to: string) => {
        if (to === "E0N60") {
          if (from === "E1N55") return [{ room: "E0N60", exit: FIND_EXIT_LEFT }];
          if (from === "E8N55") return Array.from({ length: 8 }, (_, i) => ({ room: `E${7 - i}N60`, exit: FIND_EXIT_RIGHT }));
        }
        return [{ room: "corridor", exit: FIND_EXIT_RIGHT }];
      });

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      expect(configs[SCOUT_CONFIG_NAME]).toBeDefined();
      expect(configs[SCOUT_CONFIG_NAME].roomName).toBe("E1N55");
    });

    it("does not create scout config when observers cover all patrol rooms", () => {
      setupSourceRoom();
      const observerModule = require("@/runtime/powerBankObserver");
      jest.spyOn(observerModule, "hasPowerBankObserverCoverage").mockReturnValue(true);

      runPowerBankHarvest();

      const configs = getCreepConfigService().list();
      expect(configs[SCOUT_CONFIG_NAME]).toBeUndefined();
    });

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

  describe("active boost lab interaction", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    function mockGetAssignedLab(map: Record<string, string>): jest.SpyInstance {
      const mod = require("@/runtime/powerBankBoostMemory");
      return jest.spyOn(mod, "getAssignedPowerBankBoostLabId").mockImplementation(
        (_taskId: string, compound: ResourceConstant) => map[compound] ?? undefined,
      );
    }

    it("multi-boost attacker: moves to labs and receives sequential boosts", () => {
      setupSourceRoom();

      const sharedMod = require("@/roles/shared");
      const moveToTargetSpy = jest.spyOn(sharedMod, "moveToTarget").mockReturnValue(OK);

      const xgho2Lab = createMockLab({
        id: "lab-xgho2",
        x: 24,
        y: 24,
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 100 },
      });
      const xuh2oLab = createMockLab({
        id: "lab-xuh2o",
        x: 30,
        y: 30,
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_CATALYZED_UTRIUM_ACID]: 100 },
      });

      mockGetAssignedLab({
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: "lab-xgho2",
        [RESOURCE_CATALYZED_UTRIUM_ACID]: "lab-xuh2o",
      });

      const originalGetObjectById = Game.getObjectById;
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "lab-xgho2") return xgho2Lab;
        if (id === "lab-xuh2o") return xuh2oLab;
        return null;
      }) as any;

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-0-id",
        x: 24,
        y: 24,
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-0-id",
        x: 25,
        y: 25,
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      // Tick 1: attacker adjacent to XGHO2 lab, gets first boost
      runPowerBankHarvest();
      expect(xgho2Lab.boostCreep).toHaveBeenCalledWith(attacker);
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);

      // Simulate XGHO2 applied to body (effective next tick)
      (attacker.body[0] as any).boost = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;

      // Tick 2: attacker needs XUH2O, not near that lab → moveToTarget called
      runPowerBankHarvest();
      expect(moveToTargetSpy).toHaveBeenCalledWith(attacker, xuh2oLab, 1, { reusePath: 3, maxRooms: 1 });
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);

      // Simulate attacker now adjacent to XUH2O lab
      (attacker as any).pos = new MockPos(30, 29, SOURCE_ROOM) as unknown as RoomPosition;

      // Tick 3: attacker gets XUH2O boost applied
      runPowerBankHarvest();
      expect(xuh2oLab.boostCreep).toHaveBeenCalledWith(attacker);
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);

      // Simulate XUH2O applied to body (effective next tick)
      (attacker.body[1] as any).boost = RESOURCE_CATALYZED_UTRIUM_ACID;

      // Tick 4: all boosts satisfied → TRAVELLING
      runPowerBankHarvest();
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.TRAVELLING);

      Game.getObjectById = originalGetObjectById;
      moveToTargetSpy.mockRestore();
    });

    it("lab not ready blocks travel — empty compound store", () => {
      setupSourceRoom();

      const xgho2Lab = createMockLab({
        id: "lab-xgho2",
        x: 24,
        y: 24,
        roomName: SOURCE_ROOM,
        store: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 0 },
      });

      mockGetAssignedLab({
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: "lab-xgho2",
      });

      const originalGetObjectById = Game.getObjectById;
      Game.getObjectById = jest.fn((id: string) => {
        if (id === "lab-xgho2") return xgho2Lab;
        return null;
      }) as any;

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-0-id",
        x: 24,
        y: 24,
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 6,
      }));

      runPowerBankHarvest();

      // Lab has 0 compound → no boost, stays BOOSTING
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(xgho2Lab.boostCreep).not.toHaveBeenCalled();

      Game.getObjectById = originalGetObjectById;
    });

    it("RCL8 healer fast path — empty requirements, immediately boost-satisfied", () => {
      setupSourceRoom();

      mockGetAssignedLab({});

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

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      // Healer has empty requirements at tier 8 → immediately satisfied
      // Attacker is already fully boosted → both ready → TRAVELLING
      const task = getTask("pb-test")!;
      expect(task.healerReady).toBe(true);
      expect(task.attackerReady).toBe(true);
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
    });

    it("refreshes boost prep with only remaining unboosted body-part demand", () => {
      setupSourceRoom();
      const prepareSpy = require("@/runtime/powerBankBoost").prepareBoosts as jest.Mock;
      prepareSpy.mockClear();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          ...Array.from({ length: 4 }, () => ({ type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE })),
          ...Array.from({ length: 15 }, () => ({ type: ATTACK as BodyPartConstant, hits: 100 })),
          ...Array.from({ length: 19 }, () => ({ type: MOVE as BodyPartConstant, hits: 100 })),
        ],
      });

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
        body: [
          ...Array.from({ length: 7 }, () => ({ type: HEAL as BodyPartConstant, hits: 100 })),
          ...Array.from({ length: 7 }, () => ({ type: MOVE as BodyPartConstant, hits: 100 })),
        ],
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 6,
      }));

      runPowerBankHarvest();

      const remainingAmounts = prepareSpy.mock.calls[0][3] as Map<ResourceConstant, number>;
      expect(remainingAmounts.get(RESOURCE_CATALYZED_GHODIUM_ALKALIDE)).toBeUndefined();
      expect(remainingAmounts.get(RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(450);
      expect(remainingAmounts.get(RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE)).toBe(210);
    });

    it("missing lab assignment stays in BOOSTING", () => {
      setupSourceRoom();

      // No lab assigned for any compound
      mockGetAssignedLab({});

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        id: "attacker-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-0",
        id: "healer-0-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-0"] = attacker;
      Game.creeps["healer-0"] = healer;

      addTask(makeTask({
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(false);
      expect(task.healerReady).toBe(true);
    });
  });

  // =====================================================================
  // Lifecycle Integration: Concurrent Boost Tasks & Travel Transition
  // =====================================================================

  describe("concurrent boost tasks and travel transition", () => {
    const TARGET_ROOM_B = "E1N60";

    function setupSecondTargetRoom(): void {
      Game.rooms[TARGET_ROOM_B] = {
        name: TARGET_ROOM_B,
        find: () => [],
      } as unknown as Room;
    }

    /**
     * Creates two tasks sharing SOURCE_ROOM but targeting different power banks.
     * Task A: SOURCE_ROOM → TARGET_ROOM (pb-concurrent-a)
     * Task B: SOURCE_ROOM → TARGET_ROOM_B (pb-concurrent-b)
     */
    function setupConcurrentTasks(opts: {
      taskABoosted?: boolean;
      taskBBoosted?: boolean;
      taskAHealerSpawned?: boolean;
      taskBHealerSpawned?: boolean;
    } = {}): {
      taskA: PowerBankHarvestTask;
      taskB: PowerBankHarvestTask;
      attackerA: Creep;
      healerA: Creep;
      attackerB: Creep;
      healerB: Creep;
    } {
      const taskAConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerAConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      const taskBConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM_B, "attacker", 0);
      const healerBConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM_B, "healer", 0);

      const bodyBoosted = [
        { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
        { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
        { type: MOVE as BodyPartConstant, hits: 100 },
      ];
      const bodyUnboosted = [
        { type: TOUGH as BodyPartConstant, hits: 100 },
        { type: ATTACK as BodyPartConstant, hits: 100 },
        { type: MOVE as BodyPartConstant, hits: 100 },
      ];

      const attackerA = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-a",
        id: "attacker-a-id",
        roomName: SOURCE_ROOM,
        memory: { configName: taskAConfigName, role: "powerBankAttacker" },
        body: opts.taskABoosted ? bodyBoosted : bodyUnboosted,
      });

      const healerA = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-a",
        id: "healer-a-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerAConfigName, role: "powerBankHealer" },
      });

      const attackerB = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-b",
        id: "attacker-b-id",
        roomName: SOURCE_ROOM,
        memory: { configName: taskBConfigName, role: "powerBankAttacker" },
        body: opts.taskBBoosted ? bodyBoosted : bodyUnboosted,
      });

      const healerB = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-b",
        id: "healer-b-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerBConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-a"] = attackerA;
      Game.creeps["attacker-b"] = attackerB;

      if (opts.taskAHealerSpawned !== false) Game.creeps["healer-a"] = healerA;
      if (opts.taskBHealerSpawned !== false) Game.creeps["healer-b"] = healerB;

      const taskA = makeTask({
        id: "pb-concurrent-a",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      });
      const taskB = makeTask({
        id: "pb-concurrent-b",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM_B,
        tier: 8,
      });

      addTask(taskA);
      addTask(taskB);

      return { taskA, taskB, attackerA, healerA, attackerB, healerB };
    }

    // -------------------------------------------------------------------
    // 1. Concurrent task readiness isolation
    // -------------------------------------------------------------------

    it("concurrent tasks from same source room do not share boost readiness", () => {
      setupSourceRoom();
      setupTargetRoom();
      setupSecondTargetRoom();

      // Task A: both creeps boosted → should transition to travelling
      // Task B: attacker NOT boosted → should stay boosting
      setupConcurrentTasks({
        taskABoosted: true,
        taskBBoosted: false,
      });

      runPowerBankHarvest();

      const taskA = getTask("pb-concurrent-a")!;
      const taskB = getTask("pb-concurrent-b")!;

      // Task A: attacker boosted + healer no requirements → both ready → TRAVELLING
      expect(taskA.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(taskA.attackerReady).toBe(true);
      expect(taskA.healerReady).toBe(true);

      // Task B: attacker NOT boosted → stays BOOSTING
      expect(taskB.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(taskB.attackerReady).toBe(false);
      expect(taskB.healerReady).toBe(true);

      // Verify Task A did NOT steal Task B's creeps
      expect(taskA.attackerId).toBe("attacker-a-id");
      expect(taskA.healerId).toBe("healer-a-id");
    });

    it("Task B labs not loaded does not affect Task A transition", () => {
      setupSourceRoom();
      setupTargetRoom();
      setupSecondTargetRoom();

      // Both tasks have fully boosted creeps in body
      setupConcurrentTasks({
        taskABoosted: true,
        taskBBoosted: true,
      });

      // But mock prepareBoosts to return "preparing" for task B (labs not ready)
      // while returning "ready" for task A
      const mod = require("@/runtime/powerBankBoost");
      jest.spyOn(mod, "prepareBoosts").mockImplementation(
        (taskId: string, _sourceRoom: string, _tier: number) => {
          if (taskId === "pb-concurrent-b") {
            return { status: "preparing" as const, labs: ["lab-b1", "lab-b2"] };
          }
          return { status: "ready" as const, labs: ["lab-a1", "lab-a2"] };
        },
      );

      runPowerBankHarvest();

      const taskA = getTask("pb-concurrent-a")!;
      const taskB = getTask("pb-concurrent-b")!;

      // Task A: labs ready + creeps boosted → TRAVELLING
      expect(taskA.status).toBe(POWER_BANK_STATUS.TRAVELLING);

      // Task B: labs not ready but creeps are already boosted from body state
      // processBoosting only checks isBoostSatisfied on body, not lab status
      // (refreshPowerBankBoostPrep returns "preparing" but that doesn't abort)
      // So task B should also transition since body is already boosted
      expect(taskB.status).toBe(POWER_BANK_STATUS.TRAVELLING);
    });

    // -------------------------------------------------------------------
    // 2. Single-member task stays blocked
    // -------------------------------------------------------------------

    it("task with only attacker spawned stays in boosting and does not transition to travelling", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-solo",
        id: "attacker-solo-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      Game.creeps["attacker-solo"] = attacker;
      // No healer spawned

      addTask(makeTask({
        id: "pb-solo",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-solo")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(true);
      expect(task.healerReady).toBe(false);
    });

    it("task with only healer spawned stays in boosting", () => {
      setupSourceRoom();
      setupTargetRoom();

      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-solo",
        id: "healer-solo-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["healer-solo"] = healer;
      // No attacker spawned

      addTask(makeTask({
        id: "pb-healer-solo",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-healer-solo")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });

    // -------------------------------------------------------------------
    // 3. Travel transition requires BOTH creeps live AND boost-satisfied
    // -------------------------------------------------------------------

    it("does not transition to travelling when attacker is alive and boosted but healer is not spawned", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-ready",
        id: "attacker-ready-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      Game.creeps["attacker-ready"] = attacker;

      addTask(makeTask({
        id: "pb-no-healer",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-no-healer")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
    });

    it("does not transition to travelling when both creeps alive but attacker not boost-satisfied", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-unboosted",
        id: "attacker-unboosted-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-unboosted",
        id: "healer-unboosted-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-unboosted"] = attacker;
      Game.creeps["healer-unboosted"] = healer;

      addTask(makeTask({
        id: "pb-partial-boost",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-partial-boost")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(false);
      expect(task.healerReady).toBe(true);
    });

    it("transitions to travelling when both attacker and healer are live and boost-satisfied", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-both-ready",
        id: "attacker-both-ready-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-both-ready",
        id: "healer-both-ready-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-both-ready"] = attacker;
      Game.creeps["healer-both-ready"] = healer;

      addTask(makeTask({
        id: "pb-both-ready",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-both-ready")!;
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerReady).toBe(true);
      expect(task.healerReady).toBe(true);
      expect(task.attackerId).toBe("attacker-both-ready-id");
      expect(task.healerId).toBe("healer-both-ready-id");
    });

    // -------------------------------------------------------------------
    // 4. Defense mode cancellation during boosting still works
    // -------------------------------------------------------------------

    it("defense mode aborts boosting even when both creeps are boost-satisfied", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-def",
        id: "attacker-def-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-def",
        id: "healer-def-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-def"] = attacker;
      Game.creeps["healer-def"] = healer;

      addTask(makeTask({
        id: "pb-defense",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      const mod = require("@/runtime/defenseMode");
      jest.spyOn(mod, "isDefenseMode").mockReturnValue(true);
      mockReleaseBoostLabs();

      runPowerBankHarvest();

      expect(getTask("pb-defense")!.status).toBe(POWER_BANK_STATUS.ABORTED);
    });

    // -------------------------------------------------------------------
    // 5. Full lifecycle: boosting → travelling with correct creep IDs
    // -------------------------------------------------------------------

    it("full boosting-to-travelling lifecycle assigns correct creep IDs", () => {
      setupSourceRoom();
      setupTargetRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-lifecycle",
        id: "attacker-lifecycle-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-lifecycle",
        id: "healer-lifecycle-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });

      Game.creeps["attacker-lifecycle"] = attacker;
      Game.creeps["healer-lifecycle"] = healer;

      addTask(makeTask({
        id: "pb-lifecycle",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      // Tick 1: attacker not boosted → stays BOOSTING
      runPowerBankHarvest();
      expect(getTask("pb-lifecycle")!.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(getTask("pb-lifecycle")!.attackerReady).toBe(false);

      // Apply boosts to attacker
      (attacker.body[0] as any).boost = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
      (attacker.body[1] as any).boost = RESOURCE_CATALYZED_UTRIUM_ACID;

      // Tick 2: attacker now boosted → TRAVELLING
      runPowerBankHarvest();
      const task = getTask("pb-lifecycle")!;
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerId).toBe("attacker-lifecycle-id");
      expect(task.healerId).toBe("healer-lifecycle-id");
      expect(task.attackerReady).toBe(true);
      expect(task.healerReady).toBe(true);
    });

    // -------------------------------------------------------------------
    // 6. Concurrent tasks: one transitions, one does not
    // -------------------------------------------------------------------

    it("concurrent tasks: only Task A with healer absent stays blocked while Task B transitions", () => {
      setupSourceRoom();
      setupTargetRoom();
      setupSecondTargetRoom();

      // Task A: attacker alive but no healer
      const taskAConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);

      const attackerA = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-conc-a",
        id: "attacker-conc-a-id",
        roomName: SOURCE_ROOM,
        memory: { configName: taskAConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      Game.creeps["attacker-conc-a"] = attackerA;
      // No healer for Task A

      // Task B: both alive and boosted
      const taskBAttackerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM_B, "attacker", 0);
      const taskBHealerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM_B, "healer", 0);

      const attackerB = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-conc-b",
        id: "attacker-conc-b-id",
        roomName: SOURCE_ROOM,
        memory: { configName: taskBAttackerConfig, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const healerB = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-conc-b",
        id: "healer-conc-b-id",
        roomName: SOURCE_ROOM,
        memory: { configName: taskBHealerConfig, role: "powerBankHealer" },
      });

      Game.creeps["attacker-conc-b"] = attackerB;
      Game.creeps["healer-conc-b"] = healerB;

      addTask(makeTask({
        id: "pb-conc-blocked",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));
      addTask(makeTask({
        id: "pb-conc-ready",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM_B,
        tier: 8,
      }));

      runPowerBankHarvest();

      // Task A: only attacker → stays BOOSTING
      expect(getTask("pb-conc-blocked")!.status).toBe(POWER_BANK_STATUS.BOOSTING);

      // Task B: both present and boosted → TRAVELLING
      expect(getTask("pb-conc-ready")!.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(getTask("pb-conc-ready")!.attackerId).toBe("attacker-conc-b-id");
      expect(getTask("pb-conc-ready")!.healerId).toBe("healer-conc-b-id");
    });
  });

  // =====================================================================
  // Solo-First-Spawn Task Ownership Regressions (TDD RED)
  //
  // These tests guard against the bug window where the first spawned
  // combat creep can run role logic without taskId because
  // processRenewing() / processBoosting() return early when the partner
  // creep is missing.  Task 3 will implement the runtime helper that
  // assigns taskId eagerly to any solo-first-spawn creep.
  // =====================================================================

  describe("solo-first-spawn task ownership", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("assigns taskId to solo attacker in renewing when healer has not spawned yet", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-solo-renew",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;
      delete (attacker.memory as any).taskId;

      Game.creeps["attacker-solo-renew"] = attacker;
      // No healer in Game.creeps

      addTask(makeTask({
        id: "pb-solo-renew-atk",
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-solo-renew-atk")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      // The solo attacker should receive taskId so roles know it's owned
      expect((attacker.memory as any).taskId).toBe("pb-solo-renew-atk");
    });

    it("assigns taskId to solo healer in renewing when attacker has not spawned yet", () => {
      setupSourceRoom();

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-solo-renew",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
      });
      (healer as any).ticksToLive = 1500;
      delete (healer.memory as any).taskId;

      Game.creeps["healer-solo-renew"] = healer;
      // No attacker in Game.creeps

      addTask(makeTask({
        id: "pb-solo-renew-heal",
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-solo-renew-heal")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect((healer.memory as any).taskId).toBe("pb-solo-renew-heal");
    });

    it("assigns taskId to solo attacker in boosting when healer has not spawned yet", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-solo-boost",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      delete (attacker.memory as any).taskId;

      Game.creeps["attacker-solo-boost"] = attacker;
      // No healer in Game.creeps

      addTask(makeTask({
        id: "pb-solo-boost-atk",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-solo-boost-atk")!;
      // Stays boosting because only one creep exists
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      // Solo attacker should still receive taskId
      expect((attacker.memory as any).taskId).toBe("pb-solo-boost-atk");
    });

    it("does not transition to travelling when attacker is boosted but healer is not", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-partial",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      delete (attacker.memory as any).taskId;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-partial",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" },
        // Healer body is unboosted (no boost field)
        body: [
          { type: HEAL as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      delete (healer.memory as any).taskId;

      Game.creeps["attacker-partial"] = attacker;
      Game.creeps["healer-partial"] = healer;

      addTask(makeTask({
        id: "pb-partial-boost-regression",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 6, // Tier 6 healer requires XLHO2 boost
      }));

      runPowerBankHarvest();

      const task = getTask("pb-partial-boost-regression")!;
      // Healer is NOT boost-satisfied (tier 6 healer needs XLHO2, body has no boosts)
      // so the task must stay in BOOSTING — it must NOT enter TRAVELLING
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      expect(task.attackerReady).toBe(true);
      expect(task.healerReady).toBe(false);
    });

    it("does not transition to travelling when only one of two creeps is present and boosted", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-only-boosted",
        id: "attacker-only-boosted-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ALKALIDE } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      delete (attacker.memory as any).taskId;

      Game.creeps["attacker-only-boosted"] = attacker;
      // No healer — only attacker exists and is fully boosted

      addTask(makeTask({
        id: "pb-solo-boosted-block",
        status: POWER_BANK_STATUS.BOOSTING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-solo-boosted-block")!;
      // Even though attacker is fully boosted, healer is missing
      // → must NOT enter TRAVELLING
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);
      // No attackerId/healerId should be set yet
      expect(task.attackerId).toBeFalsy();
      expect(task.healerId).toBeFalsy();
    });
  });

  describe("ensureCreepTaskIds idempotency", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("does not overwrite a different existing taskId on attacker", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-diff-task",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" } as any,
      });
      (attacker.memory as any).taskId = "other-task-id";
      (attacker as any).ticksToLive = 1500;

      Game.creeps["attacker-diff-task"] = attacker;

      addTask(makeTask({
        id: "pb-current-task",
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-current-task")!;
      expect(task.status).toBe(POWER_BANK_STATUS.RENEWING);
      expect((attacker.memory as any).taskId).toBe("other-task-id");
    });

    it("does not overwrite a different existing taskId on healer", () => {
      setupSourceRoom();

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-diff-task",
        roomName: SOURCE_ROOM,
        memory: { configName: healerConfigName, role: "powerBankHealer" } as any,
      });
      (healer.memory as any).taskId = "other-task-id";
      (healer as any).ticksToLive = 1500;

      Game.creeps["healer-diff-task"] = healer;

      addTask(makeTask({
        id: "pb-current-task-heal",
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-current-task-heal")!;
      expect(task.status).toBe(POWER_BANK_STATUS.RENEWING);
      expect((healer.memory as any).taskId).toBe("other-task-id");
    });

    it("idempotently reassigns matching taskId without side effects", () => {
      setupSourceRoom();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-same-task",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" } as any,
      });
      (attacker.memory as any).taskId = "pb-idempotent";
      (attacker as any).ticksToLive = 1500;

      Game.creeps["attacker-same-task"] = attacker;

      addTask(makeTask({
        id: "pb-idempotent",
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        routeDistance: 5,
      }));

      runPowerBankHarvest();

      expect((attacker.memory as any).taskId).toBe("pb-idempotent");
    });
  });

  describe("terminal cleanup neutralizes task-bound creeps", () => {
    it("mock powerbank creeps do not fabricate taskId by default", () => {
      const creep = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-contract",
        memory: { configName: "contract-config", role: "powerBankAttacker" },
      });

      expect((creep.memory as PowerBankTestMemory).taskId).toBeUndefined();
    });

    it("spawned powerbank creeps start with spawn memory only and no taskId", () => {
      Object.assign(global, { StructureSpawn: function StructureSpawn() {} });
      mountSpawn();
      const configName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      getCreepConfigService().add(configName, "powerBankAttacker", TARGET_ROOM, "");

      const room = { name: SOURCE_ROOM } as Room;
      const spawn = {
        name: `${SOURCE_ROOM}-spawn1`,
        room,
        spawnCreep: jest.fn(() => OK),
      } as unknown as StructureSpawn;

      (global as StructureSpawnTestGlobal).StructureSpawn.prototype.mainSpawn.call(spawn, configName);

      expect(spawn.spawnCreep).toHaveBeenCalledWith(
        expect.any(Array),
        `powerBankAttacker-${Game.time}`,
        {
          memory: {
            role: "powerBankAttacker",
            roleArgs: [TARGET_ROOM, ""],
            configName,
            ready: false,
            working: false,
          },
        },
      );
      expect((spawn.spawnCreep as jest.Mock).mock.calls[0][2].memory.taskId).toBeUndefined();
    });

    it("clears taskId and working on attacker/healer when task enters terminal state", () => {
      mockReleaseBoostLabs();

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-cleanup",
        id: "attacker-cleanup-id",
        roomName: SOURCE_ROOM,
        memory: { configName: "test", role: "powerBankAttacker" } as any,
      });
      (attacker.memory as any).taskId = "pb-cleanup-test";
      (attacker.memory as any).working = true;

      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-cleanup",
        id: "healer-cleanup-id",
        roomName: SOURCE_ROOM,
        memory: { configName: "test", role: "powerBankHealer" } as any,
      });
      (healer.memory as any).taskId = "pb-cleanup-test";
      (healer.memory as any).working = true;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-cleanup-id") return attacker;
        if (id === "healer-cleanup-id") return healer;
        return null;
      }) as any;

      addTask(makeTask({
        id: "pb-cleanup-test",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-cleanup-id",
        healerId: "healer-cleanup-id",
        boostLabs: ["lab-0"],
        failReason: "test_fail",
        terminalTick: 100,
      }));

      runPowerBankHarvest();

      // Creeps should be neutralized
      expect((attacker.memory as any).taskId).toBeUndefined();
      expect((attacker.memory as any).working).toBe(false);
      expect((healer.memory as any).taskId).toBeUndefined();
      expect((healer.memory as any).working).toBe(false);
    });

    it("is a no-op when attackerId/healerId are not set", () => {
      mockReleaseBoostLabs();

      addTask(makeTask({
        id: "pb-no-ids",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        failReason: "early_fail",
        terminalTick: 100,
      }));

      // Should not throw
      runPowerBankHarvest();

      expect(getTask("pb-no-ids")).toBeDefined();
    });

    it("neutralizes live powerbank creeps by configName when terminal task never recorded ids", () => {
      mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(attackerName, "powerBankAttacker", TARGET_ROOM, "");
      configStore.add(healerName, "powerBankHealer", TARGET_ROOM, "");

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-orphan",
        id: "attacker-orphan-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerName, role: "powerBankAttacker", working: true } as any,
      });
      const healer = createMockPowerBankCreep("powerBankHealer", {
        name: "healer-orphan",
        id: "healer-orphan-id",
        roomName: SOURCE_ROOM,
        memory: { configName: healerName, role: "powerBankHealer", working: true } as any,
      });
      Game.creeps[attacker.name] = attacker;
      Game.creeps[healer.name] = healer;

      addTask(makeTask({
        id: "pb-orphan-config",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        failReason: "boost_failed_before_ids",
        terminalTick: 100,
      }));

      runPowerBankHarvest();

      expect((attacker.memory as PowerBankTestMemory).taskId).toBeUndefined();
      expect(attacker.memory.working).toBe(false);
      expect((healer.memory as PowerBankTestMemory).taskId).toBeUndefined();
      expect(healer.memory.working).toBe(false);
    });

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

    it("still releases boost labs and cleans up configs alongside creep neutralization", () => {
      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const attackerName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      configStore.add(attackerName, "powerBankAttacker", TARGET_ROOM);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-regression",
        id: "attacker-regression-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerName, role: "powerBankAttacker" } as any,
      });
      (attacker.memory as any).taskId = "pb-regression";
      (attacker.memory as any).working = true;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-regression-id") return attacker;
        return null;
      }) as any;

      addTask(makeTask({
        id: "pb-regression",
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-regression-id",
        boostLabs: ["lab-r0", "lab-r1"],
        failReason: "test",
        terminalTick: 100,
      }));

      runPowerBankHarvest();

      // Boost labs released
      expect(releaseSpy).toHaveBeenCalledWith("pb-regression", SOURCE_ROOM);

      // Creep neutralized
      expect((attacker.memory as any).taskId).toBeUndefined();
      expect((attacker.memory as any).working).toBe(false);
    });
  });

  describe("multi-spawn queue cleanup", () => {
    it("removes powerbank prefix entries from all source-room spawns and preserves unrelated entries", () => {
      setupSourceRoom({ spawnCount: 2 });
      mockReleaseBoostLabs();

      const attackerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      const haulerConfig = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "hauler", 0);
      const unrelatedConfig = `${SOURCE_ROOM}:worker:0`;

      const configStore = getCreepConfigService();
      configStore.add(attackerConfig, "powerBankAttacker", TARGET_ROOM);
      configStore.add(healerConfig, "powerBankHealer", TARGET_ROOM);
      configStore.add(haulerConfig, "powerBankHauler", TARGET_ROOM);

      const spawnA = Game.spawns[`${SOURCE_ROOM}-spawn1`];
      const spawnB = Game.spawns[`${SOURCE_ROOM}-spawn2`];

      spawnA.memory.spawnList = [attackerConfig, unrelatedConfig];
      spawnB.memory.spawnList = [healerConfig, haulerConfig, `${SOURCE_ROOM}:carrier:0`];

      addTask(makeTask({
        status: POWER_BANK_STATUS.FAILED,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        failReason: "test",
        terminalTick: Game.time - 200,
      }));

      runPowerBankHarvest();

      expect(spawnA.memory.spawnList).not.toContain(attackerConfig);
      expect(spawnA.memory.spawnList).not.toContain(healerConfig);
      expect(spawnA.memory.spawnList).not.toContain(haulerConfig);
      expect(spawnB.memory.spawnList).not.toContain(attackerConfig);
      expect(spawnB.memory.spawnList).not.toContain(healerConfig);
      expect(spawnB.memory.spawnList).not.toContain(haulerConfig);
      expect(spawnA.memory.spawnList).toContain(unrelatedConfig);
      expect(spawnB.memory.spawnList).toContain(`${SOURCE_ROOM}:carrier:0`);
    });
  });
});

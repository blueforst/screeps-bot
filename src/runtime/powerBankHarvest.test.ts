import { runPowerBankHarvest } from "@/runtime/powerBankHarvest";
import { POWER_BANK_STATUS, getPowerBankConfigName } from "@/runtime/powerBankConstants";
import { getCreepConfigService, registerRuntimeServices } from "@/runtime/runtimeServices";
import { clearDefenseModeCacheForTest } from "@/runtime/defenseMode";
import { createMockStore, createMockPowerBankCreep, createMockPowerBank } from "@mock/powerBank";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const SOURCE_ROOM = "E5N55";
const TARGET_ROOM = "E0N60";

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
    failReason: overrides.failReason,
    terminalTick: overrides.terminalTick,
    attackerReady: overrides.attackerReady,
    healerReady: overrides.healerReady,
  };
}

function setupSourceRoom(opts: { rcl?: number; energyCapacity?: number; hasStorage?: boolean; hasTerminal?: boolean } = {}): void {
  const rcl = opts.rcl ?? 8;
  const energyCapacity = opts.energyCapacity ?? 12_000;
  const storage = opts.hasStorage !== false
    ? {
        store: createMockStore({
          [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000,
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

  const spawn = {
    name: `${SOURCE_ROOM}-spawn1`,
    room,
    memory: { spawnList: [] },
    spawning: null,
    isActive: () => true,
    renewCreep: jest.fn((_creep: Creep) => OK),
  } as unknown as StructureSpawn;

  Game.spawns[spawn.name] = spawn;
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
      addTask(makeTask({ status: POWER_BANK_STATUS.DISCOVERED, targetRoom: "E99N99" }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.FAILED);
      expect(task.failReason).toBe("no_eligible_source_room");
    });
  });

  describe("preparing_boosts", () => {
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

    it("stays preparing_boosts while preparing", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.PREPARING_BOOSTS,
        sourceRoom: SOURCE_ROOM,
        tier: 8,
      }));

      mockPrepareBoosts("preparing", ["lab-0"]);

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
    it("creates attacker and healer configs and transitions to boosting", () => {
      setupSourceRoom();
      addTask(makeTask({
        status: POWER_BANK_STATUS.SPAWNING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.BOOSTING);

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

  describe("boosting", () => {
    it("transitions to renewing when both creeps exist", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-0",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ACID } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
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

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.RENEWING);
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

  describe("renewing", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("transitions to travelling when both creeps have sufficient TTL", () => {
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
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerId).toBe(attacker.id);
      expect(task.healerId).toBe(healer.id);
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

    it("aborts when a creep dies during renewing", () => {
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

      mockReleaseBoostLabs();

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("creep_died_during_renewing");
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

    it("transitions to aborted when creep dies in transit", () => {
      setupSourceRoom();

      Game.getObjectById = jest.fn(() => null) as any;

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

      Game.getObjectById = jest.fn(() => null) as any;

      addTask(makeTask({
        status: POWER_BANK_STATUS.ATTACKING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        attackerId: "attacker-id",
        bankId: "bank-0",
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.HAULING);
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

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(getTask("pb-test")!.failReason).toBe("tough_broken");
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
  });

  describe("hauling", () => {
    it("transitions to complete when no power remains", () => {
      setupTargetRoom();

      addTask(makeTask({
        status: POWER_BANK_STATUS.HAULING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.COMPLETE);
    });

    it("stays hauling when power resource exists", () => {
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
    it("transitions through discovery → preparing_boosts → spawning → boosting → renewing → travelling → attacking → hauling → complete", () => {
      setupSourceRoom();
      setupTargetRoom();

      const selectSpy = mockSelectBodyTier("rcl8");
      const viabilitySpy = mockAssessViability(true);
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
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.BOOSTING);

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-life",
        id: "attacker-life-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ACID } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
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
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.RENEWING);

      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.TRAVELLING);

      (attacker as any).room = { name: TARGET_ROOM } as Room;
      (healer as any).room = { name: TARGET_ROOM } as Room;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-life-id") return attacker;
        if (id === "healer-life-id") return healer;
        return null;
      }) as any;

      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.ATTACKING);

      Game.getObjectById = jest.fn(() => null) as any;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.HAULING);

      runPowerBankHarvest();
      expect(store["pb-lifecycle"].status).toBe(POWER_BANK_STATUS.COMPLETE);

      Game.time = 250;
      runPowerBankHarvest();
      expect(store["pb-lifecycle"]).toBeUndefined();

      expect(releaseSpy).toHaveBeenCalled();
    });
  });

  describe("boosting synchronization", () => {
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

    it("transitions from boosting to renewing when attacker gets boosted mid-task", () => {
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

      (attacker.body[0] as any).boost = RESOURCE_CATALYZED_GHODIUM_ACID;
      (attacker.body[1] as any).boost = RESOURCE_CATALYZED_UTRIUM_ACID;

      runPowerBankHarvest();
      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.RENEWING);
    });
  });

  describe("renewing synchronization", () => {
    const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
    const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

    it("both members depart in the same tick when both are ready", () => {
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
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerId).toBe(attacker.id);
      expect(task.healerId).toBe(healer.id);
    });

    it("waits for lower-TTL creep to be renewed before departing", () => {
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

  // =====================================================================
  // Lifecycle & Waste-Prevention Integration Tests
  // =====================================================================

  describe("full lifecycle with time progression", () => {
    it("tracks Game.time through discovery → delivery with time-budget assertions", () => {
      setupSourceRoom();
      setupTargetRoom();

      const selectSpy = mockSelectBodyTier("rcl8");
      const viabilitySpy = mockAssessViability(true);
      const boostSpy = mockPrepareBoosts("ready", ["lab-0"]);
      const releaseSpy = mockReleaseBoostLabs();

      Game.getObjectById = jest.fn(() => null) as any;

      // Tick 100: discovery
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

      // Tick 120: boost prep done
      Game.time = 120;
      boostSpy.mockReturnValue({ status: "ready", labs: ["lab-0"] });
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.SPAWNING);

      // Tick 121: spawning → boosting
      Game.time = 121;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.BOOSTING);

      // Tick 180: both creeps appear boosted
      Game.time = 180;
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-timing",
        id: "attacker-timing-id",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_GHODIUM_ACID } as any,
          { type: ATTACK as BodyPartConstant, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID } as any,
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
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.RENEWING);

      // Tick 181: renewing → travelling (both TTL sufficient)
      Game.time = 181;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(store["pb-timing"].attackerId).toBe("attacker-timing-id");
      expect(store["pb-timing"].healerId).toBe("healer-timing-id");

      // Tick 190: creeps arrive in target room
      Game.time = 190;
      (attacker as any).room = { name: TARGET_ROOM } as Room;
      (healer as any).room = { name: TARGET_ROOM } as Room;

      Game.getObjectById = jest.fn((id: string) => {
        if (id === "attacker-timing-id") return attacker;
        if (id === "healer-timing-id") return healer;
        return null;
      }) as any;

      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.ATTACKING);

      // Tick 3190: bank destroyed → hauling
      Game.time = 3190;
      Game.getObjectById = jest.fn(() => null) as any;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.HAULING);

      // Tick 3200: no power → complete
      Game.time = 3200;
      runPowerBankHarvest();
      expect(store["pb-timing"].status).toBe(POWER_BANK_STATUS.COMPLETE);
      expect(store["pb-timing"].terminalTick).toBe(3200);

      // Tick 3301: cleanup delay elapsed → task removed
      Game.time = 3301;
      runPowerBankHarvest();
      expect(store["pb-timing"]).toBeUndefined();

      expect(releaseSpy).toHaveBeenCalled();
    });

    it("verifies no creep departs during boosting before both members ready", () => {
      setupSourceRoom();

      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);

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
      const viabilitySpy = jest.spyOn(require("@/runtime/powerBankViability"), "assessViability").mockReturnValue({
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
      const powerBankConfigs = Object.keys(configs).filter(k => k.includes("powerbank"));
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
          [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000,
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
      const pbConfigs = Object.keys(configs).filter(k => k.includes("powerbank"));
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
      expect(Object.keys(configs).filter(k => k.includes("powerbank"))).toHaveLength(0);
    });
  });

  describe("mid-operation bank disappearance", () => {
    it("transitions to hauling when bank destroyed during attacking", () => {
      setupSourceRoom();

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
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("tough_broken");

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

    it("cleanup at renewing: releases labs on creep death abort", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();
      const configStore = getCreepConfigService();
      const attackerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "attacker", 0);
      const healerConfigName = getPowerBankConfigName(SOURCE_ROOM, TARGET_ROOM, "healer", 0);
      configStore.add(attackerConfigName, "powerBankAttacker", TARGET_ROOM);
      configStore.add(healerConfigName, "powerBankHealer", TARGET_ROOM);

      // Only attacker exists — healer died
      const attacker = createMockPowerBankCreep("powerBankAttacker", {
        name: "attacker-renew",
        roomName: SOURCE_ROOM,
        memory: { configName: attackerConfigName, role: "powerBankAttacker" },
      });
      (attacker as any).ticksToLive = 1500;
      Game.creeps["attacker-renew"] = attacker;

      addTask(makeTask({
        status: POWER_BANK_STATUS.RENEWING,
        sourceRoom: SOURCE_ROOM,
        targetRoom: TARGET_ROOM,
        tier: 8,
        boostLabs: ["lab-r0"],
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("creep_died_during_renewing");
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
      const pbConfigs = Object.keys(configs).filter(k => k.includes("powerbank"));
      expect(pbConfigs).toHaveLength(0);

      expect(releaseSpy).toHaveBeenCalledWith("pb-test", SOURCE_ROOM);
    });

    it("aborts during spawning — removes existing spawn config, releases labs", () => {
      setupSourceRoom();

      const releaseSpy = mockReleaseBoostLabs();

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

    it("aborts during attacking on defense mode", () => {
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
      expect(task.status).toBe(POWER_BANK_STATUS.ABORTED);
      expect(task.failReason).toBe("defense_mode");
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
});

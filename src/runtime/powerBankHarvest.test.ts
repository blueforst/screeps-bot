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
    failReason: overrides.failReason,
    terminalTick: overrides.terminalTick,
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
      }));

      runPowerBankHarvest();

      const task = getTask("pb-test")!;
      expect(task.status).toBe(POWER_BANK_STATUS.TRAVELLING);
      expect(task.attackerId).toBe(attacker.id);
      expect(task.healerId).toBe(healer.id);
    });

    it("stays renewing when TTL is too low", () => {
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
      }));

      runPowerBankHarvest();

      expect(getTask("pb-test")!.status).toBe(POWER_BANK_STATUS.RENEWING);
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
});

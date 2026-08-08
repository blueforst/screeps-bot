jest.mock("@/runtime/powerBankBoost", () => ({
  prepareBoosts: jest.fn(() => ({ status: "preparing", labs: [] })),
  releaseBoostLabs: jest.fn(),
}));

import { HUB_UPGRADER_BODY, getUpgraderStatus, runHubUpgradeControl, startUpgrader, stopUpgrader } from "@/runtime/hubUpgradeControl";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";
import {
  RCL8_UPGRADER_MAINTENANCE_BODY,
  RCL8_UPGRADER_RECOVERY_START_TICKS,
  RCL8_UPGRADER_RECOVERY_STOP_TICKS,
} from "@/runtime/upgraderPolicy";

const mockedPrepareBoosts = prepareBoosts as jest.MockedFunction<typeof prepareBoosts>;
const mockedReleaseBoostLabs = releaseBoostLabs as jest.MockedFunction<typeof releaseBoostLabs>;

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

interface LocalXgh2o {
  storage?: number;
  terminal?: number;
  labs?: number[];
}

function createResourceStructure(
  structureType: StructureConstant,
  xgh2o: number,
): StructureStorage | StructureTerminal | StructureLab {
  return {
    structureType,
    isActive: () => true,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_CATALYZED_GHODIUM_ACID ? xgh2o : 0,
    },
  } as unknown as StructureStorage | StructureTerminal | StructureLab;
}

function createUpgraderRoom(
  level = 7,
  my = true,
  name = "E4N58",
  localXgh2o: LocalXgh2o = { storage: 450, labs: [0] },
  energyCapacityAvailable = 5600,
  ticksToDowngrade = level === 8 ? 200_000 : 150_000,
): Room {
  const storage = localXgh2o.storage === undefined
    ? undefined
    : createResourceStructure(STRUCTURE_STORAGE, localXgh2o.storage) as StructureStorage;
  const terminal = localXgh2o.terminal === undefined
    ? undefined
    : createResourceStructure(STRUCTURE_TERMINAL, localXgh2o.terminal) as StructureTerminal;
  const labs = (localXgh2o.labs || []).map((amount) =>
    createResourceStructure(STRUCTURE_LAB, amount) as StructureLab
  );
  return {
    name,
    controller: { level, my, ticksToDowngrade } as StructureController,
    energyCapacityAvailable,
    storage,
    terminal,
    find: jest.fn((type: FindConstant) => type === FIND_MY_STRUCTURES ? labs : []),
  } as unknown as Room;
}

function createUpgrader(name: string, configName: string, boostedWorkParts = 0): Creep {
  return {
    name,
    memory: { role: "upgrader", configName },
    body: Array.from({ length: 15 }, (_, index) => ({
      type: WORK,
      hits: 100,
      boost: index < boostedWorkParts ? RESOURCE_CATALYZED_GHODIUM_ACID : undefined,
    })),
    suicide: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("runHubUpgradeControl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Memory.cfg = { hub: { enabled: true, hubRoomName: "E4N58" } } as Memory["cfg"];
    Memory.data = { creepConfigs: {} };
    Memory.runtime = {};
    Memory.creeps = {};
    Game.creeps = {};
    Game.spawns = {};
    delete Game.flags.RESERVE_E4N58;
    Game.rooms.E4N58 = createUpgraderRoom();
    delete Game.rooms.W1N57;
    delete Game.rooms.W1N58;
    mockedPrepareBoosts.mockReturnValue({ status: "preparing", labs: [] });
  });

  it("automatically maintains one upgrader in every owned room below RCL8", () => {
    Game.rooms.W1N57 = createUpgraderRoom(6, true, "W1N57", {}, 2300);
    Game.rooms.W1N58 = createUpgraderRoom(8, true, "W1N58");

    runHubUpgradeControl();

    expect(Object.keys(Memory.data?.manualUpgraders || {})).toEqual(["E4N58", "W1N57"]);
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.role).toBe("upgrader");
    expect(Memory.data?.creepConfigs?.["W1N57:upgrader:0"]?.role).toBe("upgrader");
    expect(Memory.data?.creepConfigs?.["W1N58:upgrader:0"]).toBeUndefined();
  });

  it("starts one fixed-body manual upgrader for an owned RCL7 room", () => {
    expect(startUpgrader("E4N58")).toMatchObject({ ok: true, active: true, roomName: "E4N58" });

    expect(Memory.data?.manualUpgraders?.E4N58).toMatchObject({ createdAt: Game.time, updatedAt: Game.time });
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toEqual({
      role: "upgrader",
      args: ["E4N58", "upgrader:E4N58"],
      roomName: "E4N58",
      body: HUB_UPGRADER_BODY,
    });
  });

  it("keeps the fixed body in an owned RCL6 room", () => {
    Game.rooms.E4N58 = createUpgraderRoom(6, true, "E4N58", { storage: 450 }, 2300);

    runHubUpgradeControl();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.body).toEqual(HUB_UPGRADER_BODY);
  });

  it("scales the body down for an owned RCL5 room", () => {
    Game.rooms.E4N58 = createUpgraderRoom(5, true, "E4N58", {}, 1800);

    runHubUpgradeControl();

    const body = Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.body || [];
    expect(body).toHaveLength(24);
    expect(body.filter((part) => part === WORK)).toHaveLength(12);
    expect(body.reduce((sum, part) => sum + BODYPART_COST[part], 0)).toBe(1800);
  });

  it("does not start an upgrader at RCL8", () => {
    Game.rooms.E4N58 = createUpgraderRoom(8);

    runHubUpgradeControl();

    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeUndefined();
    expect(startUpgrader("E4N58")).toBe("ERR_UPGRADER_NOT_REQUIRED_AT_RCL8:E4N58");
  });

  it("does not let a fresh manual task bypass the RCL8 recovery start threshold", () => {
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      {},
      5600,
      RCL8_UPGRADER_RECOVERY_START_TICKS + 1,
    );

    expect(startUpgrader("E4N58")).toBe("ERR_UPGRADER_NOT_REQUIRED_AT_RCL8:E4N58");
    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeUndefined();
  });

  it("allows a fresh manual RCL8 maintenance task exactly at the recovery start threshold", () => {
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      {},
      5600,
      RCL8_UPGRADER_RECOVERY_START_TICKS,
    );

    expect(startUpgrader("E4N58")).toMatchObject({ ok: true, active: true, boosted: false });
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.body).toEqual(RCL8_UPGRADER_MAINTENANCE_BODY);
  });

  it("starts a minimal unboosted RCL8 maintenance upgrader at the recovery threshold", () => {
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      { storage: 1000, labs: [1000] },
      5600,
      RCL8_UPGRADER_RECOVERY_START_TICKS,
    );

    runHubUpgradeControl();

    expect(Memory.data?.manualUpgraders?.E4N58).toBeDefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toEqual({
      role: "upgrader",
      args: ["E4N58"],
      roomName: "E4N58",
      body: RCL8_UPGRADER_MAINTENANCE_BODY,
    });
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("starts RCL8 maintenance independently of RESERVE worker suppression", () => {
    Game.flags.RESERVE_E4N58 = { name: "RESERVE_E4N58" } as Flag;
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      {},
      5600,
      RCL8_UPGRADER_RECOVERY_START_TICKS,
    );

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.body).toEqual(RCL8_UPGRADER_MAINTENANCE_BODY);
  });

  it("releases an orphan legacy boost task while keeping active RCL8 maintenance", () => {
    Memory.runtime = {
      powerBankBoost: {
        "hubUpgrade:E4N58": {},
      },
    } as unknown as Memory["runtime"];
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      {},
      5600,
      RCL8_UPGRADER_RECOVERY_START_TICKS,
    );

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeDefined();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("keeps RCL8 maintenance through the hysteresis band and cleans it at the stop threshold", () => {
    Game.rooms.E4N58 = createUpgraderRoom(
      8,
      true,
      "E4N58",
      {},
      5600,
      RCL8_UPGRADER_RECOVERY_START_TICKS,
    );
    runHubUpgradeControl();
    const createdAt = Memory.data?.manualUpgraders?.E4N58?.createdAt;

    Game.rooms.E4N58.controller!.ticksToDowngrade = RCL8_UPGRADER_RECOVERY_START_TICKS + 1;
    runHubUpgradeControl();
    expect(Memory.data?.manualUpgraders?.E4N58?.createdAt).toBe(createdAt);
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeDefined();

    Game.rooms.E4N58.controller!.ticksToDowngrade = RCL8_UPGRADER_RECOVERY_STOP_TICKS;
    runHubUpgradeControl();
    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeUndefined();
  });

  it("rejects a room that is not owned", () => {
    Game.rooms.E4N58 = createUpgraderRoom(7, false);

    expect(startUpgrader("E4N58")).toBe("ERR_UPGRADER_REQUIRES_OWNED_ROOM:E4N58");
    expect(Memory.data?.manualUpgraders).toBeUndefined();
  });

  it("runs unboosted and releases boost prep when local XGH2O is insufficient", () => {
    Game.rooms.E4N58 = createUpgraderRoom(7, true, "E4N58", { storage: 449 });

    startUpgrader("E4N58");

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
  });

  it("runs unboosted when the room has enough XGH2O but no lab", () => {
    Game.rooms.E4N58 = createUpgraderRoom(5, true, "E4N58", { storage: 1000 }, 1800);

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
  });

  it("runs unboosted when only an inactive lab remains after an RCL downgrade", () => {
    const room = createUpgraderRoom(5, true, "E4N58", { storage: 1000 }, 1800);
    const inactiveLab = createResourceStructure(STRUCTURE_LAB, 1000) as StructureLab;
    inactiveLab.isActive = jest.fn(() => false);
    room.find = jest.fn((type: FindConstant, options?: { filter?: (structure: AnyStructure) => boolean }) => {
      if (type !== FIND_MY_STRUCTURES) return [];
      const filter = options?.filter;
      return !filter || filter(inactiveLab) ? [inactiveLab] : [];
    }) as Room["find"];
    Game.rooms.E4N58 = room;

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
  });

  it("uses local storage, terminal, and labs to cover the full boost requirement", () => {
    Game.rooms.E4N58 = createUpgraderRoom(7, true, "E4N58", {
      storage: 200,
      terminal: 100,
      labs: [150],
    });

    startUpgrader("E4N58");

    expect(mockedPrepareBoosts).toHaveBeenCalledWith(
      "upgrader:E4N58",
      "E4N58",
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]),
      { requireLabEnergy: true },
    );
  });

  it("automatically cleans the task, queue, spawn, creep, and boost at RCL8", () => {
    startUpgrader("E4N58");
    const configName = "E4N58:upgrader:0";
    const creep = createUpgrader("upgrader0", configName);
    Game.creeps = { upgrader0: creep };
    const cancel = jest.fn(() => OK);
    Game.spawns.Spawn1 = {
      memory: { spawnList: [configName, "E4N58:worker:0"] },
      spawning: { name: "upgrader-spawning", cancel } as unknown as Spawning,
    } as StructureSpawn;
    Memory.creeps = { "upgrader-spawning": { configName } as CreepMemory };
    Game.rooms.E4N58 = createUpgraderRoom(8);

    runHubUpgradeControl();

    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(["E4N58:worker:0"]);
    expect(cancel).toHaveBeenCalled();
    expect(creep.suicide).toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
  });

  it("automatically cleans the task, queue, spawn, creep, and boost after ownership is lost", () => {
    startUpgrader("E4N58");
    const configName = "E4N58:upgrader:0";
    const creep = createUpgrader("upgrader0", configName);
    Game.creeps = { upgrader0: creep };
    const cancel = jest.fn(() => OK);
    Game.spawns.Spawn1 = {
      memory: { spawnList: [configName, "E4N58:worker:0"] },
      spawning: { name: "upgrader-spawning", cancel } as unknown as Spawning,
    } as StructureSpawn;
    Memory.creeps = { "upgrader-spawning": { configName } as CreepMemory };
    Game.rooms.E4N58 = createUpgraderRoom(7, false);

    runHubUpgradeControl();

    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[configName]).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(["E4N58:worker:0"]);
    expect(cancel).toHaveBeenCalled();
    expect(creep.suicide).toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
  });

  it("does not stop the required upgrader in an owned room", () => {
    startUpgrader("E4N58");

    expect(stopUpgrader("E4N58")).toBe("ERR_UPGRADER_REQUIRED_FOR_OWNED_ROOM:E4N58");
    expect(Memory.data?.manualUpgraders?.E4N58).toBeDefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeDefined();
  });

  it("cleans legacy hubUpgrader configs during migration", () => {
    Memory.data!.creepConfigs!["E4N58:hubUpgrader:0"] = {
      role: "hubUpgrader",
      args: ["E4N58", "hubUpgrade:E4N58"],
      roomName: "E4N58",
      body: [...HUB_UPGRADER_BODY],
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toBeUndefined();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("cleans a nonstandard upgrader config from queue and active spawning", () => {
    const legacyConfig = "legacy-upgrade-job";
    Memory.data!.creepConfigs![legacyConfig] = {
      role: "upgrader",
      args: ["E4N58"],
      roomName: "E4N58",
      body: [WORK, CARRY, MOVE],
    };
    const cancel = jest.fn(() => OK);
    Game.spawns.Spawn1 = {
      memory: { spawnList: [legacyConfig, "E4N58:worker:0"] },
      spawning: { name: "legacy-upgrader-spawning", cancel } as unknown as Spawning,
    } as StructureSpawn;
    Memory.creeps = {
      "legacy-upgrader-spawning": { configName: legacyConfig } as CreepMemory,
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.[legacyConfig]).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(["E4N58:worker:0"]);
    expect(cancel).toHaveBeenCalled();
  });

  it("reports the selected boost state", () => {
    startUpgrader("E4N58");

    expect(getUpgraderStatus("E4N58")).toMatchObject({
      ok: true,
      active: true,
      configName: "E4N58:upgrader:0",
      boosted: true,
    });
  });
});

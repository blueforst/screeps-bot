jest.mock("@/runtime/powerBankBoost", () => ({
  prepareBoosts: jest.fn(() => ({ status: "preparing", labs: [] })),
  releaseBoostLabs: jest.fn(),
}));

import { HUB_UPGRADER_BODY, getUpgraderStatus, runHubUpgradeControl, startUpgrader, stopUpgrader } from "@/runtime/hubUpgradeControl";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";

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
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_CATALYZED_GHODIUM_ACID ? xgh2o : 0,
    },
  } as unknown as StructureStorage | StructureTerminal | StructureLab;
}

function createUpgraderRoom(
  level = 7,
  my = true,
  name = "E4N58",
  localXgh2o: LocalXgh2o = { storage: 450 },
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
    controller: { level, my } as StructureController,
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
    Game.rooms.E4N58 = createUpgraderRoom();
    delete Game.rooms.W1N57;
    mockedPrepareBoosts.mockReturnValue({ status: "preparing", labs: [] });
  });

  it("does not create an upgrader from hub configuration alone", () => {
    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs).toEqual({});
    expect(Memory.data?.manualUpgraders).toEqual({});
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

  it("rejects a room that is not an owned RCL7 room", () => {
    Game.rooms.E4N58 = createUpgraderRoom(8);

    expect(startUpgrader("E4N58")).toBe("ERR_UPGRADER_REQUIRES_OWNED_RCL7_ROOM:E4N58");
    expect(Memory.data?.manualUpgraders).toBeUndefined();
  });

  it("runs unboosted and releases boost prep when local XGH2O is insufficient", () => {
    Game.rooms.E4N58 = createUpgraderRoom(7, true, "E4N58", { storage: 449 });

    startUpgrader("E4N58");

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
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

  it("stops a manual task immediately", () => {
    startUpgrader("E4N58");

    expect(stopUpgrader("E4N58")).toMatchObject({ ok: true, active: false });
    expect(Memory.data?.manualUpgraders?.E4N58).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]).toBeUndefined();
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

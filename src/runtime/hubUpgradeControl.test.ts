jest.mock("@/runtime/powerBankBoost", () => ({
  prepareBoosts: jest.fn(() => ({ status: "preparing", labs: [] })),
  releaseBoostLabs: jest.fn(),
}));

import { HUB_UPGRADER_BODY, runHubUpgradeControl } from "@/runtime/hubUpgradeControl";
import { prepareBoosts, releaseBoostLabs } from "@/runtime/powerBankBoost";

const mockedPrepareBoosts = prepareBoosts as jest.MockedFunction<typeof prepareBoosts>;
const mockedReleaseBoostLabs = releaseBoostLabs as jest.MockedFunction<typeof releaseBoostLabs>;

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

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

function createHubRoom(
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

function createUpgrader(
  name: string,
  configName: string,
  boostedWorkParts: number,
): Creep {
  return {
    name,
    memory: {
      role: "hubUpgrader",
      configName,
    },
    body: Array.from({ length: 15 }, (_, index) => ({
      type: WORK,
      hits: 100,
      boost: index < boostedWorkParts ? RESOURCE_CATALYZED_GHODIUM_ACID : undefined,
    })),
    suicide: jest.fn(() => OK),
    room: { name: "E4N58" } as Room,
  } as unknown as Creep;
}

describe("runHubUpgradeControl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "E4N58",
      },
    };
    Memory.data = { creepConfigs: {} };
    Memory.runtime = {};
    Game.creeps = {};
    Game.spawns = {};
    Game.rooms.E4N58 = createHubRoom();
    delete Game.rooms.W1N57;
    mockedPrepareBoosts.mockReturnValue({ status: "preparing", labs: [] });
  });

  it("creates exactly one fixed-body upgrader config for an owned RCL7 hub", () => {
    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toEqual({
      role: "hubUpgrader",
      args: ["E4N58", "hubUpgrade:E4N58"],
      roomName: "E4N58",
      body: HUB_UPGRADER_BODY,
    });
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:1"]).toBeUndefined();
    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(1);
  });

  it("creates one upgrader for each configured extra RCL7 room", () => {
    (Memory.cfg!.hub as any).upgraderRoomNames = ["W1N57"];
    Game.rooms.W1N57 = createHubRoom(7, true, "W1N57");

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toBeDefined();
    expect(Memory.data?.creepConfigs?.["W1N57:hubUpgrader:0"]).toEqual({
      role: "hubUpgrader",
      args: ["W1N57", "hubUpgrade:W1N57"],
      roomName: "W1N57",
      body: HUB_UPGRADER_BODY,
    });
    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(2);
    expect(mockedPrepareBoosts).toHaveBeenCalledWith(
      "hubUpgrade:W1N57",
      "W1N57",
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]),
      { requireLabEnergy: true },
    );
  });

  it("does not duplicate the primary hub when it is also listed as an extra room", () => {
    (Memory.cfg!.hub as any).upgraderRoomNames = ["E4N58", "E4N58"];

    runHubUpgradeControl();

    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toEqual([
      "E4N58:hubUpgrader:0",
    ]);
  });

  it("cleans an extra upgrader when its room reaches RCL8", () => {
    (Memory.cfg!.hub as any).upgraderRoomNames = ["W1N57"];
    Game.rooms.W1N57 = createHubRoom(8, true, "W1N57");
    Memory.data!.creepConfigs!["W1N57:hubUpgrader:0"] = {
      role: "hubUpgrader",
      args: ["W1N57", "hubUpgrade:W1N57"],
      roomName: "W1N57",
      body: [...HUB_UPGRADER_BODY],
    };
    Memory.runtime!.powerBankBoost = {
      "hubUpgrade:W1N57": {
        taskId: "hubUpgrade:W1N57",
        sourceRoomName: "W1N57",
        labs: {},
      },
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["W1N57:hubUpgrader:0"]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toBeDefined();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:W1N57", "W1N57");
  });

  it("removes a noncanonical third upgrader config in the active hub", () => {
    Memory.data!.creepConfigs!["E4N58:hubUpgrader:legacy"] = {
      role: "hubUpgrader",
      args: ["E4N58", "hubUpgrade:E4N58"],
      roomName: "E4N58",
      body: [...HUB_UPGRADER_BODY],
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:legacy"]).toBeUndefined();
    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(1);
  });

  it("removes orphaned legacy queue entries and live upgraders even without a config entry", () => {
    const legacyConfigName = "E4N58:hubUpgrader:legacy";
    const legacy = createUpgrader("legacy-upgrader", legacyConfigName, 15);
    Game.creeps = { legacy };
    const cancel = jest.fn(() => OK);
    Memory.creeps = { "legacy-spawning": { configName: legacyConfigName } as CreepMemory };
    Game.spawns.Spawn1 = {
      memory: { spawnList: [legacyConfigName, "E4N58:worker:0"] },
      spawning: { name: "legacy-spawning", cancel } as unknown as Spawning,
    } as StructureSpawn;

    runHubUpgradeControl();

    expect(legacy.suicide).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(["E4N58:worker:0"]);
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toBeDefined();
  });

  it("requests 450 XGH2O while the upgrader config has no creep", () => {
    runHubUpgradeControl();

    expect(mockedPrepareBoosts).toHaveBeenCalledWith(
      "hubUpgrade:E4N58",
      "E4N58",
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]),
      { requireLabEnergy: true },
    );
  });

  it("runs unboosted and releases boost prep when the room has no local XGH2O", () => {
    Game.rooms.E4N58 = createHubRoom(7, true, "E4N58", { storage: 0 });
    Memory.runtime!.powerBankBoost = {
      "hubUpgrade:E4N58": {
        taskId: "hubUpgrade:E4N58",
        sourceRoomName: "E4N58",
        labs: {},
      },
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("runs unboosted when local XGH2O cannot cover every remaining work part", () => {
    Game.rooms.E4N58 = createHubRoom(7, true, "E4N58", { storage: 449 });

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("prepares the boost when local storage, terminal, and labs cover the full requirement", () => {
    Game.rooms.E4N58 = createHubRoom(7, true, "E4N58", {
      storage: 200,
      terminal: 100,
      labs: [150],
    });

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]?.args).toEqual([
      "E4N58",
      "hubUpgrade:E4N58",
    ]);
    expect(mockedPrepareBoosts).toHaveBeenCalledWith(
      "hubUpgrade:E4N58",
      "E4N58",
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]),
      { requireLabEnergy: true },
    );
  });

  it("releases the shared boost lab when the upgrader is fully boosted", () => {
    Game.creeps.upgrader0 = createUpgrader(
      "upgrader0",
      "E4N58:hubUpgrader:0",
      15,
    );

    runHubUpgradeControl();

    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("retires the second live upgrader while keeping the canonical first upgrader", () => {
    const upgrader0 = createUpgrader("upgrader0", "E4N58:hubUpgrader:0", 15);
    const upgrader1 = createUpgrader("upgrader1", "E4N58:hubUpgrader:1", 15);
    Game.creeps = { upgrader0, upgrader1 };
    Memory.data!.creepConfigs = {
      "E4N58:hubUpgrader:0": {
        role: "hubUpgrader",
        args: ["E4N58", "hubUpgrade:E4N58"],
        roomName: "E4N58",
        body: [...HUB_UPGRADER_BODY],
      },
      "E4N58:hubUpgrader:1": {
        role: "hubUpgrader",
        args: ["E4N58", "hubUpgrade:E4N58"],
        roomName: "E4N58",
        body: [...HUB_UPGRADER_BODY],
      },
    };

    runHubUpgradeControl();

    expect(upgrader0.suicide).not.toHaveBeenCalled();
    expect(upgrader1.suicide).toHaveBeenCalled();
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:1"]).toBeUndefined();
  });

  it("removes configs, queued entries, and boost prep at RCL8", () => {
    Memory.data!.creepConfigs = {
      "E4N58:hubUpgrader:0": {
        role: "hubUpgrader",
        args: ["E4N58", "hubUpgrade:E4N58"],
        roomName: "E4N58",
        body: [...HUB_UPGRADER_BODY],
      },
      "E4N58:hubUpgrader:1": {
        role: "hubUpgrader",
        args: ["E4N58", "hubUpgrade:E4N58"],
        roomName: "E4N58",
        body: [...HUB_UPGRADER_BODY],
      },
    };
    Game.rooms.E4N58 = createHubRoom(8);
    Game.spawns.Spawn1 = {
      room: Game.rooms.E4N58,
      memory: {
        spawnList: [
          "E4N58:hubUpgrader:0",
          "E4N58:worker:0",
          "E4N58:hubUpgrader:1",
        ],
      },
    } as StructureSpawn;
    Memory.runtime!.powerBankBoost = {
      "hubUpgrade:E4N58": {
        taskId: "hubUpgrade:E4N58",
        sourceRoomName: "E4N58",
        labs: {},
      },
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs).toEqual({});
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(["E4N58:worker:0"]);
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
  });

  it("keeps the config and retries a temporary lab shortage", () => {
    mockedPrepareBoosts.mockReturnValue({
      status: "failed",
      reason: "insufficient_labs",
      labs: [],
    });

    runHubUpgradeControl();
    runHubUpgradeControl();

    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(1);
    expect(mockedPrepareBoosts).toHaveBeenCalledTimes(2);
  });

  it("removes stale upgrader configs when the configured hub room changes", () => {
    Memory.data!.creepConfigs = {
      "E3N59:hubUpgrader:0": {
        role: "hubUpgrader",
        args: ["E3N59", "hubUpgrade:E3N59"],
        roomName: "E3N59",
        body: [...HUB_UPGRADER_BODY],
      },
    };
    Memory.runtime!.powerBankBoost = {
      "hubUpgrade:E3N59": {
        taskId: "hubUpgrade:E3N59",
        sourceRoomName: "E3N59",
        labs: {},
      },
    };

    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E3N59:hubUpgrader:0"]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toBeDefined();
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:1"]).toBeUndefined();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E3N59", "E3N59");
  });
});

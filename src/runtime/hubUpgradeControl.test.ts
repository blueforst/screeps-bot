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

function createHubRoom(level = 7, my = true): Room {
  return {
    name: "E4N58",
    controller: { level, my } as StructureController,
  } as Room;
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
    mockedPrepareBoosts.mockReturnValue({ status: "preparing", labs: [] });
  });

  it("creates exactly two fixed-body upgrader configs for an owned RCL7 hub", () => {
    runHubUpgradeControl();

    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:0"]).toEqual({
      role: "hubUpgrader",
      args: ["E4N58", "hubUpgrade:E4N58"],
      roomName: "E4N58",
      body: HUB_UPGRADER_BODY,
    });
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:1"]).toEqual({
      role: "hubUpgrader",
      args: ["E4N58", "hubUpgrade:E4N58"],
      roomName: "E4N58",
      body: HUB_UPGRADER_BODY,
    });
    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(2);
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
    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(2);
  });

  it("requests 900 XGH2O while both upgrader configs have no creep", () => {
    runHubUpgradeControl();

    expect(mockedPrepareBoosts).toHaveBeenCalledWith(
      "hubUpgrade:E4N58",
      "E4N58",
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 900]]),
      { requireLabEnergy: true },
    );
  });

  it("requests only 450 XGH2O when one upgrader is already fully boosted", () => {
    Game.creeps.upgrader0 = createUpgrader(
      "upgrader0",
      "E4N58:hubUpgrader:0",
      15,
    );

    runHubUpgradeControl();

    expect(mockedPrepareBoosts).toHaveBeenCalledWith(
      "hubUpgrade:E4N58",
      "E4N58",
      0,
      new Map([[RESOURCE_CATALYZED_GHODIUM_ACID, 450]]),
      { requireLabEnergy: true },
    );
  });

  it("releases the shared boost lab when both upgraders are fully boosted", () => {
    Game.creeps.upgrader0 = createUpgrader("upgrader0", "E4N58:hubUpgrader:0", 15);
    Game.creeps.upgrader1 = createUpgrader("upgrader1", "E4N58:hubUpgrader:1", 15);
    runHubUpgradeControl();

    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E4N58", "E4N58");
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

  it("keeps both configs and retries a temporary lab shortage", () => {
    mockedPrepareBoosts.mockReturnValue({
      status: "failed",
      reason: "insufficient_labs",
      labs: [],
    });

    runHubUpgradeControl();
    runHubUpgradeControl();

    expect(Object.keys(Memory.data?.creepConfigs || {}).filter((name) => name.includes(":hubUpgrader:"))).toHaveLength(2);
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
    expect(Memory.data?.creepConfigs?.["E4N58:hubUpgrader:1"]).toBeDefined();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("hubUpgrade:E3N59", "E3N59");
  });
});

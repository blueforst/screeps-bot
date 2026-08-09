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

  it("runs unboosted and releases boost prep when local XGH2O is insufficient", () => {
    Game.rooms.E4N58 = createUpgraderRoom(7, true, "E4N58", { storage: 449 });

    startUpgrader("E4N58");

    expect(Memory.data?.creepConfigs?.["E4N58:upgrader:0"]?.args).toEqual(["E4N58"]);
    expect(mockedPrepareBoosts).not.toHaveBeenCalled();
    expect(mockedReleaseBoostLabs).toHaveBeenCalledWith("upgrader:E4N58", "E4N58");
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
});

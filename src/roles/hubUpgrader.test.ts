jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
}));

jest.mock("@/roles/combatBoosts", () => ({
  prepareCombatBoost: jest.fn(() => false),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

import { prepareCombatBoost } from "@/roles/combatBoosts";
import { hubUpgraderRole } from "@/roles/hubUpgrader";
import { moveToTarget } from "@/roles/shared";
import { createMockStore } from "@mock/powerBank";

const mockedPrepareBoost = prepareCombatBoost as jest.MockedFunction<typeof prepareCombatBoost>;
const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;

function createPos(range = 1): RoomPosition {
  return {
    getRangeTo: jest.fn(() => range),
    isNearTo: jest.fn(() => range <= 1),
  } as unknown as RoomPosition;
}

function createEnergyStructure(
  structureType: StructureConstant,
  energy: number,
  controllerRange = 2,
): StructureLink | StructureContainer | StructureStorage | StructureTerminal {
  return {
    id: `${structureType}-${energy}`,
    structureType,
    pos: createPos(controllerRange),
    store: createMockStore({ [RESOURCE_ENERGY]: energy }),
  } as unknown as StructureLink | StructureContainer | StructureStorage | StructureTerminal;
}

function createRoom(
  structures: Structure[] = [],
  level = 7,
  my = true,
  name = "E4N58",
): Room {
  const controller = {
    my,
    level,
    pos: createPos(),
  } as StructureController;

  const room = {
    name,
    controller,
    storage: structures.find((structure) => structure.structureType === STRUCTURE_STORAGE),
    find: jest.fn((type: FindConstant, options?: { filter?: (structure: Structure) => boolean }) => {
      if (type !== FIND_STRUCTURES) return [];
      return options?.filter ? structures.filter(options.filter) : structures;
    }),
  } as unknown as Room;
  (controller as StructureController & { room: Room }).room = room;
  return room;
}

function createCreep(room: Room, energy = 0): Creep {
  return {
    name: "hub-upgrader",
    room,
    pos: createPos(),
    store: createMockStore({ [RESOURCE_ENERGY]: energy }, 250),
    memory: {
      role: "hubUpgrader",
      configName: "E4N58:hubUpgrader:0",
    },
    withdraw: jest.fn(() => OK),
    upgradeController: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("hubUpgraderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrepareBoost.mockReturnValue(false);
    Memory.cfg = { hub: { enabled: true, hubRoomName: "E4N58" } } as Memory["cfg"];
    Memory.data = {
      creepConfigs: {
        "E4N58:hubUpgrader:0": {
          role: "hubUpgrader",
          args: ["E4N58", "hubUpgrade:E4N58"],
          roomName: "E4N58",
        },
      },
    };
  });

  it("waits for its shared XGH2O boost task during prepare", () => {
    const room = createRoom();
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);
    const role = hubUpgraderRole("E4N58", "hubUpgrade:E4N58");

    expect(role.prepare?.(creep)).toBe(false);
    expect(mockedPrepareBoost).toHaveBeenCalledWith(
      creep,
      "hubUpgrade:E4N58",
      RESOURCE_CATALYZED_GHODIUM_ACID,
    );
  });

  it("withdraws from a controller-adjacent link before a container", () => {
    const container = createEnergyStructure(STRUCTURE_CONTAINER, 1000);
    const link = createEnergyStructure(STRUCTURE_LINK, 400);
    const room = createRoom([container as Structure, link as Structure]);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);

    hubUpgraderRole("E4N58", "hubUpgrade:E4N58").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
  });

  it("falls back to a controller-adjacent container", () => {
    const container = createEnergyStructure(STRUCTURE_CONTAINER, 1000);
    const room = createRoom([container as Structure]);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);

    hubUpgraderRole("E4N58", "hubUpgrade:E4N58").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
  });

  it("falls back to storage when controller-local sources are empty", () => {
    const storage = createEnergyStructure(STRUCTURE_STORAGE, 100_000);
    const terminal = createEnergyStructure(STRUCTURE_TERMINAL, 100_000);
    const room = createRoom([storage as Structure, terminal as Structure]);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);

    hubUpgraderRole("E4N58", "hubUpgrade:E4N58").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(creep.withdraw).not.toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it("upgrades only the configured owned RCL7 controller", () => {
    const room = createRoom();
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);

    const shouldRefill = hubUpgraderRole("E4N58", "hubUpgrade:E4N58").target(creep);

    expect(shouldRefill).toBe(false);
    expect(creep.upgradeController).toHaveBeenCalledWith(room.controller);
  });

  it("upgrades a configured extra RCL7 room", () => {
    (Memory.cfg!.hub as any).upgraderRoomNames = ["W1N57"];
    const room = createRoom([], 7, true, "W1N57");
    Game.rooms.W1N57 = room;
    const creep = createCreep(room, 100);
    creep.memory.configName = "W1N57:hubUpgrader:0";
    Memory.data!.creepConfigs!["W1N57:hubUpgrader:0"] = {
      role: "hubUpgrader",
      args: ["W1N57", "hubUpgrade:W1N57"],
      roomName: "W1N57",
    };

    hubUpgraderRole("W1N57", "hubUpgrade:W1N57").target(creep);

    expect(creep.upgradeController).toHaveBeenCalledWith(room.controller);
  });

  it("stops an orphaned noncanonical upgrader in an otherwise active room", () => {
    const room = createRoom();
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);
    creep.memory.configName = "E4N58:hubUpgrader:legacy";

    hubUpgraderRole("E4N58", "hubUpgrade:E4N58").target(creep);

    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it("stops acting after the controller reaches RCL8", () => {
    const room = createRoom([], 8);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);
    const role = hubUpgraderRole("E4N58", "hubUpgrade:E4N58");

    expect(role.prepare?.(creep)).toBe(true);
    expect(role.source?.(creep)).toBe(false);
    expect(role.target(creep)).toBe(false);
    expect(mockedPrepareBoost).not.toHaveBeenCalled();
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it("stops an existing creep after the hub is disabled or moved", () => {
    const room = createRoom();
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);
    Memory.cfg!.hub = { enabled: false, hubRoomName: "E4N58" } as typeof Memory.cfg.hub;

    const role = hubUpgraderRole("E4N58", "hubUpgrade:E4N58");

    expect(role.source?.(creep)).toBe(false);
    expect(role.target(creep)).toBe(false);
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });
});

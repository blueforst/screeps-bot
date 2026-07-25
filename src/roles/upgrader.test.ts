jest.mock("@/roles/combatBoosts", () => ({ prepareCombatBoost: jest.fn(() => false) }));
jest.mock("@/roles/shared", () => ({ moveToTarget: jest.fn() }));

import { prepareCombatBoost } from "@/roles/combatBoosts";
import { moveToTarget } from "@/roles/shared";
import { upgraderRole } from "@/roles/upgrader";
import { createMockStore } from "@mock/powerBank";

const mockedPrepareBoost = prepareCombatBoost as jest.MockedFunction<typeof prepareCombatBoost>;
const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;

function createPos(): RoomPosition {
  return { getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition;
}

function createRoom(structures: Structure[] = [], level = 7, my = true, name = "E4N58"): Room {
  const room = {
    name,
    find: jest.fn(() => structures),
  } as unknown as Room;
  const controller = {
    my,
    level,
    pos: createPos(),
    room,
  } as StructureController;
  room.controller = controller;
  return room;
}

function createCreep(room: Room, energy = 0): Creep {
  return {
    name: "upgrader0",
    room,
    pos: createPos(),
    store: createMockStore({ [RESOURCE_ENERGY]: energy }, 250),
    memory: { role: "upgrader", configName: "E4N58:upgrader:0" },
    withdraw: jest.fn(() => OK),
    upgradeController: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("upgraderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrepareBoost.mockReturnValue(false);
    Memory.data = {
      manualUpgraders: { E4N58: { createdAt: Game.time, updatedAt: Game.time } },
      creepConfigs: {
        "E4N58:upgrader:0": {
          role: "upgrader",
          args: ["E4N58", "upgrader:E4N58"],
          roomName: "E4N58",
        },
      },
    };
  });

  it("prepares T3 only when the active manual config requests it", () => {
    const room = createRoom();
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);

    expect(upgraderRole("E4N58", "upgrader:E4N58").prepare?.(creep)).toBe(false);
    expect(mockedPrepareBoost).toHaveBeenCalledWith(
      creep,
      "upgrader:E4N58",
      RESOURCE_CATALYZED_GHODIUM_ACID,
    );
  });

  it("uses a controller-local link before other energy sources", () => {
    const link = {
      structureType: STRUCTURE_LINK,
      pos: createPos(),
      store: createMockStore({ [RESOURCE_ENERGY]: 800 }, 800),
    } as unknown as StructureLink;
    const room = createRoom([link]);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);

    upgraderRole("E4N58", "upgrader:E4N58").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
  });

  it("falls back to storage when controller-local sources are empty", () => {
    const storage = {
      structureType: STRUCTURE_STORAGE,
      pos: createPos(),
      store: createMockStore({ [RESOURCE_ENERGY]: 1000 }, 1000000),
    } as unknown as StructureStorage;
    const room = createRoom();
    room.storage = storage;
    Game.rooms.E4N58 = room;
    const creep = createCreep(room);

    upgraderRole("E4N58", "upgrader:E4N58").source?.(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it("does not work after the manual task is removed or the room reaches RCL8", () => {
    const room = createRoom([], 8);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);

    expect(upgraderRole("E4N58", "upgrader:E4N58").target(creep)).toBe(false);
    expect(creep.upgradeController).not.toHaveBeenCalled();

    room.controller!.level = 7;
    delete Memory.data!.manualUpgraders!.E4N58;
    expect(upgraderRole("E4N58", "upgrader:E4N58").source?.(creep)).toBe(false);
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
  });

  it("works at RCL6 with an active manual task", () => {
    const room = createRoom([], 6);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);

    expect(upgraderRole("E4N58", "upgrader:E4N58").target(creep)).toBe(false);
    expect(creep.upgradeController).toHaveBeenCalledWith(room.controller);
  });
});

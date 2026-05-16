import {
  prepareBoosts,
  checkBoostReadiness,
  releaseBoostLabs,
  findBestDonorRoom,
} from "@/runtime/powerBankBoost";
import {
  getActivePowerBankBoostLabIds,
  getAssignedPowerBankBoostLabId,
  ensurePowerBankBoostPrepStore,
} from "@/runtime/powerBankBoostMemory";
import { isSynthesisPaused } from "@/runtime/synthesisControl";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { createMockStore, MockPos } from "@mock/powerBank";
import { clearCarrierTaskBoardForTest } from "@/runtime/carrierTaskBoard";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createLabWithCompound(id: string, roomName: string, compound: ResourceConstant | null, amount: number): StructureLab {
  const storeResources: Record<string, number> = {};
  if (compound && amount > 0) {
    storeResources[compound] = amount;
  }
  return {
    id: id as Id<StructureLab>,
    pos: new MockPos(20, 20, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_LAB as StructureConstant,
    mineralType: compound as MineralConstant | null,
    mineralAmount: amount,
    cooldown: 0,
    store: createMockStore(storeResources),
    boostCreep: jest.fn(() => OK),
    runReaction: jest.fn(() => OK),
  } as unknown as StructureLab;
}

function createRoomWithInfrastructure(options: {
  name: string;
  storageResources?: Record<string, number>;
  terminalResources?: Record<string, number>;
  labs?: StructureLab[];
  terminalCooldown?: number;
}): Room {
  const roomName = options.name;
  const storageResources = options.storageResources ?? {};
  const terminalResources = options.terminalResources ?? {};

  const storage = {
    id: `${roomName}-storage` as Id<StructureStorage>,
    structureType: STRUCTURE_STORAGE,
    store: createMockStore(storageResources),
    pos: new MockPos(25, 25, roomName) as unknown as RoomPosition,
  } as unknown as StructureStorage;

  const terminal = {
    id: `${roomName}-terminal` as Id<StructureTerminal>,
    structureType: STRUCTURE_TERMINAL,
    store: createMockStore(terminalResources),
    pos: new MockPos(26, 26, roomName) as unknown as RoomPosition,
    cooldown: options.terminalCooldown ?? 0,
  } as unknown as StructureTerminal;

  const labs = options.labs ?? [
    createLabWithCompound(`${roomName}-lab-1`, roomName, null, 0),
    createLabWithCompound(`${roomName}-lab-2`, roomName, null, 0),
    createLabWithCompound(`${roomName}-lab-3`, roomName, null, 0),
  ];

  const room = {
    name: roomName,
    controller: { my: true, level: 8 } as StructureController,
    storage,
    terminal,
    find: jest.fn((type: FindConstant, opts?: { filter?: (s: Structure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        const all = [...labs];
        return opts?.filter ? all.filter((s) => opts.filter?.(s as Structure)) : all;
      }
      return [];
    }),
  } as unknown as Room;

  return room;
}

const SOURCE_ROOM = "W1N1";
const HUB_ROOM = "W2N2";
const DONOR_ROOM = "W3N3";
const TASK_ID = "pb-task-001";

describe("powerBankBoost", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 100;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {},
      },
    };
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    (Game as any).getObjectById = jest.fn();
    (Game as any).market = {
      calcTransactionCost: () => 0,
    };
  });

  describe("prepareBoosts", () => {
    it("returns ready with empty labs for unknown tier with no requirements", () => {
      const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 99);

      expect(result.status).toBe("ready");
      expect(result.labs).toEqual([]);
    });

    it("returns failed when room is not visible", () => {
      const result = prepareBoosts(TASK_ID, "W9N9", 6);

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("room_not_visible");
    });

    it("returns failed when not enough labs", () => {
      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        labs: [createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0)],
      });
      Game.rooms[SOURCE_ROOM] = room;

      const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

      expect(result.status).toBe("failed");
      expect(result.reason).toBe("insufficient_labs");
    });

    describe("with local stock sufficient", () => {
      it("returns preparing and creates carrier tasks for tier 6", () => {
        const compounds = [
          RESOURCE_CATALYZED_GHODIUM_ACID,
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ];
        const labs = compounds.map((_, i) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0)
        );

        const storageResources: Record<string, number> = {};
        for (const c of compounds) {
          storageResources[c] = 5000;
        }

        const room = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources,
          labs,
        });
        Game.rooms[SOURCE_ROOM] = room;

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result.status).toBe("preparing");
        expect(result.labs).toHaveLength(3);
        expect(result.reason).toBeUndefined();
      });
    });

    describe("with insufficient local stock and no donor", () => {
      it("returns failed with insufficient_boost_compound", () => {
        const room = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources: {},
          labs: [
            createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0),
            createLabWithCompound(`${SOURCE_ROOM}-lab-2`, SOURCE_ROOM, null, 0),
            createLabWithCompound(`${SOURCE_ROOM}-lab-3`, SOURCE_ROOM, null, 0),
          ],
        });
        Game.rooms[SOURCE_ROOM] = room;

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result.status).toBe("failed");
        expect(result.reason).toBe("insufficient_boost_compound");
      });
    });

    describe("with hub room donor", () => {
      it("creates transfer task from hub room", () => {
        Memory.cfg!.hub = { hubRoomName: HUB_ROOM };

        const sourceRoom = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          labs: [
            createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0),
            createLabWithCompound(`${SOURCE_ROOM}-lab-2`, SOURCE_ROOM, null, 0),
            createLabWithCompound(`${SOURCE_ROOM}-lab-3`, SOURCE_ROOM, null, 0),
          ],
        });
        Game.rooms[SOURCE_ROOM] = sourceRoom;

        const hubRoom = createRoomWithInfrastructure({
          name: HUB_ROOM,
          terminalResources: {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
          },
        });
        Game.rooms[HUB_ROOM] = hubRoom;

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result.status).toBe("preparing");

        const tasks = ensureResourceTransferTaskStore();
        const transferTasks = Object.values(tasks).filter(
          (t) => t.status === "pending" && t.fromRoomName === HUB_ROOM,
        );
        expect(transferTasks.length).toBeGreaterThan(0);
      });
    });

    describe("with non-hub room donor", () => {
      it("creates transfer from non-hub when hub has no stock", () => {
        Memory.cfg!.hub = { hubRoomName: HUB_ROOM };

        const sourceRoom = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          labs: [
            createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0),
            createLabWithCompound(`${SOURCE_ROOM}-lab-2`, SOURCE_ROOM, null, 0),
            createLabWithCompound(`${SOURCE_ROOM}-lab-3`, SOURCE_ROOM, null, 0),
          ],
        });
        Game.rooms[SOURCE_ROOM] = sourceRoom;

        const hubRoom = createRoomWithInfrastructure({
          name: HUB_ROOM,
          terminalResources: {},
        });
        Game.rooms[HUB_ROOM] = hubRoom;

        const donorRoom = createRoomWithInfrastructure({
          name: DONOR_ROOM,
          terminalResources: {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
          },
        });
        Game.rooms[DONOR_ROOM] = donorRoom;

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result.status).toBe("preparing");

        const tasks = ensureResourceTransferTaskStore();
        const transferTasks = Object.values(tasks).filter(
          (t) => t.status === "pending" && t.fromRoomName === DONOR_ROOM,
        );
        expect(transferTasks.length).toBeGreaterThan(0);
      });
    });
  });

  describe("checkBoostReadiness", () => {
    it("returns true when no compounds required", () => {
      expect(checkBoostReadiness(SOURCE_ROOM, [])).toBe(true);
    });

    it("returns false when no prep memory exists", () => {
      expect(checkBoostReadiness(SOURCE_ROOM, [RESOURCE_CATALYZED_GHODIUM_ACID])).toBe(false);
    });

    it("returns true when all compounds loaded in labs", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const storageResources: Record<string, number> = {};
      for (const c of compounds) {
        storageResources[c] = 5000;
      }

      const labs = compounds.map((c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, c, LAB_BOOST_MINERAL)
      );

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs,
      });
      Game.rooms[SOURCE_ROOM] = room;

      (Game.getObjectById as jest.Mock).mockImplementation((id: string) => {
        return labs.find((l) => l.id === id) ?? null;
      });

      prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

      const result = checkBoostReadiness(SOURCE_ROOM, compounds);
      expect(result).toBe(true);
    });

    it("returns false when compounds still loading", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const storageResources: Record<string, number> = {};
      for (const c of compounds) {
        storageResources[c] = 5000;
      }

      const labs = compounds.map((_c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0)
      );

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs,
      });
      Game.rooms[SOURCE_ROOM] = room;

      prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

      const result = checkBoostReadiness(SOURCE_ROOM, compounds);
      expect(result).toBe(false);
    });
  });

  describe("releaseBoostLabs", () => {
    it("resumes synthesis after release", () => {
      const storageResources: Record<string, number> = {};
      storageResources[RESOURCE_CATALYZED_GHODIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_UTRIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE] = 5000;

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const labs = compounds.map((c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, c, LAB_BOOST_MINERAL)
      );

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs,
      });
      Game.rooms[SOURCE_ROOM] = room;

      Memory.cfg!.synthesisControl!.rooms = {
        [SOURCE_ROOM]: {
          enabled: true,
          reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5000 }],
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
            reagentLabIds: [`${SOURCE_ROOM}-lab-1`, `${SOURCE_ROOM}-lab-2`],
            productLabIds: [`${SOURCE_ROOM}-lab-3`],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
          },
        },
      };

      prepareBoosts(TASK_ID, SOURCE_ROOM, 6);
      expect(isSynthesisPaused(SOURCE_ROOM)).toBe(true);

      releaseBoostLabs(TASK_ID, SOURCE_ROOM);
      expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);
    });

    it("clears prep memory", () => {
      const storageResources: Record<string, number> = {};
      storageResources[RESOURCE_CATALYZED_GHODIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_UTRIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE] = 5000;

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const labs = compounds.map((_c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0)
      );

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs,
      });
      Game.rooms[SOURCE_ROOM] = room;

      prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

      releaseBoostLabs(TASK_ID, SOURCE_ROOM);

      expect(Memory.runtime?.powerBankBoost?.[TASK_ID]).toBeUndefined();
    });
  });

  describe("findBestDonorRoom", () => {
    it("returns null when no rooms have the resource", () => {
      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ACID, 1000, [SOURCE_ROOM]);
      expect(result).toBeNull();
    });

    it("prefers hub room over non-hub room", () => {
      Memory.cfg!.hub = { hubRoomName: HUB_ROOM };

      const hubRoom = createRoomWithInfrastructure({
        name: HUB_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 2000 },
      });
      Game.rooms[HUB_ROOM] = hubRoom;

      const donorRoom = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000 },
      });
      Game.rooms[DONOR_ROOM] = donorRoom;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ACID, 1000, [SOURCE_ROOM]);
      expect(result).toBe(HUB_ROOM);
    });

    it("returns non-hub room when hub has no stock", () => {
      Memory.cfg!.hub = { hubRoomName: HUB_ROOM };

      const hubRoom = createRoomWithInfrastructure({
        name: HUB_ROOM,
        terminalResources: {},
      });
      Game.rooms[HUB_ROOM] = hubRoom;

      const donorRoom = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000 },
      });
      Game.rooms[DONOR_ROOM] = donorRoom;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ACID, 1000, [SOURCE_ROOM]);
      expect(result).toBe(DONOR_ROOM);
    });

    it("excludes specified rooms", () => {
      const room = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000 },
      });
      Game.rooms[DONOR_ROOM] = room;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ACID, 1000, [DONOR_ROOM]);
      expect(result).toBeNull();
    });

    it("returns null when terminal has cooldown", () => {
      const room = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ACID]: 5000 },
        terminalCooldown: 5,
      });
      Game.rooms[DONOR_ROOM] = room;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ACID, 1000, [SOURCE_ROOM]);
      expect(result).toBeNull();
    });
  });

  describe("synthesis pause during prep", () => {
    it("pauses synthesis when preparing boosts", () => {
      Memory.cfg!.synthesisControl!.rooms = {
        [SOURCE_ROOM]: {
          enabled: true,
          reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5000 }],
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
            reagentLabIds: [`${SOURCE_ROOM}-lab-1`, `${SOURCE_ROOM}-lab-2`],
            productLabIds: [`${SOURCE_ROOM}-lab-3`],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
          },
        },
      };

      const storageResources: Record<string, number> = {};
      storageResources[RESOURCE_CATALYZED_GHODIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_UTRIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE] = 5000;

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ACID,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const labs = compounds.map((_c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0)
      );

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs,
      });
      Game.rooms[SOURCE_ROOM] = room;

      expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);

      prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

      expect(isSynthesisPaused(SOURCE_ROOM)).toBe(true);
    });
  });

  describe("getActivePowerBankBoostLabIds", () => {
    it("returns only lab IDs for matching source room", () => {
      Memory.runtime = {};
      const store = ensurePowerBankBoostPrepStore();
      store["task-a"] = {
        taskId: "task-a",
        sourceRoomName: "roomA",
        labs: {
          "lab-1": { labId: "lab-1", compound: RESOURCE_CATALYZED_GHODIUM_ACID },
          "lab-2": { labId: "lab-2", compound: RESOURCE_CATALYZED_UTRIUM_ACID },
        },
      };
      store["task-b"] = {
        taskId: "task-b",
        sourceRoomName: "roomB",
        labs: {
          "lab-3": { labId: "lab-3", compound: RESOURCE_CATALYZED_GHODIUM_ACID },
        },
      };

      const result = getActivePowerBankBoostLabIds("roomA");
      expect(result).toEqual(new Set(["lab-1", "lab-2"]));
    });

    it("returns empty Set when no matching prep entries", () => {
      Memory.runtime = {};
      const store = ensurePowerBankBoostPrepStore();
      store["task-c"] = {
        taskId: "task-c",
        sourceRoomName: "roomC",
        labs: {
          "lab-4": { labId: "lab-4", compound: RESOURCE_CATALYZED_GHODIUM_ACID },
        },
      };

      const result = getActivePowerBankBoostLabIds("roomX");
      expect(result).toEqual(new Set());
    });
  });

  describe("getAssignedPowerBankBoostLabId", () => {
    it("returns lab ID for matching compound", () => {
      Memory.runtime = {};
      const store = ensurePowerBankBoostPrepStore();
      store["task-d"] = {
        taskId: "task-d",
        sourceRoomName: SOURCE_ROOM,
        labs: {
          "lab-10": { labId: "lab-10", compound: RESOURCE_CATALYZED_GHODIUM_ACID },
          "lab-11": { labId: "lab-11", compound: RESOURCE_CATALYZED_UTRIUM_ACID },
        },
      };

      expect(getAssignedPowerBankBoostLabId("task-d", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe("lab-11");
    });

    it("returns undefined when task not found", () => {
      expect(getAssignedPowerBankBoostLabId("nonexistent", RESOURCE_CATALYZED_GHODIUM_ACID)).toBeUndefined();
    });

    it("returns undefined when compound not assigned", () => {
      Memory.runtime = {};
      const store = ensurePowerBankBoostPrepStore();
      store["task-e"] = {
        taskId: "task-e",
        sourceRoomName: SOURCE_ROOM,
        labs: {
          "lab-20": { labId: "lab-20", compound: RESOURCE_CATALYZED_GHODIUM_ACID },
        },
      };

      expect(getAssignedPowerBankBoostLabId("task-e", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE)).toBeUndefined();
    });
  });
});

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
import { clearCarrierTaskBoardForTest, listCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createLabWithCompound(
  id: string,
  roomName: string,
  compound: ResourceConstant | null,
  amount: number,
  energy = 0,
): StructureLab {
  const storeResources: Record<string, number> = { [RESOURCE_ENERGY]: energy };
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
      it("creates separate mineral and energy supply tasks for war boost labs", () => {
        const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
        const lab = createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0, 0);
        const required = new Map<ResourceConstant, number>([[compound, 60]]);
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources: { [compound]: 60, [RESOURCE_ENERGY]: 10_000 },
          labs: [lab],
        });

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6, required, { requireLabEnergy: true });

        expect(result.status).toBe("preparing");
        const supplySteps = listCarrierTasksByRoom(SOURCE_ROOM)
          .filter((task) => task.producer === `powerBankBoost:${TASK_ID}`)
          .map((task) => task.steps[0]);
        expect(supplySteps).toEqual(expect.arrayContaining([
          expect.objectContaining({ resource: compound, amount: 60, toId: lab.id }),
          expect.objectContaining({ resource: RESOURCE_ENERGY, amount: 40, toId: lab.id }),
        ]));
      });

      it("returns preparing and creates carrier tasks for tier 6", () => {
        const compounds = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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

        const supplyAmounts = Object.fromEntries(
          listCarrierTasksByRoom(SOURCE_ROOM)
            .filter((task) => task.producer === `powerBankBoost:${TASK_ID}`)
            .map((task) => [task.steps[0].resource, task.steps[0].amount]),
        );
        expect(supplyAmounts).toEqual({
          [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 120,
          [RESOURCE_CATALYZED_UTRIUM_ACID]: 450,
          [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 210,
        });
        expect(Object.values(supplyAmounts)).not.toContain(900);
      });

      it("uses local stock for boost lab supply even when stale incoming transfer exists", () => {
        const compounds = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ];
        const labs = compounds.map((_, i) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0)
        );
        const room = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources: {
            [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
          },
          labs,
        });
        Game.rooms[SOURCE_ROOM] = room;
        ensureResourceTransferTaskStore()["stale-incoming-xuh2o"] = {
          id: "stale-incoming-xuh2o",
          resource: RESOURCE_CATALYZED_UTRIUM_ACID,
          fromRoomName: DONOR_ROOM,
          toRoomName: SOURCE_ROOM,
          amount: 1200,
          remainingAmount: 1200,
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
          origin: "manual",
          lastProgressAt: 1,
        };

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result.status).toBe("preparing");
        const xuh2oTask = listCarrierTasksByRoom(SOURCE_ROOM).find(
          (task) => task.id === `powerBankBoost:lab_supply:${TASK_ID}:${RESOURCE_CATALYZED_UTRIUM_ACID}`,
        );
        expect(xuh2oTask?.steps[0]).toMatchObject({
          resource: RESOURCE_CATALYZED_UTRIUM_ACID,
          amount: 450,
          fromId: `${SOURCE_ROOM}-storage`,
          toId: `${SOURCE_ROOM}-lab-2`,
        });
      });

      it("does not resupply compounds whose remaining boost demand is zero", () => {
        const compounds = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ];
        const labs = compounds.map((_, i) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0)
        );
        const room = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources: {
            [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
          },
          labs,
        });
        Game.rooms[SOURCE_ROOM] = room;

        const remainingAmounts = new Map<ResourceConstant, number>([
          [RESOURCE_CATALYZED_UTRIUM_ACID, 450],
          [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 210],
        ]);

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6, remainingAmounts);

        expect(result.status).toBe("preparing");
        const supplyResources = listCarrierTasksByRoom(SOURCE_ROOM)
          .filter((task) => task.producer === `powerBankBoost:${TASK_ID}`)
          .map((task) => task.steps[0].resource);
        expect(supplyResources).not.toContain(RESOURCE_CATALYZED_GHODIUM_ALKALIDE);
        expect(supplyResources).toEqual(expect.arrayContaining([
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ]));
      });

      it("clears old boost carrier tasks when no remaining boost demand exists", () => {
        const lab = createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0);
        const room = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources: {
            [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
            [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
            [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: 5000,
          },
          labs: [lab, createLabWithCompound(`${SOURCE_ROOM}-lab-2`, SOURCE_ROOM, null, 0), createLabWithCompound(`${SOURCE_ROOM}-lab-3`, SOURCE_ROOM, null, 0)],
        });
        Game.rooms[SOURCE_ROOM] = room;

        prepareBoosts(TASK_ID, SOURCE_ROOM, 6);
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${TASK_ID}`)).toBe(true);

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6, new Map());

        expect(result.status).toBe("ready");
        expect(listCarrierTasksByRoom(SOURCE_ROOM).filter((task) => task.producer === `powerBankBoost:${TASK_ID}`)).toHaveLength(0);
      });

      it("reuses its own reserved labs on repeated preparation", () => {
        const compounds = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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

        const first = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);
        const second = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(first.status).toBe("preparing");
        expect(second.status).toBe("preparing");
        expect(second.reason).toBeUndefined();
        expect(second.labs).toEqual(first.labs);
      });

      it("cleans wrong minerals from reserved boost labs before supplying boosts", () => {
        const compounds = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ];
        const labs = [
          createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, RESOURCE_LEMERGIUM, 80),
          createLabWithCompound(`${SOURCE_ROOM}-lab-2`, SOURCE_ROOM, RESOURCE_HYDROGEN, 80),
          createLabWithCompound(`${SOURCE_ROOM}-lab-3`, SOURCE_ROOM, RESOURCE_LEMERGIUM_HYDRIDE, 165),
        ];

        const terminalResources: Record<string, number> = {};
        for (const c of compounds) {
          terminalResources[c] = 5000;
        }

        const room = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          terminalResources,
          labs,
        });
        Game.rooms[SOURCE_ROOM] = room;

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result.status).toBe("preparing");
        const tasks = listCarrierTasksByRoom(SOURCE_ROOM).filter((task) => task.producer === `powerBankBoost:${TASK_ID}`);
        expect(tasks).toHaveLength(3);
        expect(tasks.every((task) => task.type === "lab_cleanup")).toBe(true);
        expect(tasks.map((task) => task.steps[0].resource).sort()).toEqual([
          RESOURCE_HYDROGEN,
          RESOURCE_LEMERGIUM,
          RESOURCE_LEMERGIUM_HYDRIDE,
        ].sort());
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
            [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
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
            [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000,
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
      expect(checkBoostReadiness(TASK_ID, [])).toBe(true);
    });

    it("returns false when no prep memory exists for task", () => {
      expect(checkBoostReadiness(TASK_ID, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE])).toBe(false);
    });

    it("requires the full lab energy budget only when requested by war prep", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      const required = new Map<ResourceConstant, number>([[compound, 60]]);
      const lab = createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, compound, 60, 0);
      Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab] });
      Memory.runtime = {};
      ensurePowerBankBoostPrepStore()[TASK_ID] = {
        taskId: TASK_ID,
        sourceRoomName: SOURCE_ROOM,
        labs: { [lab.id]: { labId: lab.id, compound } },
      };
      Game.getObjectById = jest.fn(() => lab) as typeof Game.getObjectById;

      expect(checkBoostReadiness(TASK_ID, [compound], required)).toBe(true);
      expect(checkBoostReadiness(TASK_ID, [compound], required, { requireLabEnergy: true })).toBe(false);
    });

    it("returns true when all compounds loaded in labs", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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

      const result = checkBoostReadiness(TASK_ID, compounds);
      expect(result).toBe(true);
    });

    it("returns false when compounds still loading", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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

      const result = checkBoostReadiness(TASK_ID, compounds);
      expect(result).toBe(false);
    });

    it("returns independent readiness for concurrent powerbank boost tasks", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const storageResources: Record<string, number> = {};
      for (const c of compounds) {
        storageResources[c] = 5000;
      }

      // Task A gets labs 4-6 (empty, preferred by selectAvailableLabs), Task B gets labs 1-3 (loaded with compounds)
      const labsA = compounds.map((_c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 4}`, SOURCE_ROOM, null, 0)
      );
      const labsB = compounds.map((c, i) =>
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, c, LAB_BOOST_MINERAL)
      );

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs: [...labsA, ...labsB],
      });
      Game.rooms[SOURCE_ROOM] = room;

      (Game.getObjectById as jest.Mock).mockImplementation((id: string) => {
        const allLabs = [...labsA, ...labsB];
        return allLabs.find((l) => l.id === id) ?? null;
      });

      const taskIdA = "pb-task-a";
      const taskIdB = "pb-task-b";

      prepareBoosts(taskIdA, SOURCE_ROOM, 6);
      prepareBoosts(taskIdB, SOURCE_ROOM, 6);

      expect(checkBoostReadiness(taskIdA, compounds)).toBe(false);
      expect(checkBoostReadiness(taskIdB, compounds)).toBe(true);
    });
  });

  describe("releaseBoostLabs", () => {
    it("resumes synthesis after release", () => {
      const storageResources: Record<string, number> = {};
      storageResources[RESOURCE_CATALYZED_GHODIUM_ALKALIDE] = 5000;
      storageResources[RESOURCE_CATALYZED_UTRIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE] = 5000;

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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
      storageResources[RESOURCE_CATALYZED_GHODIUM_ALKALIDE] = 5000;
      storageResources[RESOURCE_CATALYZED_UTRIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE] = 5000;

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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
      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 1000, [SOURCE_ROOM]);
      expect(result).toBeNull();
    });

    it("prefers hub room over non-hub room", () => {
      Memory.cfg!.hub = { hubRoomName: HUB_ROOM };

      const hubRoom = createRoomWithInfrastructure({
        name: HUB_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 2000 },
      });
      Game.rooms[HUB_ROOM] = hubRoom;

      const donorRoom = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
      });
      Game.rooms[DONOR_ROOM] = donorRoom;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 1000, [SOURCE_ROOM]);
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
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
      });
      Game.rooms[DONOR_ROOM] = donorRoom;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 1000, [SOURCE_ROOM]);
      expect(result).toBe(DONOR_ROOM);
    });

    it("excludes specified rooms", () => {
      const room = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
      });
      Game.rooms[DONOR_ROOM] = room;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 1000, [DONOR_ROOM]);
      expect(result).toBeNull();
    });

    it("returns null when terminal has cooldown", () => {
      const room = createRoomWithInfrastructure({
        name: DONOR_ROOM,
        terminalResources: { [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 5000 },
        terminalCooldown: 5,
      });
      Game.rooms[DONOR_ROOM] = room;

      const result = findBestDonorRoom(RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 1000, [SOURCE_ROOM]);
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
      storageResources[RESOURCE_CATALYZED_GHODIUM_ALKALIDE] = 5000;
      storageResources[RESOURCE_CATALYZED_UTRIUM_ACID] = 5000;
      storageResources[RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE] = 5000;

      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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

  describe("concurrent task-scoped lab reservation", () => {
    it("assigns different labs to concurrent powerbank boost tasks", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
      ];

      const storageResources: Record<string, number> = {};
      for (const c of compounds) {
        storageResources[c] = 5000;
      }

      const labs = compounds.flatMap((_, i) => [
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 1}`, SOURCE_ROOM, null, 0),
        createLabWithCompound(`${SOURCE_ROOM}-lab-${i + 4}`, SOURCE_ROOM, null, 0),
      ]);

      const room = createRoomWithInfrastructure({
        name: SOURCE_ROOM,
        storageResources,
        labs,
      });
      Game.rooms[SOURCE_ROOM] = room;

      const resultA = prepareBoosts("pb-task-a", SOURCE_ROOM, 6);
      const resultB = prepareBoosts("pb-task-b", SOURCE_ROOM, 6);

      expect(resultA.status).not.toBe("failed");
      expect(resultB.status).not.toBe("failed");

      const overlap = resultA.labs.filter((l) => resultB.labs.includes(l));
      expect(overlap).toEqual([]);
    });

    it("returns insufficient_labs when powerbank boost labs are reserved", () => {
      const compounds: ResourceConstant[] = [
        RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
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

      const resultA = prepareBoosts("pb-task-a", SOURCE_ROOM, 6);
      expect(resultA.status).not.toBe("failed");

      const resultB = prepareBoosts("pb-task-b", SOURCE_ROOM, 6);
      expect(resultB.status).toBe("failed");
      expect(resultB.reason).toBe("insufficient_labs");
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
          "lab-1": { labId: "lab-1", compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE },
          "lab-2": { labId: "lab-2", compound: RESOURCE_CATALYZED_UTRIUM_ACID },
        },
      };
      store["task-b"] = {
        taskId: "task-b",
        sourceRoomName: "roomB",
        labs: {
          "lab-3": { labId: "lab-3", compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE },
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
          "lab-4": { labId: "lab-4", compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE },
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
          "lab-10": { labId: "lab-10", compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE },
          "lab-11": { labId: "lab-11", compound: RESOURCE_CATALYZED_UTRIUM_ACID },
        },
      };

      expect(getAssignedPowerBankBoostLabId("task-d", RESOURCE_CATALYZED_UTRIUM_ACID)).toBe("lab-11");
    });

    it("returns undefined when task not found", () => {
      expect(getAssignedPowerBankBoostLabId("nonexistent", RESOURCE_CATALYZED_GHODIUM_ALKALIDE)).toBeUndefined();
    });

    it("returns undefined when compound not assigned", () => {
      Memory.runtime = {};
      const store = ensurePowerBankBoostPrepStore();
      store["task-e"] = {
        taskId: "task-e",
        sourceRoomName: SOURCE_ROOM,
        labs: {
          "lab-20": { labId: "lab-20", compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE },
        },
      };

      expect(getAssignedPowerBankBoostLabId("task-e", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE)).toBeUndefined();
    });
  });
});

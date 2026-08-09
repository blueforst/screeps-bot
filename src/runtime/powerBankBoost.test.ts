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
import {
  createAutomaticResourceTransferTask,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";
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

function setActiveSynthesisPlan(roomName: string): void {
  Memory.runtime = {
    synthesisControl: {
      updatedAt: Game.time,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: {
        [roomName]: {
          stage: "synthesizing",
          activeProduct: RESOURCE_UTRIUM_HYDRIDE,
          reagentA: RESOURCE_UTRIUM,
          reagentB: RESOURCE_HYDROGEN,
          targetAmount: 5_000,
          batchSize: 500,
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 10,
          pendingTasks: 0,
          lastTransitionAt: Game.time - 10,
        },
      },
    },
  } as NonNullable<Memory["runtime"]>;
}

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

      it("does not count another boost owner's incoming transfer toward this task", () => {
        const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
        const taskIdA = "pb-owner-a";
        const taskIdB = "pb-owner-b";
        const required = new Map<ResourceConstant, number>([[compound, 60]]);
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          labs: [createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0)],
        });

        const incomingForTaskA = createAutomaticResourceTransferTask(
          DONOR_ROOM,
          SOURCE_ROOM,
          compound,
          60,
          `powerBankBoost:${taskIdA}`,
        );
        expect(typeof incomingForTaskA).not.toBe("string");

        const result = prepareBoosts(taskIdB, SOURCE_ROOM, 6, required);

        expect(result).toMatchObject({ status: "failed", reason: "insufficient_boost_compound" });
        expect(ensurePowerBankBoostPrepStore()[taskIdB]).toBeUndefined();
        expect(
          Object.values(ensureResourceTransferTaskStore()).find(
            (task) => task.reason === `powerBankBoost:${taskIdA}`,
          )?.status,
        ).toBe("pending");
      });

      it("deducts pending outgoing transfers from donor availability", () => {
        const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
        Game.rooms[DONOR_ROOM] = createRoomWithInfrastructure({
          name: DONOR_ROOM,
          terminalResources: { [compound]: 100 },
        });

        const pendingOutgoing = createAutomaticResourceTransferTask(
          DONOR_ROOM,
          HUB_ROOM,
          compound,
          60,
          "powerBankBoost:another-owner",
        );
        expect(typeof pendingOutgoing).not.toBe("string");

        expect(findBestDonorRoom(compound, 50, [])).toBeNull();
        expect(findBestDonorRoom(compound, 40, [])).toBe(DONOR_ROOM);
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

      it("rolls back a zero-lab preparation in the same tick and restores synthesis", () => {
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          labs: [],
        });
        setActiveSynthesisPlan(SOURCE_ROOM);

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6);

        expect(result).toMatchObject({ status: "failed", reason: "insufficient_labs", labs: [] });
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);
        expect(Memory.runtime?.powerBankBoost?.[TASK_ID]).toBeUndefined();

        const synthesisState = Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM];
        expect(synthesisState?.boostPause).toBeUndefined();
        expect(synthesisState?.stage).toBe("synthesizing");
        expect(synthesisState?.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
        expect(synthesisState?.targetAmount).toBe(5_000);
        expect(synthesisState?.batchSize).toBe(500);
      });

      it("rolls back only the failed owner while another boost owner remains active", () => {
        const compounds: ResourceConstant[] = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ];
        const storageResources = Object.fromEntries(compounds.map((compound) => [compound, 5_000]));
        const labsA = compounds.map((_compound, index) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-a-${index}`, SOURCE_ROOM, null, 0)
        );
        const labsB = compounds.map((_compound, index) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-b-${index}`, SOURCE_ROOM, null, 0)
        );
        const taskIdA = "pb-owner-a";
        const taskIdB = "pb-owner-b";
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources,
          labs: [...labsA, ...labsB],
        });
        setActiveSynthesisPlan(SOURCE_ROOM);

        expect(prepareBoosts(taskIdA, SOURCE_ROOM, 6).status).toBe("preparing");
        expect(prepareBoosts(taskIdB, SOURCE_ROOM, 6).status).toBe("preparing");
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdA}`)).toBe(true);
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdB}`)).toBe(true);

        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources,
          labs: labsA,
        });
        const failed = prepareBoosts(taskIdB, SOURCE_ROOM, 6);

        expect(failed).toMatchObject({ status: "failed", reason: "insufficient_labs" });
        expect(ensurePowerBankBoostPrepStore()[taskIdA]).toBeDefined();
        expect(ensurePowerBankBoostPrepStore()[taskIdB]).toBeUndefined();
        expect(getActivePowerBankBoostLabIds(SOURCE_ROOM)).toEqual(new Set(labsA.map((lab) => lab.id)));
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdA}`)).toBe(true);
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdB}`)).toBe(false);
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(true);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].boostPause?.taskIds).toEqual([taskIdA]);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].activeProduct).toBeUndefined();

        releaseBoostLabs(taskIdA, SOURCE_ROOM);
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
      });

      it("does not commit partial donor transfers and cancels only failed-owner pending supply", () => {
        const firstCompound = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
        const missingCompound = RESOURCE_CATALYZED_UTRIUM_ACID;
        const unrelatedResource = RESOURCE_ZYNTHIUM;
        const required = new Map<ResourceConstant, number>([
          [firstCompound, 30],
          [missingCompound, 30],
        ]);
        const labs = [
          createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0),
          createLabWithCompound(`${SOURCE_ROOM}-lab-2`, SOURCE_ROOM, null, 0),
        ];
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs });
        Game.rooms[DONOR_ROOM] = createRoomWithInfrastructure({
          name: DONOR_ROOM,
          terminalResources: { [firstCompound]: 30 },
        });

        const failedOwnerTransfer = createAutomaticResourceTransferTask(
          DONOR_ROOM,
          SOURCE_ROOM,
          unrelatedResource,
          10,
          `powerBankBoost:${TASK_ID}`,
        );
        const otherOwnerTransfer = createAutomaticResourceTransferTask(
          DONOR_ROOM,
          SOURCE_ROOM,
          unrelatedResource,
          10,
          "powerBankBoost:other-owner",
        );
        expect(typeof failedOwnerTransfer).not.toBe("string");
        expect(typeof otherOwnerTransfer).not.toBe("string");

        const result = prepareBoosts(TASK_ID, SOURCE_ROOM, 6, required);

        expect(result).toMatchObject({ status: "failed", reason: "insufficient_boost_compound" });
        const transfers = Object.values(ensureResourceTransferTaskStore());
        expect(transfers.filter((task) => task.reason === `powerBankBoost:${TASK_ID}` && task.status === "pending")).toHaveLength(0);
        expect(transfers.find((task) => task.reason === `powerBankBoost:${TASK_ID}` && task.resource === firstCompound)).toBeUndefined();
        expect(transfers.find((task) => task.reason === "powerBankBoost:other-owner")?.status).toBe("pending");
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);
      });
    });
  });

  describe("checkBoostReadiness", () => {

    it("returns false when no prep memory exists for task", () => {
      expect(checkBoostReadiness(TASK_ID, [RESOURCE_CATALYZED_GHODIUM_ALKALIDE])).toBe(false);
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
});

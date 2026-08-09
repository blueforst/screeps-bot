jest.mock("@/runtime/resourceControl", () => ({
  collectResourceControlSnapshots: jest.fn(),
}));

import {
  clearCarrierTaskBoardForTest,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest } from "@/runtime/creepAssignmentState";
import {
  collectLiveMarketSaleProtectionLedger,
  type LiveManagedOrderExposure,
} from "@/runtime/marketSaleProtectionAdapter";
import { getMarketProtectionEntryKey } from "@/runtime/marketSaleProtection";
import {
  resolveMarketSaleAutomationConfig,
  type MarketSaleAutomationConfig,
} from "@/runtime/marketSaleConfig";
import { collectResourceControlSnapshots } from "@/runtime/resourceControl";
import {
  beginHubProtectionAttempt,
  buildCommittedHubProtectionSnapshot,
  publishCommittedHubProtectionSnapshot,
  type HubRuntimeProtectionExtension,
} from "@/runtime/hubProtectionSnapshot";

const ROOM = "W1N1";
const TICK = 1_000;
const mockedCollectResourceControlSnapshots =
  collectResourceControlSnapshots as jest.MockedFunction<
    typeof collectResourceControlSnapshots
  >;

function createStore(
  resources: Partial<Record<ResourceConstant, number>>,
): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity(resource?: ResourceConstant) {
      if (resource) return resources[resource] || 0;
      return Object.values(resources).reduce(
        (sum, amount) => sum + (amount || 0),
        0,
      );
    },
    getFreeCapacity() {
      return 300_000;
    },
    getCapacity() {
      return 300_000;
    },
  } as unknown as StoreDefinition;
}

function createRoom(
  name: string,
  storageResources: Partial<Record<ResourceConstant, number>>,
  terminalResources: Partial<Record<ResourceConstant, number>>,
  withFactory = false,
): Room {
  const factory = withFactory
    ? ({
        id: `${name}-factory`,
        structureType: STRUCTURE_FACTORY,
        level: 0,
        cooldown: 0,
        store: createStore({}),
      } as unknown as StructureFactory)
    : undefined;
  return {
    name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: createStore(storageResources),
    } as unknown as StructureStorage,
    terminal: {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: createStore(terminalResources),
    } as unknown as StructureTerminal,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) {
        return factory ? [factory] : [];
      }
      return [];
    },
  } as unknown as Room;
}

function config(
  forecast: Partial<Record<ResourceConstant, number>>,
): MarketSaleAutomationConfig {
  const resolved = resolveMarketSaleAutomationConfig({
    mode: "shadow",
    configRevision: "test-r1",
    sellResources: [RESOURCE_KEANIUM],
    hardFloor: { [RESOURCE_KEANIUM]: 1 },
    forecastBuffer: {
      [RESOURCE_KEANIUM]: 100,
      ...forecast,
    },
    minDealAmount: 100,
    makerBatchAmount: 100,
    creditReserve: 0,
  });
  resolved.forecastBuffer = { ...forecast };
  return resolved;
}

function mockFloors(
  floorsByRoom: Record<string, Partial<Record<ResourceConstant, number>>>,
): void {
  mockedCollectResourceControlSnapshots.mockReturnValue(
    Object.entries(floorsByRoom).map(([roomName, mineralFloor]) => ({
      roomName,
      mineralFloor,
      mineralExportStart: { ...mineralFloor },
    })) as ReturnType<typeof collectResourceControlSnapshots>,
  );
}

function commitCurrentHubProtection(
  planMode: "distributed" | "fallback" | "blocked" = "distributed",
): void {
  const cfg = Memory.cfg?.hub;
  const runtime = Memory.runtime?.hub;
  if (!cfg || !runtime) throw new Error("Hub test fixture is incomplete");
  const extended = runtime as typeof runtime & HubRuntimeProtectionExtension;
  const attempt = beginHubProtectionAttempt(extended, cfg, Game.time);
  const snapshot = buildCommittedHubProtectionSnapshot({
    revision: attempt.attemptRevision,
    configIncarnation: attempt.configIncarnation,
    tick: Game.time,
    expiresAt: Game.time + Math.max(1, cfg.planInterval || 50),
    config: cfg,
    runtime,
    synthesisRooms: Memory.cfg?.synthesisControl?.rooms ?? {},
    transferTasks: Memory.data?.resourceControl?.tasks ?? {},
    planMode,
  });
  publishCommittedHubProtectionSnapshot(extended, attempt, snapshot);
}

beforeEach(() => {
  clearCarrierTaskBoardForTest();
  clearCreepAssignmentStateForTest();
  mockedCollectResourceControlSnapshots.mockReset();
  Game.time = TICK;
  Game.rooms = {};
  Game.creeps = {};
  (Game as unknown as { market: Partial<Market> }).market = {
    orders: {},
  };
  Memory.cfg = {
    resourceControl: {
      capacityBalancing: {
        automaticTaskNoProgressTtl: 5_000,
      },
    },
  };
  Memory.runtime = {
    resourceControl: {
      updatedAt: TICK,
      rooms: {},
      lastActions: [],
      lastMarketActions: [],
    },
  };
  Memory.data = {
    resourceControl: {
      tasks: {},
    },
  };
});

describe("collectLiveMarketSaleProtectionLedger", () => {

  it("deduplicates matching Synthesis and Hub dispatch plans while keeping different products separate", () => {
    const secondRoom = "W2N2";
    Game.rooms[ROOM] = createRoom(ROOM, {}, {});
    Game.rooms[secondRoom] = createRoom(
      secondRoom,
      { [RESOURCE_KEANIUM]: 5_000 },
      { [RESOURCE_KEANIUM]: 5_000 },
    );
    mockFloors({
      [ROOM]: {},
      [secondRoom]: { [RESOURCE_KEANIUM]: 0 },
    });
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [secondRoom]: {
          enabled: true,
        },
      },
    };
    Memory.runtime!.synthesisControl = {
      updatedAt: TICK,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: {
        [secondRoom]: {
          stage: "synthesizing",
          activeProduct: RESOURCE_KEANIUM_HYDRIDE,
          reagentA: RESOURCE_KEANIUM,
          reagentB: RESOURCE_HYDROGEN,
          targetAmount: 400,
          batchSize: 400,
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 0,
          pendingTasks: 0,
          lastTransitionAt: TICK,
        },
      },
    };
    Memory.cfg!.hub = {
      enabled: true,
      hubRoomName: ROOM,
      planInterval: 200,
      targetCompounds: [],
    };
    Memory.runtime!.hub = {
      updatedAt: TICK,
      needsPlan: false,
      distributedSynthesis: {
        allocationLedger: {
          K: {
            resource: RESOURCE_KEANIUM,
            totalAmount: 5_000,
            roomCommitments: { [secondRoom]: 5_000 },
          },
        },
        dispatchAssignments: [
          {
            roomName: secondRoom,
            product: RESOURCE_KEANIUM_HYDRIDE,
            targetAmount: 400,
            isHubRoom: false,
          },
          {
            roomName: secondRoom,
            product: RESOURCE_KEANIUM_OXIDE,
            targetAmount: 300,
            isHubRoom: false,
          },
        ],
      },
    };
    commitCurrentHubProtection();

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      undefined,
      {
        candidates: [
          { roomName: secondRoom, resource: RESOURCE_KEANIUM },
        ],
      },
    );
    const keanium =
      ledger.entries[getMarketProtectionEntryKey(secondRoom, RESOURCE_KEANIUM)];
    const productionContributions = keanium.sourceContributions.filter(
      (contribution) => contribution.bucket === "consumptiveDemand",
    );

    expect(keanium.blocked).toBe(false);
    expect(keanium.productionDemand).toBe(700);
    expect(productionContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableKey: `synthesis:plan:${secondRoom}:${RESOURCE_KEANIUM_HYDRIDE}:reagent:${RESOURCE_KEANIUM}`,
          amount: 400,
          sourceKinds: ["synthesisActive", "hub"],
        }),
        expect.objectContaining({
          stableKey: `synthesis:plan:${secondRoom}:${RESOURCE_KEANIUM_OXIDE}:reagent:${RESOURCE_KEANIUM}`,
          amount: 300,
          sourceKinds: ["hub"],
        }),
      ]),
    );
    expect(productionContributions).toHaveLength(2);
  });

  it("keeps Hub room stock fully protected without an explicit market surplus", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      { [RESOURCE_KEANIUM]: 5_000 },
      { [RESOURCE_KEANIUM]: 5_000 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.cfg!.hub = {
      enabled: true,
      hubRoomName: ROOM,
      planInterval: 200,
      targetCompounds: [],
    };
    Memory.runtime!.hub = {
      updatedAt: TICK,
      needsPlan: false,
      distributedSynthesis: {
        allocationLedger: {
          K: {
            resource: RESOURCE_KEANIUM,
            totalAmount: 5_000,
            roomCommitments: { [ROOM]: 5_000 },
          },
        },
      },
      // A forged legacy surplus must not be consumed by the adapter.
      marketSellSurplus: {
        [RESOURCE_KEANIUM]: 9_999,
      },
    };
    commitCurrentHubProtection("fallback");

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      undefined,
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
      },
    );
    const keanium =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(keanium.blocked).toBe(false);
    expect(keanium.productionDemand).toBe(10_000);
    expect(keanium.sellableAmount).toBe(0);
    expect(keanium.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableKey: `hub:surplus-limit:${ROOM}:${RESOURCE_KEANIUM}`,
          amount: 10_000,
          sourceKinds: ["hub"],
        }),
      ]),
    );
  });

  it("protects an active PowerBank task before its boost prep memory is created", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      {},
      { [RESOURCE_KEANIUM]: 8_000 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.data!.powerBankHarvest = {
      "pb-gap": {
        id: "pb-gap",
        status: "preparing_boosts",
        sourceRoom: ROOM,
        targetRoom: "W9N9",
        bankId: "bank-1",
        bankPos: { x: 25, y: 25 },
        hits: 1_000_000,
        power: 5_000,
        ticksToDecay: 4_000,
        freeTiles: 2,
        discoveredTick: TICK - 1,
        lastSeenTick: TICK,
        haulerIds: [],
        boostLabs: [],
        compoundTransferTaskIds: [],
        tier: 8,
      },
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(Memory.runtime?.powerBankBoost).toBeUndefined();
    expect(entry.fresh).toBe(true);
    expect(entry.productionDemand).toBe(3_000);
    expect(entry.sellableAmount).toBe(4_900);
    expect(entry.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableKey: expect.stringContaining("boost-contract:pb-gap:"),
          sourceKinds: ["boost"],
          amount: 3_000,
        }),
      ]),
    );
  });
});

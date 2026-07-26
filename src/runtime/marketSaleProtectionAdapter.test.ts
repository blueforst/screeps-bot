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
  it("collects stock, floor, forecast, reservation, transfer, carrier and managed exposure", () => {
    const room = createRoom(
      ROOM,
      { [RESOURCE_KEANIUM]: 1_400 },
      { [RESOURCE_KEANIUM]: 600 },
    );
    Game.rooms[ROOM] = room;
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 500 } });
    Memory.runtime!.resourceReservations = {
      [`${ROOM}:${RESOURCE_KEANIUM}:factory-a`]: {
        roomName: ROOM,
        resource: RESOURCE_KEANIUM,
        holderId: "factory-a",
        amount: 100,
        updatedAt: TICK,
        expiresAt: TICK + 10,
      },
    };
    Memory.data!.resourceControl!.tasks = {
      "transfer-1": {
        id: "transfer-1",
        resource: RESOURCE_KEANIUM,
        fromRoomName: ROOM,
        toRoomName: "W1N2",
        amount: 200,
        remainingAmount: 200,
        status: "pending",
        createdAt: TICK,
        updatedAt: TICK,
        origin: "manual",
        lastProgressAt: TICK,
        blockedReason: "receiver_capacity",
      },
    };
    replaceCarrierTasksForProducerRoom("test", ROOM, [
      {
        id: "carrier-task-1",
        type: "terminal_feed",
        priority: 100,
        steps: [
          {
            id: "carrier-step-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "storage",
            toKind: "terminal",
            fromId: room.storage!.id,
            toId: room.terminal!.id,
            amount: 100,
          },
        ],
      },
    ]);
    const managed: LiveManagedOrderExposure[] = [
      {
        orderId: "managed-1",
        roomName: ROOM,
        resourceType: RESOURCE_KEANIUM,
        remainingExposure: 100,
      },
    ];

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      managed,
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
      },
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(entry.blocked).toBe(false);
    expect(entry.totalStock).toBe(2_000);
    expect(entry.terminalStock).toBe(600);
    expect(entry.hardReserve).toBe(500);
    expect(entry.forecastBuffer).toBe(100);
    expect(entry.protectedOutgoing).toBe(300);
    expect(entry.carrierOrInFlight).toBe(100);
    expect(entry.managedExposure).toBe(100);
    expect(entry.sellableAmount).toBe(500);
  });

  it("re-observes durable transfer and carrier state between ResourceControl sample ticks", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      { [RESOURCE_KEANIUM]: 1_000 },
      { [RESOURCE_KEANIUM]: 500 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 500 } });
    Memory.runtime!.resourceControl!.updatedAt = TICK - 1;

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      undefined,
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
      },
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(entry.sellableAmount).toBe(500);
    expect(entry.blockedReasons).not.toContain("protection_stale");
    expect(entry.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKind: "blockedOutgoing" }),
        expect.objectContaining({ sourceKind: "carrierInFlight" }),
      ]),
    );
  });

  it.each([
    ["missing", {}],
    ["zero", { [RESOURCE_KEANIUM]: 0 }],
    ["non-finite", { [RESOURCE_KEANIUM]: Number.NaN }],
    ["below safe batch", { [RESOURCE_KEANIUM]: 99 }],
  ] as const)(
    "fails the candidate closed when forecast buffer is %s even if config validity is forged",
    (_label, forecastBuffer) => {
      Game.rooms[ROOM] = createRoom(
        ROOM,
        { [RESOURCE_KEANIUM]: 10_000 },
        { [RESOURCE_KEANIUM]: 5_000 },
      );
      mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 500 } });
      const unsafeConfig = config({ [RESOURCE_KEANIUM]: 100 });
      unsafeConfig.forecastBuffer = { ...forecastBuffer };
      unsafeConfig.validForPlanning = true;
      unsafeConfig.invalidReasons = [];

      const ledger = collectLiveMarketSaleProtectionLedger(
        unsafeConfig,
        undefined,
        {
          candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
        },
      );
      const entry =
        ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

      expect(entry.sellableAmount).toBe(0);
      expect(entry.blockedReasons).toEqual(
        expect.arrayContaining(["protection_stale", "forecast_missing"]),
      );
      expect(entry.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "protection_stale",
            sourceKind: "forecast",
          }),
          expect.objectContaining({
            code: "forecast_missing",
            sourceKind: "forecast",
          }),
        ]),
      );
    },
  );

  it("uses X/H/Z permit lane reserves once and takes the maximum local floor", () => {
    const lanes = [
      {
        roomName: "E6N59",
        resource: RESOURCE_CATALYST,
        laneReserve: 100_000,
      },
      {
        roomName: "E3N59",
        resource: RESOURCE_HYDROGEN,
        laneReserve: 110_000,
      },
      {
        roomName: "E7N57",
        resource: RESOURCE_ZYNTHIUM,
        laneReserve: 120_000,
      },
    ] as const;
    for (const lane of lanes) {
      Game.rooms[lane.roomName] = createRoom(
        lane.roomName,
        { [lane.resource]: 150_000 },
        { [lane.resource]: 50_000 },
      );
    }
    mockedCollectResourceControlSnapshots.mockReturnValue(
      lanes.map((lane) => ({
        roomName: lane.roomName,
        mineralFloor: { [lane.resource]: 20_000 },
        mineralExportStart: { [lane.resource]: 80_000 },
      })) as ReturnType<typeof collectResourceControlSnapshots>,
    );
    Memory.cfg!.factoryControl = {
      enabled: false,
      resourceFloors: {
        [RESOURCE_CATALYST]: 90_000,
        [RESOURCE_HYDROGEN]: 95_000,
        [RESOURCE_ZYNTHIUM]: 99_000,
      },
    };
    Memory.data!.marketSaleAutomation = {
      managedOrders: {},
      pendingMutations: {},
      directAutomation: {
        schemaVersion: 2,
        currentPermit: {
          executionTable: lanes.map((lane, index) => ({
            entryId: `lane-${index}`,
            resourceType: lane.resource,
            allowedRoomNames: [lane.roomName],
            laneReserve: lane.laneReserve,
          })),
        },
      },
    } as never;
    const cfg = config({});
    cfg.sellResources = lanes.map((lane) => lane.resource);
    cfg.validForPlanning = true;

    const ledger = collectLiveMarketSaleProtectionLedger(cfg, undefined, {
      candidates: lanes.map(({ roomName, resource }) => ({
        roomName,
        resource,
      })),
    });

    for (const lane of lanes) {
      const entry =
        ledger.entries[
          getMarketProtectionEntryKey(lane.roomName, lane.resource)
        ];
      expect(entry.blocked).toBe(false);
      expect(entry.hardReserve).toBe(
        lane.resource === RESOURCE_CATALYST
          ? 90_000
          : lane.resource === RESOURCE_HYDROGEN
            ? 95_000
            : 99_000,
      );
      expect(entry.forecastBuffer).toBe(lane.laneReserve);
      expect(entry.localReserve).toBe(lane.laneReserve);
      expect(entry.protectedAmount).toBe(lane.laneReserve);
      expect(entry.sellableAmount).toBe(50_000);
    }
  });

  it("collects Factory components plus active and paused synthesis plans", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      {
        [RESOURCE_ENERGY]: 5_000,
        [RESOURCE_HYDROGEN]: 2_000,
        [RESOURCE_BATTERY]: 100,
      },
      {
        [RESOURCE_ENERGY]: 2_000,
        [RESOURCE_HYDROGEN]: 1_000,
        [RESOURCE_BATTERY]: 50,
      },
      true,
    );
    mockFloors({
      [ROOM]: {
        [RESOURCE_ENERGY]: 0,
        [RESOURCE_HYDROGEN]: 0,
        [RESOURCE_BATTERY]: 0,
      },
    });
    Memory.cfg!.factoryControl = {
      enabled: true,
      targets: [
        {
          resource: RESOURCE_BATTERY,
          targetAmount: 50,
        },
      ],
    };
    Memory.runtime!.factoryControl = {
      updatedAt: TICK,
      rooms: {
        [ROOM]: {
          stage: "loading",
          activeTarget: RESOURCE_BATTERY,
          lastTransitionAt: TICK,
        },
      },
    };
    Memory.data!.factoryTasks = {
      "factory-task-1": {
        id: "factory-task-1",
        roomName: ROOM,
        type: "decompress_battery",
        status: "pending",
        requestedBatteryAmount: 50,
        remainingBatteryAmount: 50,
        producedEnergyAmount: 0,
        createdAt: TICK,
        updatedAt: TICK,
      },
    };
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [ROOM]: {
          reactions: [
            {
              product: RESOURCE_HYDROXIDE,
              targetAmount: 200,
            },
          ],
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
        [ROOM]: {
          stage: "loading",
          activeProduct: RESOURCE_HYDROXIDE,
          reagentA: RESOURCE_HYDROGEN,
          reagentB: RESOURCE_OXYGEN,
          targetAmount: 200,
          batchSize: 200,
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 0,
          pendingTasks: 0,
          lastTransitionAt: TICK,
          boostPause: {
            reason: "powerBankBoost",
            taskId: "boost-1",
            createdTick: TICK,
            pausedPlan: {
              product: RESOURCE_UTRIUM_HYDRIDE,
              targetAmount: 100,
              batchSize: 100,
              donorRoomNames: [],
            },
            pausedStage: "loading",
          },
        },
      },
    };
    const cfg = config({
      [RESOURCE_ENERGY]: 100,
      [RESOURCE_HYDROGEN]: 100,
      [RESOURCE_BATTERY]: 100,
    });
    const ledger = collectLiveMarketSaleProtectionLedger(cfg, undefined, {
      candidates: [
        { roomName: ROOM, resource: RESOURCE_ENERGY },
        { roomName: ROOM, resource: RESOURCE_HYDROGEN },
        { roomName: ROOM, resource: RESOURCE_BATTERY },
      ],
    });

    const energy =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_ENERGY)];
    const hydrogen =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_HYDROGEN)];
    const battery =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_BATTERY)];

    // Factory components are derived from the remaining target gap. Battery is
    // already above its absolute target in this fixture, so no extra energy is
    // reserved for a redundant production batch.
    expect(
      energy.sourceContributions.some((contribution) =>
        contribution.sourceKinds.includes("factoryComponents"),
      ),
    ).toBe(false);
    expect(hydrogen.productionDemand).toBe(300);
    expect(hydrogen.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKinds: ["synthesisActive"],
        }),
        expect.objectContaining({
          sourceKinds: ["synthesisPaused"],
        }),
      ]),
    );
    expect(battery.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKinds: ["factoryTargets"],
        }),
        expect.objectContaining({
          sourceKinds: ["factoryTasks"],
        }),
      ]),
    );
  });

  it("blocks a fully scoped unbound synthesis donor lane before transfer creation", () => {
    const targetRoomName = "W9N9";
    const donorRoomName = "E6N59";
    Game.rooms[targetRoomName] = createRoom(targetRoomName, {}, {});
    Game.rooms[donorRoomName] = createRoom(
      donorRoomName,
      { [RESOURCE_CATALYST]: 150_000 },
      { [RESOURCE_CATALYST]: 50_000 },
    );
    mockFloors({
      [donorRoomName]: { [RESOURCE_CATALYST]: 20_000 },
    });
    Memory.cfg!.synthesisControl = {
      enabled: true,
      rooms: {
        [targetRoomName]: {
          reactions: [
            {
              product: RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
              targetAmount: 1_000,
              donorRoomNames: [donorRoomName],
            },
          ],
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
        [targetRoomName]: {
          stage: "idle",
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 0,
          pendingTasks: 0,
          lastTransitionAt: TICK,
        },
      },
    };
    const cfg = config({ [RESOURCE_CATALYST]: 100 });
    cfg.sellResources = [RESOURCE_CATALYST];

    const ledger = collectLiveMarketSaleProtectionLedger(cfg, undefined, {
      candidates: [
        { roomName: donorRoomName, resource: RESOURCE_CATALYST },
      ],
    });
    const entry =
      ledger.entries[
        getMarketProtectionEntryKey(donorRoomName, RESOURCE_CATALYST)
      ];

    expect(ledger.globalBlocked).toBe(false);
    expect(entry.blockedReasons).toContain("protection_donor_unbound");
    expect(entry.sellableAmount).toBe(0);

    (
      Memory.cfg!.synthesisControl!.rooms![targetRoomName]!.reactions![0] as {
        donorRoomNames: string[];
      }
    ).donorRoomNames = ["W99N99"];
    const incomplete = collectLiveMarketSaleProtectionLedger(
      cfg,
      undefined,
      {
        candidates: [
          { roomName: donorRoomName, resource: RESOURCE_CATALYST },
        ],
      },
    );
    expect(incomplete.globalBlocked).toBe(true);
    expect(incomplete.globalIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "protection_stale",
          sourceKind: "synthesisActive",
        }),
      ]),
    );
  });

  it("does not treat Hub residual allocation as demand while collecting Boost and War commitments", () => {
    const secondRoom = "W2N2";
    Game.rooms[ROOM] = createRoom(ROOM, {}, {});
    Game.rooms[secondRoom] = createRoom(
      secondRoom,
      {
        [RESOURCE_KEANIUM]: 2_000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 5_000,
      },
      {
        [RESOURCE_KEANIUM]: 500,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 1_000,
      },
    );
    mockFloors({
      [ROOM]: {},
      [secondRoom]: {
        [RESOURCE_KEANIUM]: 0,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 0,
      },
    });
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
            totalAmount: 250,
            roomCommitments: { [secondRoom]: 250 },
          },
        },
      },
    };
    Memory.cfg!.homeDefense = {
      boostTarget: 1_000,
      rooms: {
        [secondRoom]: { boostLabId: "lab-1" },
      },
    };
    Memory.data!.war = {
      target: {
        targetRoom: "W9N9",
        sourceRoom: secondRoom,
        status: "staging",
        reason: "manual",
        squad: "t3Duo",
        boostTier: "t3",
        attempts: 0,
        createdAt: TICK,
        updatedAt: TICK,
      },
    };
    const cfg = config({
      [RESOURCE_KEANIUM]: 100,
      [RESOURCE_CATALYZED_UTRIUM_ACID]: 100,
    });
    const ledger = collectLiveMarketSaleProtectionLedger(cfg, undefined, {
      candidates: [
        { roomName: secondRoom, resource: RESOURCE_KEANIUM },
        {
          roomName: secondRoom,
          resource: RESOURCE_CATALYZED_UTRIUM_ACID,
        },
      ],
    });

    const keanium =
      ledger.entries[getMarketProtectionEntryKey(secondRoom, RESOURCE_KEANIUM)];
    const boost =
      ledger.entries[
        getMarketProtectionEntryKey(secondRoom, RESOURCE_CATALYZED_UTRIUM_ACID)
      ];

    expect(keanium.productionDemand).toBe(3_000);
    expect(keanium.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKinds: ["war"] }),
      ]),
    );
    expect(
      keanium.sourceContributions.some((contribution) =>
        contribution.sourceKinds.includes("hub"),
      ),
    ).toBe(false);
    expect(boost.productionDemand).toBe(4_000);
    expect(boost.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKinds: ["boost"] }),
        expect.objectContaining({ sourceKinds: ["war"] }),
      ]),
    );
  });

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
      marketSellSurplus: {},
    };

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

  it("recursively expands active boost and war T3 demand into all base minerals without duplicate lab demand", () => {
    const roomName = "W2N2";
    const stocks: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_KEANIUM]: 5_000,
      [RESOURCE_UTRIUM]: 12_000,
      [RESOURCE_LEMERGIUM]: 10_000,
      [RESOURCE_ZYNTHIUM]: 9_000,
      [RESOURCE_HYDROGEN]: 40_000,
      [RESOURCE_OXYGEN]: 17_000,
      [RESOURCE_CATALYST]: 16_000,
    };
    const baseResources = Object.keys(stocks) as ResourceConstant[];
    const zeroes = Object.fromEntries(
      baseResources.map((resource) => [resource, 0]),
    ) as Partial<Record<ResourceConstant, number>>;
    const safeForecast = Object.fromEntries(
      baseResources.map((resource) => [resource, 100]),
    ) as Partial<Record<ResourceConstant, number>>;
    Game.rooms[roomName] = createRoom(roomName, {}, stocks);
    mockFloors({ [roomName]: zeroes });
    Memory.cfg!.homeDefense = {
      boostTarget: 1_000,
      rooms: {
        [roomName]: { boostLabId: "defense-lab" },
      },
    };
    Memory.runtime!.powerBankBoost = {
      "pb-1": {
        taskId: "pb-1",
        sourceRoomName: roomName,
        labs: {
          "pb-lab-a": {
            labId: "pb-lab-a",
            compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          },
          "pb-lab-b": {
            labId: "pb-lab-b",
            compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          },
        },
      },
    };
    Memory.data!.war = {
      "war-1": {
        targetRoom: "W9N9",
        sourceRoom: roomName,
        status: "staging",
        reason: "manual",
        squad: "t3Duo",
        boostTier: "t3",
        attempts: 0,
        createdAt: TICK,
        updatedAt: TICK,
      },
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config(safeForecast),
      undefined,
      {
        candidates: baseResources.map((resource) => ({
          roomName,
          resource,
        })),
      },
    );
    const expectedDemand: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_KEANIUM]: 6_000,
      [RESOURCE_UTRIUM]: 10_000,
      [RESOURCE_LEMERGIUM]: 9_000,
      [RESOURCE_ZYNTHIUM]: 9_000,
      [RESOURCE_HYDROGEN]: 20_000,
      [RESOURCE_OXYGEN]: 28_000,
      [RESOURCE_CATALYST]: 16_000,
    };

    for (const resource of baseResources) {
      const entry =
        ledger.entries[getMarketProtectionEntryKey(roomName, resource)];
      expect(entry.fresh).toBe(true);
      expect(entry.productionDemand).toBe(expectedDemand[resource]);
      expect(entry.sellableAmount).toBe(
        Math.max(
          0,
          (stocks[resource] || 0) - (expectedDemand[resource] || 0) - 100,
        ),
      );
      expect(entry.sourceContributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceKinds: ["boost"] }),
          expect.objectContaining({ sourceKinds: ["war"] }),
        ]),
      );
    }

    const keanium =
      ledger.entries[getMarketProtectionEntryKey(roomName, RESOURCE_KEANIUM)];
    expect(
      keanium.sourceContributions.filter(({ sourceKinds }) =>
        sourceKinds.includes("boost"),
      ),
    ).toHaveLength(1);
    expect(keanium.sellableAmount).toBe(0);
    expect(
      ledger.entries[getMarketProtectionEntryKey(roomName, RESOURCE_CATALYST)]
        .sellableAmount,
    ).toBe(0);
  });

  it("treats homeDefense boostTarget=0 like BoostControl and protects the default target", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      {},
      { [RESOURCE_UTRIUM]: 5_000 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_UTRIUM]: 0 } });
    Memory.cfg!.homeDefense = {
      boostTarget: 0,
      rooms: {
        [ROOM]: { boostLabId: "defense-lab" },
      },
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_UTRIUM]: 100 }),
      undefined,
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_UTRIUM }],
      },
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_UTRIUM)];

    expect(entry.fresh).toBe(true);
    expect(entry.productionDemand).toBe(1_000);
    expect(entry.sellableAmount).toBe(3_900);
    expect(entry.sourceContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKinds: ["boost"], amount: 1_000 }),
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

  it("deduplicates one War generation against its powerBankBoost prep contract", () => {
    const roomName = "W2N2";
    const boostTaskId = `war:${roomName}:W9N9:g1`;
    Game.rooms[roomName] = createRoom(
      roomName,
      {},
      { [RESOURCE_KEANIUM]: 8_000 },
    );
    mockFloors({ [roomName]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.runtime!.powerBankBoost = {
      [boostTaskId]: {
        taskId: boostTaskId,
        sourceRoomName: roomName,
        labs: {
          "tough-lab": {
            labId: "tough-lab",
            compound: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          },
        },
      },
    };
    Memory.data!.war = {
      W9N9: {
        targetRoom: "W9N9",
        sourceRoom: roomName,
        status: "staging",
        reason: "manual",
        squad: "t3Duo",
        boostTier: "t3",
        attempts: 1,
        createdAt: TICK - 10,
        updatedAt: TICK,
        activeGeneration: {
          id: 1,
          phase: "preparing",
          createdAt: TICK - 1,
          boostTaskId,
          configNames: {
            meleeAttacker: "war-melee",
            healer: "war-healer",
          },
        },
      },
    };

    const entry = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      undefined,
      {
        candidates: [{ roomName, resource: RESOURCE_KEANIUM }],
      },
    ).entries[getMarketProtectionEntryKey(roomName, RESOURCE_KEANIUM)];
    const productionContributions = entry.sourceContributions.filter(
      ({ bucket }) => bucket === "boostWar",
    );

    expect(entry.fresh).toBe(true);
    expect(entry.productionDemand).toBe(3_000);
    expect(productionContributions).toHaveLength(1);
    expect(productionContributions[0]).toMatchObject({
      stableKey: expect.stringContaining(`boost-contract:${boostTaskId}:`),
      amount: 3_000,
      sourceKinds: ["boost", "war"],
    });
  });

  it("fails the boost source closed when an active recipe cannot be explained", () => {
    Game.rooms[ROOM] = createRoom(ROOM, {}, { [RESOURCE_KEANIUM]: 5_000 });
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.runtime!.powerBankBoost = {
      "pb-invalid": {
        taskId: "pb-invalid",
        sourceRoomName: ROOM,
        labs: {
          "pb-lab": {
            labId: "pb-lab",
            compound: "unknown-t3" as ResourceConstant,
          },
        },
      },
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(entry.blocked).toBe(true);
    expect(entry.sellableAmount).toBe(0);
    expect(entry.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "protection_stale",
          sourceKind: "boost",
        }),
      ]),
    );
  });

  it("fails the boost source closed when an active demand amount is invalid", () => {
    Game.rooms[ROOM] = createRoom(ROOM, {}, { [RESOURCE_KEANIUM]: 5_000 });
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.cfg!.homeDefense = {
      boostTarget: Number.NaN,
      rooms: {
        [ROOM]: { boostLabId: "defense-lab" },
      },
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(entry.blocked).toBe(true);
    expect(entry.sellableAmount).toBe(0);
    expect(entry.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "protection_stale",
          sourceKind: "boost",
        }),
      ]),
    );
  });

  it("deduplicates a managed order and its pending mutation at the larger exposure", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      { [RESOURCE_KEANIUM]: 2_000 },
      { [RESOURCE_KEANIUM]: 1_000 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.data!.marketSaleAutomation = {
      managedOrders: {},
      pendingMutations: {
        "managed-1": {
          kind: "cancel",
          orderId: "managed-1",
          requestedAt: TICK,
          pre: {
            price: 1,
            totalAmount: 300,
            remainingAmount: 300,
          },
          requested: {},
          prospectiveFeeMilli: 0,
          conservativeExposure: 300,
          status: "submitted",
        },
      },
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      [
        {
          orderId: "managed-1",
          roomName: ROOM,
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: 200,
        },
      ],
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
      },
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(entry.blocked).toBe(false);
    expect(entry.managedExposure).toBe(300);
    expect(
      entry.sourceContributions.filter(
        (contribution) => contribution.stableKey === "managed-order:managed-1",
      ),
    ).toHaveLength(1);
  });

  it("把 active Direct pending 计入生产保护 exposure", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      { [RESOURCE_KEANIUM]: 2_000 },
      { [RESOURCE_KEANIUM]: 1_000 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.data!.marketSaleAutomation = {
      managedOrders: {},
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
    };
    (
      Memory.data!.marketSaleAutomation as typeof Memory.data.marketSaleAutomation & {
        pendingDirectDeals: Record<string, unknown>;
      }
    ).pendingDirectDeals = {
      direct: {
        status: "submitted",
        canaryRoomName: ROOM,
        resource: RESOURCE_KEANIUM,
        dealAmount: 600,
      },
    };

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      undefined,
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
      },
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(entry.blocked).toBe(false);
    expect(entry.managedExposure).toBe(600);
    expect(entry.sellableAmount).toBe(400);
  });

  it("Direct quarantine 无法安全归属时全局阻断卖出候选", () => {
    Game.rooms[ROOM] = createRoom(
      ROOM,
      { [RESOURCE_KEANIUM]: 2_000 },
      { [RESOURCE_KEANIUM]: 1_000 },
    );
    mockFloors({ [ROOM]: { [RESOURCE_KEANIUM]: 0 } });
    Memory.data!.marketSaleAutomation = {
      managedOrders: {},
      pendingMutations: {},
      feeEvents: [],
      carriedFeeDebtMilli: {},
      trustedFloors: {},
      processedTransactionKeys: [],
      operatorAudit: [],
      directAutomation: {
        quarantinedPendingDirectDeals: {
          "direct-bad": null,
        },
      },
    } as unknown as NonNullable<
      NonNullable<Memory["data"]>["marketSaleAutomation"]
    >;

    const ledger = collectLiveMarketSaleProtectionLedger(
      config({ [RESOURCE_KEANIUM]: 100 }),
      undefined,
      {
        candidates: [{ roomName: ROOM, resource: RESOURCE_KEANIUM }],
      },
    );
    const entry =
      ledger.entries[getMarketProtectionEntryKey(ROOM, RESOURCE_KEANIUM)];

    expect(ledger.globalBlocked).toBe(true);
    expect(entry.blocked).toBe(true);
    expect(entry.sellableAmount).toBe(0);
    expect(entry.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "protection_stale",
          sourceKind: "managedExposure",
        }),
      ]),
    );
  });
});

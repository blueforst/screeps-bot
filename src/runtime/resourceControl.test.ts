import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";
import * as carrierTaskBoard from "@/runtime/carrierTaskBoard";
import {
  createAutomaticResourceTransferTask,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  markResourceTransferTaskBlocked,
} from "@/runtime/logistics/resourceTransferTasks";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import { reserveProductionResource } from "@/runtime/resourceReservation";
import * as marketBaseResourceAutomationModule from "@/runtime/marketBaseResourceAutomation";
import {
  createResourceControlTransferContext,
  LEGACY_RESOURCE_CONTROL_SELLER_PERMANENTLY_DISABLED,
  type MarketTerminalEnergyReadinessAuthorizationProjection,
  normalizeCapacityConfig,
  parseMarketTerminalEnergyReadinessAuthorization,
  runResourceControl,
} from "@/runtime/resourceControl";
import { runMarketSalePreflight } from "@/runtime/marketSaleAutomation";
import {
  LEGACY_X_V1_OUTCOME_GOLDEN,
  acceptMarketDirectContinuousPermit,
  migrateLegacyDirectToContinuous,
  proposeMarketDirectContinuousPermit,
  type MarketDirectContinuousAutomationState,
} from "@/runtime/marketDirectContinuousAutomation";
import { LEGACY_X_PROCESSED_EVIDENCE_KEY } from "@/runtime/marketDirectContinuousLedger";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";
import { createDirectAutomationState } from "@/runtime/marketSaleDirectAutomation";
import {
  clearMarketActionArbiterForTest,
  executeTerminalSend,
  getMarketActionJournal,
} from "@/runtime/marketActionArbiter";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type GameWithPartialMarket = Omit<Game, "market"> & {
  market: Partial<Market>;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(options: {
  name: string;
  storageResources?: Partial<Record<ResourceConstant, number>>;
  terminalResources?: Partial<Record<ResourceConstant, number>>;
  nativeMineralType?: MineralConstant;
  hasExtractor?: boolean;
  storageFreeCapacity?: number;
}): Room {
  const storageResources = options.storageResources ?? {};
  const terminalResources = options.terminalResources ?? {};
  const storageFreeCapacity = options.storageFreeCapacity ?? 1_000_000;
  const nativeMineral = options.nativeMineralType
    ? ({
        id: `${options.name}-mineral`,
        mineralType: options.nativeMineralType,
      } as Mineral)
    : null;
  const extractor =
    nativeMineral && options.hasExtractor !== false
      ? ({
          id: `${options.name}-extractor`,
          structureType: STRUCTURE_EXTRACTOR,
        } as StructureExtractor)
      : null;
  const room = {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        ...storageResources,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(storageResources).reduce(
              (sum, value) => sum + (value || 0),
              0,
            );
          }
          return storageResources[resource] || 0;
        },
        getFreeCapacity: () => storageFreeCapacity,
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      send: jest.fn(() => OK),
      store: {
        ...terminalResources,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(terminalResources).reduce(
              (sum, value) => sum + (value || 0),
              0,
            );
          }
          return terminalResources[resource] || 0;
        },
        getFreeCapacity: (resource?: ResourceConstant) => {
          const used = resource
            ? terminalResources[resource] || 0
            : Object.values(terminalResources).reduce(
                (sum, value) => sum + (value || 0),
                0,
              );
          return 300000 - used;
        },
      },
    } as unknown as StructureTerminal,
    find(
      type: FindConstant,
      opts?: { filter?: (structure: Structure) => boolean },
    ) {
      if (type === FIND_MINERALS) {
        return nativeMineral ? [nativeMineral] : [];
      }
      if (type === FIND_STRUCTURES) {
        const structures: Structure[] = extractor ? [extractor] : [];
        return opts?.filter
          ? structures.filter((structure) => opts.filter?.(structure))
          : structures;
      }
      return [];
    },
  } as Room;
  (room.terminal as StructureTerminal).room = room;
  return room;
}

const READINESS_MIGRATION_TICK = 72_587_210;
const READINESS_AUTH_TICK = READINESS_MIGRATION_TICK + 2;
const READINESS_ACCOUNT = "screeps-account:resource-control-fixture";

function cloneFixture<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function acceptedLegacyV2ReadinessState(): MarketDirectContinuousAutomationState {
  const legacy = createDirectAutomationState();
  legacy.directDealOutcomes = [cloneFixture(LEGACY_X_V1_OUTCOME_GOLDEN)];
  legacy.processedDirectTransactionKeys = [LEGACY_X_PROCESSED_EVIDENCE_KEY];
  legacy.directConfirmedDealCount = 1;
  legacy.directPausedForReview = true;
  const migrated = migrateLegacyDirectToContinuous(
    legacy,
    READINESS_MIGRATION_TICK,
  );
  const proposed = proposeMarketDirectContinuousPermit(
    migrated,
    READINESS_MIGRATION_TICK + 1,
    READINESS_ACCOUNT,
    {
      operatorAuthorizationFingerprint:
        "operator-authorization:resource-control",
    },
  );
  if (!proposed.ok || !proposed.permit) {
    throw new Error(`readiness permit proposal failed:${proposed.error}`);
  }
  const accepted = acceptMarketDirectContinuousPermit(
    proposed.state,
    READINESS_MIGRATION_TICK + 2,
    proposed.permit.permitId,
    MARKET_DIRECT_CONTINUOUS_EXECUTOR_SHARD,
  );
  if (!accepted.ok) {
    throw new Error(`readiness permit accept failed:${accepted.error}`);
  }
  return accepted.state;
}

function readinessSanitizedHash(domain: string, evidence: unknown): string {
  return canonicalStableHashV1({
    domain,
    evidence: JSON.parse(JSON.stringify(evidence)),
  });
}

function canonicalLegacyV2Readiness(
  tick: number,
  roomName: string,
  terminalId: string,
): MarketDirectContinuousAutomationState & {
  baseResourceV3: {
    readinessAuthorization: MarketTerminalEnergyReadinessAuthorizationProjection;
  };
} {
  const direct = acceptedLegacyV2ReadinessState();
  const roomInstanceId = readinessSanitizedHash(
    "market-base-resource:legacy-v2-readiness-room-v1",
    {
      accountIdentity: READINESS_ACCOUNT,
      roomName,
      terminalId,
    },
  );
  const rooms = [
    {
      roomName,
      roomInstanceId,
      terminalId,
      status: "authorized" as const,
    },
  ];
  direct.baseResourceV3 = {
    readinessAuthorization: {
      schemaVersion: 3,
      validated: true,
      status: "authorized",
      revision: readinessSanitizedHash(
        "market-base-resource:readiness-authorization-v1",
        {
          permitHead: direct.currentPermit!.permitHead,
          permitId: direct.currentPermit!.permitId,
          rooms,
          sourcePermitVersion: 2,
          tick,
        },
      ),
      updatedAt: tick,
      expiresAt: tick,
      maxTransactionEnergy: 1_000,
      sourcePermitVersion: 2,
      rooms,
    },
  } as unknown as MarketDirectContinuousAutomationState["baseResourceV3"];
  return direct as MarketDirectContinuousAutomationState & {
    baseResourceV3: {
      readinessAuthorization: MarketTerminalEnergyReadinessAuthorizationProjection;
    };
  };
}

let resourceControlReadinessDeriveSpy: jest.SpyInstance | undefined;

function authorizeMarketTerminalEnergyReadiness(
  room: Room,
  sourcePermitVersion: 2 | 3 = 3,
): void {
  Memory.cfg = {
    ...Memory.cfg,
    marketSaleAutomation: {
      mode: "direct",
    },
  } as unknown as Memory["cfg"];
  const readinessAuthorization: MarketTerminalEnergyReadinessAuthorizationProjection =
    {
      schemaVersion: 3,
      validated: true,
      status: "authorized",
      revision: `permit:${Game.time}`,
      updatedAt: Game.time,
      expiresAt: Game.time + 10,
      maxTransactionEnergy: 1_000,
      sourcePermitVersion,
      rooms: [
        {
          roomName: room.name,
          roomInstanceId: `room:${room.name}:1`,
          terminalId: room.terminal!.id,
          status: "authorized",
        },
      ],
    };
  Memory.data = {
    ...Memory.data,
    marketSaleAutomation: {
      managedOrders: {},
      directAutomation: {
        baseResourceV3: {
          readinessAuthorization,
        },
      },
    },
  } as unknown as Memory["data"];
  resourceControlReadinessDeriveSpy?.mockReturnValue({
    ok: true,
    revision: readinessAuthorization.revision,
    maxTransactionEnergy: 1_000,
    sourcePermitVersion,
    rooms: [
      {
        roomName: room.name,
        roomInstanceId: readinessAuthorization.rooms[0].roomInstanceId,
        terminalId: room.terminal!.id,
      },
    ],
  });
}

function getMarketEnergyReadinessObservation(
  roomName: string,
): Record<string, unknown> | undefined {
  const runtime = Memory.runtime?.resourceControl as unknown as
    | {
        rooms?: Record<
          string,
          {
            marketEnergyReadiness?: Record<string, unknown>;
          }
        >;
      }
    | undefined;
  return runtime?.rooms?.[roomName]?.marketEnergyReadiness;
}

describe("runResourceControl terminal feed tasks", () => {
  beforeEach(() => {
    resourceControlReadinessDeriveSpy = jest
      .spyOn(
        marketBaseResourceAutomationModule,
        "deriveMarketBaseResourceCanonicalReadinessAuthorization",
      )
      .mockReturnValue({
        ok: false,
        reason: "missing",
        rooms: [],
      });
    clearCarrierTaskBoardForTest();
    clearMarketActionArbiterForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  afterEach(() => {
    resourceControlReadinessDeriveSpy?.mockRestore();
    resourceControlReadinessDeriveSpy = undefined;
  });

  it("creates the exact E6 2,347 Energy readiness feed above the ordinary used-cap", () => {
    const room = createRoom({
      name: "E6N59",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 231_449,
      },
    });
    Game.rooms[room.name] = room;
    authorizeMarketTerminalEnergyReadiness(room, 2);

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [
        {
          resource: RESOURCE_ENERGY,
          amount: 2_347,
        },
      ],
    });
    expect(getMarketEnergyReadinessObservation(room.name)).toMatchObject({
      schemaVersion: 3,
      authorized: true,
      effectivePostDealEnergyReserve: 25_000,
      marketTerminalEnergyTarget: 26_000,
      desiredTerminalEnergy: 26_000,
      plannedFeedAmount: 2_347,
      status: "feed_planned",
    });
  });

  it("ignores the room floor while retaining production ownership for Direct readiness", () => {
    const room = createRoom({
      name: "E6N58",
      storageResources: {
        [RESOURCE_ENERGY]: 30_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 231_449,
      },
    });
    Game.rooms[room.name] = room;
    reserveProductionResource(
      room.name,
      RESOURCE_ENERGY,
      5_000,
      "direct-readiness-production",
    );
    authorizeMarketTerminalEnergyReadiness(room, 2);

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      steps: [expect.objectContaining({ amount: 2_347 })],
    });
    expect(getMarketEnergyReadinessObservation(room.name)).toMatchObject({
      terminalScopedProductionEnergyCommitments: 5_000,
      plannedFeedAmount: 2_347,
      status: "feed_planned",
    });
  });

  it("blocks Direct readiness when the feed would consume production ownership", () => {
    const room = createRoom({
      name: "E6N57",
      storageResources: {
        [RESOURCE_ENERGY]: 6_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 231_449,
      },
    });
    Game.rooms[room.name] = room;
    reserveProductionResource(
      room.name,
      RESOURCE_ENERGY,
      5_000,
      "direct-readiness-production",
    );
    authorizeMarketTerminalEnergyReadiness(room, 2);

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
      ],
    ).toBeUndefined();
    expect(getMarketEnergyReadinessObservation(room.name)).toMatchObject({
      blocker: "production_energy_ownership",
      plannedFeedAmount: 0,
      status: "blocked",
    });
  });

  it("fails Direct readiness closed when production ownership is non-finite", () => {
    const room = createRoom({
      name: "E6N56",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 231_449,
      },
    });
    Game.rooms[room.name] = room;
    authorizeMarketTerminalEnergyReadiness(room, 2);

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
      ],
    ).toBeDefined();

    reserveProductionResource(
      room.name,
      RESOURCE_ENERGY,
      Number.NaN,
      "corrupt-production-ownership",
    );
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
      ],
    ).toBeUndefined();
    expect(getMarketEnergyReadinessObservation(room.name)).toMatchObject({
      blocker: "production_energy_ownership",
      plannedFeedAmount: 0,
      status: "blocked",
    });
  });
});

describe("terminal headroom offload", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearLocalCarrierDestinationCapacityForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  it("offloads non-energy terminal overflow above the normal 240000 target", () => {
    const room = createRoom({
      name: "W25N1",
      terminalResources: {
        [RESOURCE_HYDROGEN]: 200_000,
        [RESOURCE_KEANIUM]: 100_000,
      },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offloadKeys = Object.keys(tasks).filter(
      (k) => k.includes("terminal_offload") && !k.includes(RESOURCE_ENERGY),
    );
    expect(offloadKeys.length).toBeGreaterThanOrEqual(1);
    const totalOffloaded = offloadKeys.reduce((sum, key) => {
      const steps = tasks[key].steps;
      return sum + steps.reduce((s, step) => s + step.amount, 0);
    }, 0);
    expect(totalOffloaded).toBeGreaterThan(0);
  });

  it("offloads an E4N58-like normal terminal to 60000 free capacity", () => {
    const room = createRoom({
      name: "E4N58",
      terminalResources: { [RESOURCE_HYDROGEN]: 249_051 },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 9_051 }],
    });
    expect(Memory.runtime?.resourceControl?.rooms[room.name]).toMatchObject({
      capacityState: "normal",
      desiredTerminalFreeCapacity: 60_000,
      terminalRecoveryGap: 9_051,
    });
  });

  it("subtracts accepted/in-flight carrier cargo from safe Storage offload capacity", () => {
    const room = createRoom({
      name: "W25N2",
      terminalResources: { [RESOURCE_HYDROGEN]: 249_051 },
      storageFreeCapacity: 210_000,
    });
    Game.rooms[room.name] = room;
    const carrier = {
      name: "carrier-inflight-offload",
      room,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_HYDROGEN
            ? 6_000
            : 0,
        getFreeCapacity: () => 0,
      },
    } as unknown as Creep;
    Game.creeps[carrier.name] = carrier;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      synthesisCarrierPendingToId: room.storage!.id,
      synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
    });

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 4_000 }],
    });
    expect(Memory.runtime?.resourceControl?.rooms[room.name]).toMatchObject({
      localOffloadCapacityCommitment: 6_000,
      recoverableOffloadAmount: 4_000,
    });
  });

  it("reports storage_full when in-flight cargo exhausts effective safe capacity", () => {
    const room = createRoom({
      name: "W25N3",
      terminalResources: { [RESOURCE_HYDROGEN]: 249_051 },
      storageFreeCapacity: 206_000,
    });
    Game.rooms[room.name] = room;
    const carrier = {
      name: "carrier-inflight-exhausts-safe-capacity",
      room,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_HYDROGEN
            ? 6_000
            : 0,
        getFreeCapacity: () => 0,
      },
    } as unknown as Creep;
    Game.creeps[carrier.name] = carrier;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      synthesisCarrierPendingToId: room.storage!.id,
      synthesisCarrierPendingResource: RESOURCE_HYDROGEN,
    });

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toBeUndefined();
    expect(Memory.runtime?.resourceControl?.rooms[room.name]).toMatchObject({
      localOffloadCapacityCommitment: 6_000,
      recoverableOffloadAmount: 0,
      stickyHeadroom: true,
      stickyHeadroomReason: "storage_full",
    });
  });

  it("protects at most one safe send batch instead of a complete pending backlog", () => {
    const roomName = "W25R6";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      terminalResources: { [RESOURCE_HYDROGEN]: 250_000 },
    });
    room.terminal!.cooldown = 1;
    const receiver = createRoom({ name: "W25R6B" });
    Game.rooms[room.name] = room;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      room.name,
      receiver.name,
      RESOURCE_HYDROGEN,
      250_000,
      "manual:large-backlog",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    expect(
      tasks[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`
      ],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
    });
    expect(
      tasks[`resourceControl:terminal_feed:${room.name}:${RESOURCE_HYDROGEN}`],
    ).toBeUndefined();
  });

  it("uses headroom for the missing cargo delta when a batch is partly staged", () => {
    const donor = createRoom({
      name: "W25R8G",
      storageResources: {
        [RESOURCE_ENERGY]: 230_000,
        [RESOURCE_KEANIUM]: 5_500,
      },
      terminalResources: {
        [RESOURCE_HYDROGEN]: 239_000,
        [RESOURCE_KEANIUM]: 500,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25R8H",
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    Memory.cfg!.resourceControl!.rooms = {
      [donor.name]: { terminalEnergyReserve: 0 },
    };
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      1_000,
      "manual:partial-staging-headroom",
    );

    runResourceControl();

    expect(
      getCarrierTasksByRoom(donor.name)[
        `resourceControl:terminal_feed:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [{ resource: RESOURCE_KEANIUM, amount: 500 }],
    });
  });

  it("keeps the admitted K batch out of reverse offload while recovering energy", () => {
    const donor = createRoom({
      name: "W25R8E",
      storageResources: {
        [RESOURCE_ENERGY]: 220_000,
        [RESOURCE_KEANIUM]: 5_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 290_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
    });
    donor.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W25R8F",
      storageFreeCapacity: 500_000,
    });
    Game.rooms[donor.name] = donor;
    Game.rooms[receiver.name] = receiver;
    createResourceTransferTask(
      donor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      10_000,
      "manual:protect-admitted-k",
    );

    runResourceControl();

    const tasks = getCarrierTasksByRoom(donor.name);
    expect(
      tasks[
        `resourceControl:terminal_offload:${donor.name}:${RESOURCE_KEANIUM}`
      ],
    ).toBeUndefined();
    expect(
      tasks[
        `resourceControl:terminal_offload:${donor.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_offload",
      steps: [{ resource: RESOURCE_ENERGY, amount: 10_000 }],
    });
  });

  it("does not offload when terminal total is exactly 240000 or lower", () => {
    const room = createRoom({
      name: "W25N5",
      terminalResources: {
        [RESOURCE_HYDROGEN]: 100_000,
        [RESOURCE_KEANIUM]: 140_000,
      },
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    const tasks = getCarrierTasksByRoom(room.name);
    const offloadKeys = Object.keys(tasks).filter(
      (k) => k.includes("terminal_offload") && !k.includes(RESOURCE_ENERGY),
    );
    expect(offloadKeys).toEqual([]);
  });
});

const ALL_10_T3: ResourceConstant[] = [
  RESOURCE_CATALYZED_UTRIUM_ACID, // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE, // XUHO2
  RESOURCE_CATALYZED_KEANIUM_ACID, // XKH2O
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE, // XKHO2
  RESOURCE_CATALYZED_LEMERGIUM_ACID, // XLH2O
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
  RESOURCE_CATALYZED_ZYNTHIUM_ACID, // XZH2O
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, // XZHO2
  RESOURCE_CATALYZED_GHODIUM_ACID, // XGH2O
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
];

describe("hub market protection for all 10 T3 compounds", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: true,
        },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 200),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  it("isHubProtectedResource returns true for target compound NOT in marketSellSurplus", () => {
    Memory.cfg!.hub = {
      hubRoomName: "W40N15",
      targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    };
    Memory.cfg!.resourceControl!.market!.enabled = true;
    Memory.cfg!.resourceControl!.market!.sellResources = [
      RESOURCE_CATALYZED_UTRIUM_ACID,
    ];
    Memory.runtime = {};
    const room = createRoom({
      name: "W40N15",
      storageResources: {
        [RESOURCE_ENERGY]: 300000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 10000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 25000,
        [RESOURCE_CATALYZED_UTRIUM_ACID]: 5000,
      },
      nativeMineralType: RESOURCE_HYDROGEN,
    });
    Game.rooms[room.name] = room;
    (Game as GameWithPartialMarket).market.calcTransactionCost = jest.fn(
      () => 200,
    );
    (Game as GameWithPartialMarket).market.getAllOrders = jest.fn(
      (filter: OrderFilter) => {
        if (
          filter.type === ORDER_BUY &&
          filter.resourceType === RESOURCE_CATALYZED_UTRIUM_ACID
        ) {
          return [
            {
              id: "buy-xuh2o-protected",
              type: ORDER_BUY,
              resourceType: RESOURCE_CATALYZED_UTRIUM_ACID,
              price: 5.0,
              amount: 5000,
              roomName: "W9N9",
            } as Order,
          ];
        }
        return [];
      },
    );

    runResourceControl();

    expect(Game.market.deal).not.toHaveBeenCalled();
  });
});

describe("resource-control capacity state", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: { enabled: false },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  it("returns a pressured room to normal only after both recovery watermarks are met", () => {
    const roomName = "W60N4";
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: {
          [roomName]: { capacityState: "pressure" },
        },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    const room = createRoom({
      name: roomName,
      storageResources: { [RESOURCE_ENERGY]: 150_000 },
      terminalResources: { [RESOURCE_ENERGY]: 220_000 },
      storageFreeCapacity: 200_000,
    });
    Game.rooms[room.name] = room;

    runResourceControl();

    expect(
      (Memory.runtime?.resourceControl?.rooms[room.name] as any).capacityState,
    ).toBe("normal");
  });
});

describe("capacity-relief planning", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: { enabled: false },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  it("reuses receiver capacity released by a receiver-capacity blocker in the same planning pass", () => {
    const blockedDonor = createRoom({
      name: "W63N3",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_KEANIUM]: 10_000,
      },
      storageFreeCapacity: 100_000,
    });
    blockedDonor.terminal!.cooldown = 1;
    const pressureSource = createRoom({
      name: "W63N4",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 30_000,
        [RESOURCE_HYDROGEN]: 230_001,
      },
      storageFreeCapacity: 500_000,
    });
    pressureSource.terminal!.cooldown = 1;
    const receiver = createRoom({
      name: "W63N5",
      storageResources: { [RESOURCE_ENERGY]: 200_000 },
      terminalResources: { [RESOURCE_ENERGY]: 250_000 },
      storageFreeCapacity: 500_000,
    });
    for (const room of [blockedDonor, pressureSource, receiver]) {
      Game.rooms[room.name] = room;
    }
    const blocked = createAutomaticResourceTransferTask(
      blockedDonor.name,
      receiver.name,
      RESOURCE_KEANIUM,
      9_999,
      "synthesis:blocked-capacity",
    );
    if (typeof blocked === "string") throw new Error(blocked);
    markResourceTransferTaskBlocked(blocked.task, "receiver_capacity");

    runResourceControl();

    expect(
      Object.values(ensureResourceTransferTaskStore()).find(
        (task) =>
          task.fromRoomName === pressureSource.name &&
          task.toRoomName === receiver.name &&
          task.reason === `capacity:relief:${RESOURCE_HYDROGEN}`,
      ),
    ).toMatchObject({ remainingAmount: 10_000 });
  });
});

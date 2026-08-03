import {
  MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
  applyMarketBaseResourceShadowObservations,
  buildMarketBaseResourcePricingRatchetState,
  marketBaseResourceOperatorAuthorizationFingerprint,
  planMarketBaseResourceTwoRead,
  reconcileLiveMarketBaseResourceScope,
  runMarketBaseResourceAutomation,
  type MarketBaseResourceAutomationInput,
  type MarketBaseResourcePlanningDependencies,
  type MarketBaseResourcePlanningScopeSnapshot,
  type MarketBaseResourceRuntimeCandidate,
  type MarketBaseResourceRuntimeDependencies,
  type MarketBaseResourceScopeState,
  type MarketBaseResourceV3RuntimeState,
  type MarketBaseResourceTerminalRead,
} from "@/runtime/marketBaseResourceAutomation";
import {
  MARKET_DIRECT_CONTINUOUS_LANE_ROLLING_CAP,
  MARKET_DIRECT_CONTINUOUS_ROOM_ROLLING_CAP,
  type MarketDirectContinuousEntryInput,
} from "@/runtime/marketDirectContinuousPlanner";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CATALOG_REVISION,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  MARKET_BASE_RESOURCE_POLICIES,
  createMarketBaseSharedPolicy,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  type MarketBaseDerivedLaneLifecycle,
  type MarketBaseRoomObservation,
} from "@/runtime/marketBaseResourcePolicy";
import {
  appendMarketBaseResourcePermit,
  buildMarketBaseResourceBootstrapRatchetHighWater,
  buildMarketBaseResourceLegacyV2GrantSuspension,
  buildMarketBaseResourcePermit,
  buildMarketBaseResourceSignedLaneGrant,
  buildMarketBaseResourceV2EventCutoverCheckpoint,
  createMarketBaseResourcePermitChainState,
  wrapAuthenticatedLegacyV2PermitRecord,
  type MarketBaseResourcePermit,
  type MarketBaseResourcePermitChainState,
  type MarketBaseResourceSignedLaneGrant,
} from "@/runtime/marketBaseResourcePermit";
import {
  buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis,
  buildMarketBaseResourceLedgerRuntimeAnchor,
  createMarketBaseResourceLedger,
} from "@/runtime/marketBaseResourceLedger";
import {
  MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE,
  buildMarketDirectContinuousPermit,
  canonicalStableHashV1,
} from "@/runtime/marketDirectContinuousPolicy";
import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import type { MarketProtectionEntry } from "@/runtime/marketSaleProtection";

function order(
  id: string,
  resourceType: ResourceConstant,
  price: number,
  amount: number,
  roomName: string,
): MarketOrderSnapshot {
  return {
    id,
    type: "buy",
    resourceType,
    price,
    amount,
    remainingAmount: amount,
    totalAmount: amount,
    roomName,
    created: 1,
  };
}

function entry(
  resource: ResourceConstant,
  rooms: readonly string[],
  authorization: "writable" | "suspended_shadow" = "writable",
  floor = 10,
): MarketDirectContinuousEntryInput & {
  lanes: Array<
    MarketDirectContinuousEntryInput["lanes"][number] & {
      laneId: string;
      roomInstanceId: string;
    }
  >;
} {
  const immutable =
    MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[
      resource as keyof typeof MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE
    ];
  return {
    policy: {
      entryId: immutable?.policyId || `policy:${resource}`,
      revision: immutable?.policyRevision || `policy:${resource}:v3`,
      resourceType: resource,
      allowedRooms: [...rooms],
      requireNativeMineral: false,
      grant: "continuous",
      hardNetFloor: immutable?.hardFloor || floor,
      economicNetFloor: immutable?.economicFloor || floor,
      historyNetFloor: immutable?.economicFloor || floor,
      ratchetNetFloor: immutable?.economicFloor || floor,
      minExecutableNotional: immutable?.minOrderNotional || floor * 1_000,
      maxRawOrders: immutable?.maxRawOrdersScanned || 1_000,
      maxEligibleOrders: immutable?.maxEligibleOrdersPriced || 200,
      maxTransactionEnergy: immutable?.maxTransactionEnergy || 1_000,
      terminalEnergyReserve: immutable?.terminalEnergyReserve || 25_000,
      resourceRollingCap: immutable?.rollingMaxAmount || 8_000,
      opportunityReserve: immutable?.rollingOpportunityReserveAmount || 1_000,
      evaluatorVersion: 3,
    },
    quota: {
      complete: true,
      revision: `quota:${resource}`,
      resourceType: resource,
      rollingCap: 8_000,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
      opportunityReserveSatisfied: true,
    },
    lanes: rooms.map((roomName) => ({
      laneId: `lane:${resource}:${roomName}`,
      roomInstanceId: `room:${roomName}`,
      lane: {
        roomName,
        resourceType: resource,
        owned: true,
        hub: false,
        capacityEmergency: false,
        authorization,
      },
      protection: {
        complete: true,
        revision: `protection:${roomName}:${resource}`,
        sellableAmount: 10_000,
      },
      terminal: {
        revision: `seed-terminal:${roomName}:${resource}`,
        normal: true,
        ready: true,
        claimed: false,
        cooldown: 0,
        resourceAmount: 10_000,
        energy: 50_000,
        effectivePostDealEnergyReserve: 25_000,
      },
      quota: {
        complete: true,
        revision: `lane-quota:${roomName}:${resource}`,
        roomRollingCap: MARKET_DIRECT_CONTINUOUS_ROOM_ROLLING_CAP,
        roomConfirmedAmount: 0,
        roomUnmatchedPlannedAmount: 0,
        laneRollingCap: MARKET_DIRECT_CONTINUOUS_LANE_ROLLING_CAP,
        laneConfirmedAmount: 0,
        laneUnmatchedPlannedAmount: 0,
      },
    })),
  };
}

/** 仅用于覆盖 immutable catalog 到 direct-planner 映射的篡改边界。 */
function immutablePolicyEntry(
  resource: "H" | "K" | "L" | "O" | "U" | "X" | "Z",
  rooms: readonly string[],
  authorization: "writable" | "suspended_shadow" = "writable",
): ReturnType<typeof entry> {
  const base = entry(resource, rooms, authorization, 10);
  const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
  return {
    ...base,
    policy: {
      ...base.policy,
      entryId: policy.policyId,
      revision: policy.policyRevision,
      resourceType: policy.resource,
      hardNetFloor: policy.hardFloor,
      economicNetFloor: policy.economicFloor,
      historyNetFloor: policy.economicFloor,
      ratchetNetFloor: policy.economicFloor,
      minExecutableNotional: policy.minOrderNotional,
      maxRawOrders: policy.maxRawOrdersScanned,
      maxEligibleOrders: policy.maxEligibleOrdersPriced,
      maxTransactionEnergy: policy.maxTransactionEnergy,
      terminalEnergyReserve: policy.terminalEnergyReserve,
      resourceRollingCap: policy.rollingMaxAmount,
      opportunityReserve: policy.rollingOpportunityReserveAmount,
    },
  };
}

function scope(
  entries: readonly ReturnType<typeof entry>[],
  revision = "scope:stable",
): MarketBaseResourcePlanningScopeSnapshot {
  const presentResources = new Set(
    entries.map((candidate) => candidate.policy.resourceType),
  );
  const catalogEntries = [
    ...entries,
    ...MARKET_BASE_RESOURCE_CATALOG.filter(
      (resource) => !presentResources.has(resource),
    ).map((resource) => entry(resource, [])),
  ];
  const rooms = new Set(
    catalogEntries.flatMap((candidate) =>
      candidate.lanes.map((lane) => lane.lane.roomName),
    ),
  );
  const activeLaneCount = catalogEntries.reduce(
    (sum, candidate) => sum + candidate.lanes.length,
    0,
  );
  return {
    complete: true,
    scopeEvidence: revision,
    currentRosterFingerprint: `roster:${revision}`,
    currentLaneSetFingerprint: `lanes:${revision}`,
    activeRoomCount: rooms.size,
    knownRoomNameCount: rooms.size,
    activeLaneCount,
    entries: catalogEntries,
    energyShadow: {
      complete: true,
      revision: "energy-shadow",
      price: 20,
    },
    globalQuota: {
      complete: true,
      revision: "global-quota",
      rollingCap: 12_000,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
    },
    writeContext: {
      complete: true,
      revision: "write-context",
      credits: 10_000_000,
      executorShard: "shard1",
      permitEpoch: 2,
      permitId: "permit-v3",
      permitHead: "permit-head-v3",
      pendingState: "none",
      arbiterState: "available",
    },
  };
}

interface Harness {
  scope: MarketBaseResourcePlanningScopeSnapshot;
  secondScope?: MarketBaseResourcePlanningScopeSnapshot;
  books: Partial<Record<ResourceConstant, MarketOrderSnapshot[]>>;
  throwBook?: ResourceConstant;
  mutateNonSelectedTerminal?: boolean;
}

function terminal(
  roomName: string,
  resource: ResourceConstant,
  revision: string,
): MarketBaseResourceTerminalRead {
  return {
    roomName,
    terminalId: `terminal:${roomName}`,
    owned: true,
    ready: true,
    cooldown: 0,
    resourceAmount: 10_000,
    energy: 50_000,
    nativeMineralType: resource,
    effectivePostDealEnergyReserve: 25_000,
    revision,
  };
}

function dependencies(
  harness: Harness,
): MarketBaseResourcePlanningDependencies & {
  readCurrentBuyOrders: jest.Mock;
} {
  const terminalReads = new Map<string, number>();
  let scopeReads = 0;
  return {
    readScope: jest.fn(() => {
      scopeReads += 1;
      return JSON.parse(
        JSON.stringify(
          scopeReads === 2 && harness.secondScope
            ? harness.secondScope
            : harness.scope,
        ),
      ) as MarketBaseResourcePlanningScopeSnapshot;
    }),
    readCurrentBuyOrders: jest.fn((resource: ResourceConstant) => {
      if (harness.throwBook === resource) {
        throw new Error("fixture book unavailable");
      }
      return JSON.parse(
        JSON.stringify(harness.books[resource] || []),
      ) as MarketOrderSnapshot[];
    }),
    readOwnOrders: jest.fn(() => []),
    readTerminal: jest.fn((roomName, resource) => {
      const key = `${roomName}:${resource}`;
      const reads = (terminalReads.get(key) || 0) + 1;
      terminalReads.set(key, reads);
      return terminal(
        roomName,
        resource,
        harness.mutateNonSelectedTerminal && roomName === "W2N2" && reads === 2
          ? "terminal:changed"
          : "terminal:stable",
      );
    }),
    calculateTransactionEnergy: jest.fn(() => 0),
    cpuUsed: jest.fn(() => 1),
  };
}

describe("Market Base Resource V3 runtime", () => {
  it("跨资源和房间统一选择最高单位净价，不受大额低价单优先级影响", () => {
    const h = entry(RESOURCE_HYDROGEN, ["W1N1"], "writable", 100);
    const x = entry(RESOURCE_CATALYST, ["W2N2"], "writable", 500);
    const deps = dependencies({
      scope: scope([h, x]),
      books: {
        [RESOURCE_HYDROGEN]: [
          order("h-large-low", RESOURCE_HYDROGEN, 200, 100_000, "E20S20"),
        ],
        [RESOURCE_CATALYST]: [
          order("x-small-high", RESOURCE_CATALYST, 700, 1_000, "E21S21"),
        ],
      },
    });

    const result = planMarketBaseResourceTwoRead(deps);

    expect(result.complete).toBe(true);
    expect(result.selected).toMatchObject({
      resourceType: RESOURCE_CATALYST,
      roomName: "W2N2",
      order: { id: "x-small-high" },
    });
    expect(
      deps.readCurrentBuyOrders.mock.calls.filter(
        ([resource]) => resource === RESOURCE_HYDROGEN,
      ),
    ).toHaveLength(2);
    expect(
      deps.readCurrentBuyOrders.mock.calls.filter(
        ([resource]) => resource === RESOURCE_CATALYST,
      ),
    ).toHaveLength(2);
  });

  it("第二读非选中 writable lane 变化也整轮零写，不换次优单", () => {
    const deps = dependencies({
      scope: scope([
        entry(RESOURCE_HYDROGEN, ["W1N1"], "writable", 100),
        entry(RESOURCE_CATALYST, ["W2N2"], "writable", 500),
      ]),
      books: {
        [RESOURCE_HYDROGEN]: [
          order("h-best", RESOURCE_HYDROGEN, 800, 1_000, "E20S20"),
        ],
        [RESOURCE_CATALYST]: [
          order("x-second", RESOURCE_CATALYST, 700, 1_000, "E21S21"),
        ],
      },
      mutateNonSelectedTerminal: true,
    });

    const result = planMarketBaseResourceTwoRead(deps);

    expect(result.complete).toBe(false);
    expect(result.blocker).toBe("market_base_second_read_changed");
    expect(result.selected).toBeUndefined();
    expect(result.first?.selected?.order.id).toBe("h-best");
  });

  it("两次完整读取之间动态 roster/lane set 变化时整轮零写", () => {
    const firstScope = scope(
      [entry(RESOURCE_HYDROGEN, ["W1N1"], "writable", 100)],
      "scope:roster-a",
    );
    const secondScope = scope(
      [
        entry(RESOURCE_HYDROGEN, ["W1N1"], "writable", 100),
        entry(RESOURCE_CATALYST, ["W2N2"], "writable", 500),
      ],
      "scope:roster-b",
    );
    const deps = dependencies({
      scope: firstScope,
      secondScope,
      books: {
        [RESOURCE_HYDROGEN]: [
          order("h-best", RESOURCE_HYDROGEN, 800, 1_000, "E20S20"),
        ],
      },
    });

    const result = planMarketBaseResourceTwoRead(deps);

    expect(deps.readScope).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(false);
    expect(result.blocker).toBe("market_base_second_read_scope_changed");
    expect(result.selected).toBeUndefined();
    expect(result.first?.selected?.order.id).toBe("h-best");
  });

  it.each([
    ["cooldown", { cooldown: 1, ready: true }],
    ["readiness wait", { cooldown: 0, ready: false }],
  ])(
    "一个 V3 writable room 处于 %s 时只跳过自身，不阻断其它房间",
    (_label, unavailable) => {
      const deps = dependencies({
        scope: scope([
          entry(RESOURCE_HYDROGEN, ["W1N1", "W2N2"], "writable", 100),
        ]),
        books: {
          [RESOURCE_HYDROGEN]: [
            order("h-safe", RESOURCE_HYDROGEN, 700, 1_000, "E1S1"),
          ],
        },
      });
      deps.readTerminal = jest.fn((roomName, resource) => ({
        ...terminal(roomName, resource, "terminal:stable"),
        ...(roomName === "W1N1" ? unavailable : { cooldown: 0, ready: true }),
      }));

      const result = planMarketBaseResourceTwoRead(deps);

      expect(result.complete).toBe(true);
      expect(result.selected?.roomName).toBe("W2N2");
      expect(result.selected?.order.id).toBe("h-safe");
    },
  );

  it("仅 Shadow 资源 book 不完整只重置该 lane，不阻断其它 writable lane", () => {
    const shadowH = entry(RESOURCE_HYDROGEN, ["W1N1"], "suspended_shadow", 100);
    const writableX = entry(RESOURCE_CATALYST, ["W2N2"], "writable", 500);
    const deps = dependencies({
      scope: scope([shadowH, writableX]),
      books: {
        [RESOURCE_CATALYST]: [
          order("x-safe", RESOURCE_CATALYST, 700, 1_000, "E21S21"),
        ],
      },
      throwBook: RESOURCE_HYDROGEN,
    });

    const result = planMarketBaseResourceTwoRead(deps);

    expect(result.complete).toBe(true);
    expect(result.selected?.order.id).toBe("x-safe");
    expect(result.shadowObservations).toEqual([
      expect.objectContaining({
        laneId: "lane:H:W1N1",
        result: "incomplete",
        blocker: "market_base_book_incomplete:H",
      }),
    ]);
  });

  it("8-lane Shadow cursor 在两轮覆盖 10 lane 且完整观测推进", () => {
    const rooms = Array.from(
      { length: 10 },
      (_unused, index) => `W${index + 1}N1`,
    );
    const shadow = entry(RESOURCE_HYDROGEN, rooms, "suspended_shadow", 100);
    const deps = dependencies({
      scope: scope([shadow]),
      books: { [RESOURCE_HYDROGEN]: [] },
    });

    const first = planMarketBaseResourceTwoRead(deps);
    const second = planMarketBaseResourceTwoRead(deps, first.nextShadowCursor);
    const covered = new Set([
      ...first.sampledShadowLaneIds,
      ...second.sampledShadowLaneIds,
    ]);

    expect(first.complete).toBe(true);
    expect(first.sampledShadowLaneIds).toHaveLength(
      MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
    );
    expect(first.shadowObservations).toHaveLength(8);
    expect(
      first.shadowObservations.every(
        (observation) => observation.result === "safe_no_opportunity",
      ),
    ).toBe(true);
    expect(covered.size).toBe(10);
  });

  it.each([
    [8, 7, 56],
    [16, 14, 112],
  ])(
    "%i 房的 %i 个周期完整覆盖 %i 条 Shadow lane",
    (roomCount, cycleCount, laneCount) => {
      const rooms = Array.from(
        { length: roomCount },
        (_unused, index) => `W${index + 1}N8`,
      );
      const deps = dependencies({
        scope: scope(
          MARKET_BASE_RESOURCE_CATALOG.map((resource) =>
            immutablePolicyEntry(resource, rooms, "suspended_shadow"),
          ),
        ),
        books: {},
      });
      const covered = new Set<string>();
      let cursor: string | undefined;

      for (let cycle = 0; cycle < cycleCount; cycle += 1) {
        const result = planMarketBaseResourceTwoRead(deps, cursor);
        expect(result.complete).toBe(true);
        expect(result.sampledShadowLaneIds).toHaveLength(
          MARKET_BASE_RESOURCE_MAX_SHADOW_LANES_PER_CYCLE,
        );
        result.sampledShadowLaneIds.forEach((laneId) => covered.add(laneId));
        cursor = result.nextShadowCursor;
      }

      expect(covered.size).toBe(laneCount);
    },
  );

  it("cursor 所指 lane 被移除后从稳定排序的下一条 lane 继续", () => {
    const rooms = Array.from(
      { length: 10 },
      (_unused, index) => `W${index + 1}N7`,
    );
    const original = immutablePolicyEntry("H", rooms, "suspended_shadow");
    const first = planMarketBaseResourceTwoRead(
      dependencies({
        scope: scope([original]),
        books: {},
      }),
    );
    const removedCursor = first.nextShadowCursor!;
    const retainedRooms = original.lanes
      .filter((lane) => `lane:H:${lane.lane.roomName}` !== removedCursor)
      .map((lane) => lane.lane.roomName);
    const retained = immutablePolicyEntry(
      "H",
      retainedRooms,
      "suspended_shadow",
    );
    const sortedIds = retainedRooms
      .map((roomName) => `lane:H:${roomName}`)
      .sort((left, right) => left.localeCompare(right));
    const expectedSuccessor =
      sortedIds.find((laneId) => laneId.localeCompare(removedCursor) > 0) ??
      sortedIds[0];

    const remapped = planMarketBaseResourceTwoRead(
      dependencies({
        scope: scope([retained]),
        books: {},
      }),
      removedCursor,
    );

    expect(remapped.complete).toBe(true);
    expect(remapped.sampledShadowLaneIds[0]).toBe(expectedSuccessor);
  });

  it("全 Shadow 收集完成后 CPU 超限不推进 observation 或 cursor", () => {
    const deps = dependencies({
      scope: scope([
        immutablePolicyEntry(
          "H",
          Array.from({ length: 8 }, (_unused, index) => `W${index + 1}N1`),
          "suspended_shadow",
        ),
      ]),
      books: { [RESOURCE_HYDROGEN]: [] },
    });
    const cpuUsed = deps.cpuUsed as jest.Mock;
    cpuUsed.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(26);

    const result = planMarketBaseResourceTwoRead(deps);

    expect(result.complete).toBe(false);
    expect(result.blocker).toBe("market_base_cpu_ceiling_exceeded");
    expect(result.nextShadowCursor).toBeUndefined();
    expect(result.shadowObservations).toEqual([]);
  });

  it("129 个目的房在 transaction-cost 评估前整轮 fail closed", () => {
    const books = Array.from({ length: 129 }, (_unused, index) =>
      order(`x-${index}`, RESOURCE_CATALYST, 700, 1_000, `E${index}S1`),
    );
    const result = planMarketBaseResourceTwoRead(
      dependencies({
        scope: scope([entry(RESOURCE_CATALYST, ["W1N1"], "writable", 500)]),
        books: {
          [RESOURCE_CATALYST]: books,
        },
      }),
    );

    expect(result.complete).toBe(false);
    expect(result.blocker).toBe(
      "market_base_distinct_order_room_limit_exceeded",
    );
    expect(result.distinctOrderRoomCount).toBe(129);
  });

  it.each([
    ["catalog 外资源", entry(RESOURCE_POWER, ["W1N1"], "writable", 10)],
    [
      "immutable policy 篡改",
      (() => {
        const candidate = immutablePolicyEntry("H", ["W1N1"]);
        return {
          ...candidate,
          policy: {
            ...candidate.policy,
            maxTransactionEnergy: candidate.policy.maxTransactionEnergy - 1,
          },
        };
      })(),
    ],
  ])("%s 在读取任何 book 前 fail closed", (_name, candidate) => {
    const deps = dependencies({
      scope: scope([candidate]),
      books: {
        [RESOURCE_HYDROGEN]: [
          order("h-safe", RESOURCE_HYDROGEN, 700, 1_000, "E1S1"),
        ],
        [RESOURCE_POWER]: [
          order("power-safe", RESOURCE_POWER, 700, 1_000, "E1S1"),
        ],
      },
    });

    const result = planMarketBaseResourceTwoRead(deps);

    expect(result.complete).toBe(false);
    expect(result.blocker).toBe("market_base_scope_limit_or_count_mismatch");
    expect(deps.readCurrentBuyOrders).not.toHaveBeenCalled();
  });

  it("transaction-energy 预算计入 sampled Shadow lane 和其 eligible 目的房", () => {
    const shadow = immutablePolicyEntry(
      "H",
      Array.from({ length: 8 }, (_unused, index) => `W${index + 1}N1`),
      "suspended_shadow",
    );
    const books = Array.from({ length: 128 }, (_unused, index) =>
      order(`h-${index}`, RESOURCE_HYDROGEN, 700, 1_000, `E${index}S1`),
    );

    const result = planMarketBaseResourceTwoRead(
      dependencies({
        scope: scope([shadow]),
        books: { [RESOURCE_HYDROGEN]: books },
      }),
    );

    expect(result.complete).toBe(true);
    expect(result.distinctOrderRoomCount).toBe(128);
    expect(result.transactionCostEvaluationBudget).toBe(2 * 8 * 128);
  });

  it("first planner 后 CPU 超限不返回 Shadow cursor 或可应用证据", () => {
    const deps = dependencies({
      scope: scope([
        immutablePolicyEntry("H", ["W1N1"], "suspended_shadow"),
        immutablePolicyEntry("X", ["W2N2"]),
      ]),
      books: {
        [RESOURCE_HYDROGEN]: [
          order("h-shadow", RESOURCE_HYDROGEN, 700, 1_000, "E1S1"),
        ],
        [RESOURCE_CATALYST]: [
          order("x-write", RESOURCE_CATALYST, 700, 1_000, "E2S2"),
        ],
      },
    });
    const cpuUsed = deps.cpuUsed as jest.Mock;
    cpuUsed.mockImplementation(() => (cpuUsed.mock.calls.length >= 5 ? 26 : 0));

    const result = planMarketBaseResourceTwoRead(deps);

    expect(result.complete).toBe(false);
    expect(result.blocker).toBe("market_base_cpu_ceiling_exceeded");
    expect(result.first?.selected?.order.id).toBe("x-write");
    expect(result.nextShadowCursor).toBeUndefined();
    expect(result.shadowObservations).toEqual([]);
  });

  it("同 tick Shadow 重复 observation 幂等，而冲突 observation 重置证据", () => {
    const admitted = reconcileLiveMarketBaseResourceScope({
      tick: 100,
      accountIdentity: "fixture-user",
      observations: [
        {
          roomName: "W1N1",
          visible: true,
          controllerMy: true,
          controllerOwner: "fixture-user",
          terminalId: "terminal-1",
          terminalOwned: true,
          roomClass: "normal",
        },
      ],
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const laneId = admitted.state.laneLifecycles[0].laneId;
    const observation = {
      laneId,
      result: "safe_opportunity" as const,
    };
    const once = applyMarketBaseResourceShadowObservations(
      admitted.state,
      101,
      [observation],
      laneId,
    );
    const repeated = applyMarketBaseResourceShadowObservations(
      once,
      101,
      [observation],
      laneId,
    );
    const onceLane = once.laneLifecycles.find(
      (lane) => lane.laneId === laneId,
    )!;
    const repeatedLane = repeated.laneLifecycles.find(
      (lane) => lane.laneId === laneId,
    )!;
    expect(repeatedLane).toEqual(onceLane);

    const conflicted = applyMarketBaseResourceShadowObservations(
      repeated,
      102,
      [observation, { laneId, result: "safe_no_opportunity" }],
      laneId,
    );
    const conflictedLane = conflicted.laneLifecycles.find(
      (lane) => lane.laneId === laneId,
    )!;
    expect(conflictedLane.stage).toBe("shadow");
    expect(conflictedLane.shadowEvidence.completeCycles).toBe(0);
    expect(conflictedLane.shadowEvidence.lastCompleteTick).toBe(102);
  });

  it("准入 reconciliation 为8房派生56条 suspended Shadow lane", () => {
    const observations: MarketBaseRoomObservation[] = Array.from(
      { length: 8 },
      (_unused, index) => ({
        roomName: `W${index + 1}N1`,
        visible: true,
        controllerMy: true,
        controllerOwner: "fixture-user",
        terminalId: `terminal-${index}`,
        terminalOwned: true,
        roomClass: index === 3 ? "hub" : "normal",
      }),
    );

    const result = reconcileLiveMarketBaseResourceScope({
      tick: 100,
      accountIdentity: "fixture-user",
      observations,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.sellerRooms).toHaveLength(8);
    expect(result.state.laneLifecycles).toHaveLength(56);
    expect(
      result.state.laneLifecycles.every(
        (lane) => lane.stage === "shadow" && lane.status === "suspended",
      ),
    ).toBe(true);
  });
});

/** 运行时写路径用的最小完整 V3 许可、账本和 live-read 夹具。 */
const V3_TEST_ACCOUNT = "market-base-runtime-test";
const V3_TEST_ROOM = "W9N9";
const V3_V2_HEAD = canonicalStableHashV1("mbr-runtime:v2-head");
const V3_V2_CHECKPOINT = canonicalStableHashV1("mbr-runtime:v2-checkpoint");

function v3Digest(label: string): string {
  return canonicalStableHashV1(`mbr-runtime:${label}`);
}

function v3Config() {
  return resolveMarketSaleAutomationConfig({
    mode: "direct",
    directCapability: "continuous-v3",
    configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
    sellResources: [...MARKET_BASE_RESOURCE_CATALOG],
    hardFloor: Object.fromEntries(
      MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
        policy.resource,
        policy.hardFloor,
      ]),
    ),
    economicFloor: Object.fromEntries(
      MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
        policy.resource,
        policy.economicFloor,
      ]),
    ),
    forecastBuffer: Object.fromEntries(
      MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
        policy.resource,
        policy.laneReserve,
      ]),
    ),
    minDealAmount: 1_000,
    makerBatchAmount: 5_000,
    creditReserve: 0,
    terminalEnergyReserve: 25_000,
    maxDirectDealAmount: 1_000,
    maxDirectDealsPerCycle: 1,
    minDirectOrderAmount: 1_000,
    minDirectOrderNotional: 600_000,
    maxDirectRawOrdersScannedPerCycle: 1_000,
    maxDirectEligibleOrdersPricedPerCycle: 200,
    maxDirectTransactionEnergy: 1_000,
    directCanaryMaxConfirmedDeals: 1,
    energyShadowHardFloor: 20,
    planningSnapshotMaxAgeTicks: 10,
    minHistoryDays: 7,
    minHistoryTransactions: 100,
    minHistoryVolume: 100_000,
    historyFloorRatio: 0.95,
    historyMaxAgeDays: 2,
    canary: { enabled: true, allowExpansion: false },
  });
}

function v3Protection(
  tick: number,
  resource: ResourceConstant,
): MarketProtectionEntry {
  return {
    revision: tick,
    observedAt: tick,
    expiresAt: tick + 10,
    roomName: V3_TEST_ROOM,
    resource,
    totalStock: 200_000,
    terminalStock: 200_000,
    hardReserve: 100_000,
    localReserve: 100_000,
    absoluteTarget: 0,
    consumptiveDemand: 0,
    boostWar: 0,
    hubCommitments: 0,
    productionDemand: 0,
    forecastBuffer: 100_000,
    protectedOutgoing: 0,
    carrierOrInFlight: 0,
    protectedAmount: 100_000,
    grossSurplus: 100_000,
    managedExposure: 0,
    newExposureCapacity: 100_000,
    sellableAmount: 100_000,
    fresh: true,
    blocked: false,
    blockedReasons: [],
    issues: [],
    sourceContributions: [],
  };
}

interface V3RuntimeHarness {
  tick: number;
  claim: boolean;
  execute: unknown;
  terminalResource: number;
  terminalEnergy: number;
  outgoing: Array<{
    transactionId: string;
    time: number;
    amount: number;
    resourceType: ResourceConstant;
    from: string;
    to: string;
    order: { id: string; type: ORDER_BUY; price: number };
  }>;
}

function v3RuntimeFixture(): {
  state: MarketBaseResourceV3RuntimeState;
  harness: V3RuntimeHarness;
  deps: MarketBaseResourceRuntimeDependencies & {
    commitPreparedState: jest.Mock;
    validatePreparedCanonicalRoot: jest.Mock;
    cpuUsed: jest.Mock;
    claimPrepared: jest.Mock;
    executePrepared: jest.Mock;
    releasePrepared: jest.Mock;
    readCurrentBuyOrders: jest.Mock;
    readTrustedFloors: jest.Mock;
  };
  input: () => MarketBaseResourceAutomationInput;
} {
  Game.rooms = {
    [V3_TEST_ROOM]: {
      name: V3_TEST_ROOM,
      controller: {
        my: true,
        owner: { username: V3_TEST_ACCOUNT },
      },
      terminal: {
        id: "terminal:W9N9",
        my: true,
        owner: { username: V3_TEST_ACCOUNT },
      },
    } as Room,
  };
  const reconciled = reconcileLiveMarketBaseResourceScope({
    tick: 100,
    accountIdentity: V3_TEST_ACCOUNT,
    observations: [
      {
        roomName: V3_TEST_ROOM,
        visible: true,
        controllerMy: true,
        controllerOwner: V3_TEST_ACCOUNT,
        terminalId: "terminal:W9N9",
        terminalOwned: true,
        roomClass: "normal",
      },
    ],
  });
  if (!reconciled.ok) throw new Error("fixture scope rejected");
  const lanes = reconciled.state.laneLifecycles.map((lane) =>
    lane.resource === RESOURCE_CATALYST
      ? {
          ...lane,
          stage: "canary" as const,
          status: "writable" as const,
          shadowEvidence: {
            completeCycles: 100,
            lastCompleteTick: 100,
            evidenceDigest: v3Digest(`qualified:${lane.laneId}`),
          },
        }
      : lane,
  );
  const scopeState = { ...reconciled.state, laneLifecycles: lanes };
  const rawLegacyPermit = buildMarketDirectContinuousPermit({
    epoch: 1,
    accountIdentity: V3_TEST_ACCOUNT,
    sharedDirectFingerprint: v3Digest("v2-shared"),
    entryGrants: MARKET_DIRECT_CONTINUOUS_EXECUTION_TABLE.map((entry) => ({
      entryId: entry.entryId,
      stage:
        entry.resourceType === RESOURCE_CATALYST
          ? ("continuous" as const)
          : ("shadow" as const),
      newDealGrant:
        entry.resourceType === RESOURCE_CATALYST
          ? ("enabled" as const)
          : ("suspended" as const),
      resourceFingerprint: entry.resourceFingerprint,
      lifecycleEvidenceDigest: v3Digest(`v2-lifecycle:${entry.entryId}`),
    })),
    reviewedEvidence: [],
    previousPermitId: "",
    previousPermitHead: v3Digest("v2-genesis"),
    previousLedgerHead: V3_V2_HEAD,
    createdAt: 99,
    operatorAuthorizationFingerprint: v3Digest("v2-operator"),
  });
  const legacy = wrapAuthenticatedLegacyV2PermitRecord({
    rawRecord: rawLegacyPermit,
    authenticated: true,
  });
  let chain = createMarketBaseResourcePermitChainState({
    legacyV2PermitRecords: [legacy],
  });
  const shared = createMarketBaseSharedPolicy(V3_TEST_ACCOUNT);
  const cutover = buildMarketBaseResourceV2EventCutoverCheckpoint({
    lastV2AttemptSeq: 0,
    lastV2OutcomeSeq: 0,
    v2ReceiptHeadHash: V3_V2_HEAD,
    v2LedgerCheckpointHash: V3_V2_CHECKPOINT,
  });
  const ratchetHighWater =
    buildMarketBaseResourceBootstrapRatchetHighWater(100);
  const operatorAuthorizationFingerprint =
    marketBaseResourceOperatorAuthorizationFingerprint(v3Config());
  const first = buildMarketBaseResourcePermit({
    epoch: 2,
    accountIdentity: V3_TEST_ACCOUNT,
    sharedPolicy: shared,
    ratchetHighWater,
    signedLaneGrants: lanes.map((lane) =>
      buildMarketBaseResourceSignedLaneGrant({ lane, stage: "shadow" }),
    ),
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V3_V2_HEAD,
    v2EventCutoverCheckpoint: cutover,
    legacyV2GrantSuspension: buildMarketBaseResourceLegacyV2GrantSuspension({
      previousPermitId: chain.currentPermitId,
      previousPermitHead: chain.permitChainHead,
      cutoverCheckpointHash: cutover.checkpointHash,
    }),
    createdAt: 100,
    operatorAuthorizationFingerprint,
  });
  const append = (permit: ReturnType<typeof buildMarketBaseResourcePermit>) => {
    const result = appendMarketBaseResourcePermit(chain, permit, {
      tick: 100,
      currentShard: "shard1",
      currentLedgerHead: V3_V2_HEAD,
      currentV2LedgerCheckpointHash: V3_V2_CHECKPOINT,
      currentV2AttemptSeqHighWater: 0,
      currentV2OutcomeSeqHighWater: 0,
      currentDerivedLanes: lanes,
      currentLifecycleCheckpointCommitment:
        marketBaseDerivedLaneLifecycleCheckpointCommitment(lanes),
      hasPending: false,
      hasQuarantine: false,
      hasGap: false,
      hasUnmatchedReservation: false,
    });
    if (result.status !== "appended") {
      throw new Error("reason" in result ? result.reason : result.status);
    }
    chain = result.state;
  };
  append(first);
  const canaryGrant = buildMarketBaseResourceSignedLaneGrant({
    lane: lanes.find((lane) => lane.resource === RESOURCE_CATALYST)!,
    stage: "canary",
    newDealGrant: "enabled",
  });
  append(
    buildMarketBaseResourcePermit({
      epoch: 3,
      accountIdentity: V3_TEST_ACCOUNT,
      sharedPolicy: shared,
      ratchetHighWater,
      signedLaneGrants: lanes.map((lane) =>
        lane.resource === RESOURCE_CATALYST
          ? canaryGrant
          : buildMarketBaseResourceSignedLaneGrant({ lane, stage: "shadow" }),
      ),
      reviewedEvidence: [
        {
          laneId: canaryGrant.laneId,
          kind: "shadow_qualification",
          evidenceKey: v3Digest("qualified:x"),
          digest: canaryGrant.lifecycleEvidenceDigest,
        },
      ],
      previousPermitId: chain.currentPermitId,
      previousPermitHead: chain.permitChainHead,
      previousLedgerHead: V3_V2_HEAD,
      createdAt: 101,
      operatorAuthorizationFingerprint,
    }),
  );
  const migrationBasis =
    buildMarketBaseResourceAuthenticatedV2LedgerMigrationBasis({
      tick: 100,
      cutoverCheckpoint: cutover,
      v2PrunedThroughAttemptSeq: 0,
      legacyQuotaReceipts: [],
      legacyV2ConfirmedCanaries: {},
      lifetimeConfirmed: {
        global: { count: 0, amount: 0 },
        resources: {},
        rooms: {},
        lanes: {},
      },
      retryNotBefore: 0,
      authenticated: true,
    });
  const pricingRatchet = buildMarketBaseResourcePricingRatchetState({
    initializedAt: 100,
    entries: ratchetHighWater.map((entry) => ({
      resource: entry.resource,
      value: entry.ratchetFloor,
      marketDate: "2026-07-27",
    })),
  });
  const harness: V3RuntimeHarness = {
    tick: 101,
    claim: true,
    execute: OK,
    terminalResource: 200_000,
    terminalEnergy: 50_000,
    outgoing: [],
  };
  const ledger = createMarketBaseResourceLedger({
    tick: 100,
    permitChain: chain,
    migrationBasis,
  });
  const deps = {
    readCurrentBuyOrders: jest.fn((resource: ResourceConstant) =>
      resource === RESOURCE_CATALYST
        ? [order("x-buy", resource, 700, 1_000, "E1S1")]
        : [],
    ),
    readOwnOrders: jest.fn(() => []),
    readTerminal: jest.fn((roomName: string, resource: ResourceConstant) => ({
      roomName,
      terminalId: "terminal:W9N9",
      owned: true,
      ready: true,
      cooldown: 0,
      resourceAmount: harness.terminalResource,
      energy: harness.terminalEnergy,
      nativeMineralType: resource,
      effectivePostDealEnergyReserve: 25_000,
      revision: `terminal:${harness.tick}`,
    })),
    readCredits: jest.fn(() => 10_000_000),
    readAccountIdentity: jest.fn(() => V3_TEST_ACCOUNT),
    readExecutorShard: jest.fn(() => "shard1"),
    readArbiterSnapshot: jest.fn(() => ({
      blocked: false,
      revision: `arbiter:${harness.tick}`,
    })),
    readOutgoingWindow: jest.fn(() => ({
      observedAt: harness.tick,
      coversAttemptAt: true,
      transactions: harness.outgoing,
    })),
    readTrustedFloors: jest.fn(() => ({
      ...Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          {
            value: policy.economicFloor,
            marketDate: "2026-07-27",
            updatedAt: harness.tick,
          },
        ]),
      ),
      [RESOURCE_ENERGY]: {
        value: 20,
        marketDate: "2026-07-27",
        updatedAt: harness.tick,
      },
    })),
    calculateTransactionEnergy: jest.fn(() => 0),
    cpuUsed: jest.fn(() => 1),
    // Unit harness 充当 outer activation owner：每次调用从当前 canonical
    // fixture 重建 full anchor。生产路径只会返回已持久化的双份 outer
    // anchor，另有 MarketSale CAS/rollback 回归覆盖。
    readLedgerRuntimeAnchor: jest.fn(
      (current: MarketBaseResourceV3RuntimeState) =>
        buildMarketBaseResourceLedgerRuntimeAnchor(
          current.ledger!,
          current.permitChain!,
        ),
    ),
    commitPreparedState: jest.fn(
      (
        _state: MarketBaseResourceV3RuntimeState,
        _anchor: ReturnType<typeof buildMarketBaseResourceLedgerRuntimeAnchor>,
      ) => {
        return true;
      },
    ),
    validatePreparedCanonicalRoot: jest.fn(() => true),
    claimPrepared: jest.fn(() => harness.claim),
    executePrepared: jest.fn(() => harness.execute),
    releasePrepared: jest.fn(),
  } as unknown as MarketBaseResourceRuntimeDependencies & {
    commitPreparedState: jest.Mock;
    validatePreparedCanonicalRoot: jest.Mock;
    cpuUsed: jest.Mock;
    claimPrepared: jest.Mock;
    executePrepared: jest.Mock;
    releasePrepared: jest.Mock;
    readCurrentBuyOrders: jest.Mock;
    readTrustedFloors: jest.Mock;
  };
  return {
    state: {
      schemaVersion: 3,
      catalog: {
        revision: MARKET_BASE_RESOURCE_CATALOG_REVISION,
        configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
        resources: [...MARKET_BASE_RESOURCE_CATALOG],
      },
      scope: scopeState,
      permitChain: chain,
      ledger,
      pricingRatchet,
      cutoverLatched: true,
    },
    harness,
    deps,
    input: () => ({
      tick: harness.tick,
      fullPlanningTick: true,
      config: v3Config(),
      readCandidates: () =>
        MARKET_BASE_RESOURCE_POLICIES.map(
          (policy): MarketBaseResourceRuntimeCandidate => ({
            roomName: V3_TEST_ROOM,
            resourceType: policy.resource,
            protectionEntry: v3Protection(harness.tick, policy.resource),
            historyTrusted: true,
            historyFloor: policy.economicFloor,
            ratchetFloor: policy.economicFloor,
            effectiveNetFloor: policy.economicFloor,
            effectiveEnergyShadowPrice: 20,
            energyShadowObservedAt: harness.tick,
            energyShadowComponents: {
              hardFloor: 20,
              historyFloor: 20,
              ratchetFloor: 20,
            },
            capacityState: "normal",
            isHubRoom: false,
            rejectionReasons: [],
          }),
        ),
      makerExposurePresent: false,
      emergencyStop: false,
    }),
  };
}

function currentPolicyPricingRatchet(initializedAt = 100) {
  return buildMarketBaseResourcePricingRatchetState({
    initializedAt,
    entries: MARKET_BASE_RESOURCE_POLICIES.map((policy) => ({
      resource: policy.resource,
      value: policy.economicFloor,
      marketDate: "2026-07-27",
    })),
  });
}

function currentScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
): MarketBaseResourcePermit {
  const current = chain.retainedPermits[chain.retainedPermits.length - 1];
  if (!current || current.schemaVersion !== 3) {
    throw new Error("scope churn requires current v3 permit");
  }
  return current;
}

function buildScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  grants: readonly MarketBaseResourceSignedLaneGrant[],
  tick: number,
): MarketBaseResourcePermit {
  return buildMarketBaseResourcePermit({
    epoch: chain.permitEpochHighWater + 1,
    accountIdentity: V3_TEST_ACCOUNT,
    sharedPolicy: createMarketBaseSharedPolicy(V3_TEST_ACCOUNT),
    ratchetHighWater: currentScopeChurnPermit(chain).ratchetHighWater,
    signedLaneGrants: grants,
    previousPermitId: chain.currentPermitId,
    previousPermitHead: chain.permitChainHead,
    previousLedgerHead: V3_V2_HEAD,
    createdAt: tick,
    operatorAuthorizationFingerprint:
      marketBaseResourceOperatorAuthorizationFingerprint(v3Config()),
  });
}

function appendScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  permit: MarketBaseResourcePermit,
  lanes: readonly MarketBaseDerivedLaneLifecycle[],
  tick: number,
): MarketBaseResourcePermitChainState {
  const result = appendMarketBaseResourcePermit(chain, permit, {
    tick,
    currentShard: "shard1",
    currentLedgerHead: V3_V2_HEAD,
    currentLedgerCheckpointHash: v3Digest("scope-churn-ledger-checkpoint"),
    currentLedgerPermitAnchorHash: v3Digest("scope-churn-ledger-anchor"),
    currentV2LedgerCheckpointHash: V3_V2_CHECKPOINT,
    currentV2AttemptSeqHighWater: 0,
    currentV2OutcomeSeqHighWater: 0,
    currentDerivedLanes: lanes,
    currentLifecycleCheckpointCommitment:
      marketBaseDerivedLaneLifecycleCheckpointCommitment(lanes),
    hasPending: false,
    hasQuarantine: false,
    hasGap: false,
    hasUnmatchedReservation: false,
  });
  if (result.status !== "appended") {
    throw new Error(
      `${result.status}:${"reason" in result ? result.reason : "unexpected"}`,
    );
  }
  return result.state;
}

function rolloverScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  oldLanes: readonly MarketBaseDerivedLaneLifecycle[],
  newLanes: readonly MarketBaseDerivedLaneLifecycle[],
  tick: number,
): {
  state: MarketBaseResourcePermitChainState;
  nextActive: readonly MarketBaseResourceSignedLaneGrant[];
} {
  const current = currentScopeChurnPermit(chain);
  const oldLaneById = new Map(oldLanes.map((lane) => [lane.laneId, lane]));
  const nextActive = newLanes.map((lane) =>
    buildMarketBaseResourceSignedLaneGrant({
      lane,
      stage: "shadow",
      newDealGrant: "suspended",
    }),
  );
  const tombstones = current.signedLaneGrants.map((grant) =>
    buildMarketBaseResourceSignedLaneGrant({
      lane: oldLaneById.get(grant.laneId)!,
      status: "tombstoned",
      stage: grant.stage,
      newDealGrant: "suspended",
      lifecycleEvidenceDigest: grant.lifecycleEvidenceDigest,
      reviewDigest: grant.reviewDigest,
    }),
  );
  return {
    state: appendScopeChurnPermit(
      chain,
      buildScopeChurnPermit(chain, [...nextActive, ...tombstones], tick),
      newLanes,
      tick,
    ),
    nextActive,
  };
}

function advanceScopeChurnPermit(
  chain: MarketBaseResourcePermitChainState,
  oldLanes: readonly MarketBaseDerivedLaneLifecycle[],
  newLanes: readonly MarketBaseDerivedLaneLifecycle[],
  tick: number,
): MarketBaseResourcePermitChainState {
  const rollover = rolloverScopeChurnPermit(chain, oldLanes, newLanes, tick);
  return appendScopeChurnPermit(
    rollover.state,
    buildScopeChurnPermit(rollover.state, rollover.nextActive, tick + 1),
    newLanes,
    tick + 1,
  );
}

function scopeChurnObservations(
  generation: number,
): MarketBaseRoomObservation[] {
  return [
    V3_TEST_ROOM,
    ...Array.from({ length: 15 }, (_value, index) => `E${index + 1}N1`),
  ].map((roomName, index) => ({
    roomName,
    visible: true,
    controllerMy: true,
    controllerOwner: V3_TEST_ACCOUNT,
    terminalId: `terminal:scope-churn:${generation}:${roomName}`,
    terminalOwned: true,
    roomClass: (generation + index) % 2 === 0 ? "normal" : "hub",
  }));
}

describe("Market Base Resource scope tombstone discharge", () => {
  it("只允许未 cutover 且空 ring 的旧 scope 建立 empty checkpoint", () => {
    const initial = reconcileLiveMarketBaseResourceScope({
      tick: 10,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: [scopeChurnObservations(0)[0]],
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const legacyEmpty = JSON.parse(JSON.stringify(initial.state)) as any;
    delete legacyEmpty.laneTombstoneDischargeCheckpoint;
    const migrated = reconcileLiveMarketBaseResourceScope({
      tick: 11,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: [scopeChurnObservations(0)[0]],
      previous: legacyEmpty,
    });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.state.laneTombstoneDischargeCheckpoint).toMatchObject({
      dischargedCount: 0,
      hashRevision: "market-base-resource-scope-lane-tombstones-v1",
    });

    const withTombstones = reconcileLiveMarketBaseResourceScope({
      tick: 12,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: [scopeChurnObservations(1)[0]],
      previous: migrated.state,
    });
    expect(withTombstones.ok).toBe(true);
    if (!withTombstones.ok) return;
    const missingWithHistory = JSON.parse(
      JSON.stringify(withTombstones.state),
    ) as any;
    delete missingWithHistory.laneTombstoneDischargeCheckpoint;
    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 13,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: [scopeChurnObservations(1)[0]],
        previous: missingWithHistory,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_invalid"],
    });
  });

  it("已 cutover/V3 permit 即使 ring 为空也不能重建 scope discharge genesis", () => {
    const fixture = v3RuntimeFixture();
    const missingCheckpoint = JSON.parse(
      JSON.stringify(fixture.state.scope),
    ) as any;
    delete missingCheckpoint.laneTombstoneDischargeCheckpoint;
    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 101,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: [
          {
            roomName: V3_TEST_ROOM,
            visible: true,
            controllerMy: true,
            controllerOwner: V3_TEST_ACCOUNT,
            terminalId: "terminal:W9N9",
            terminalOwned: true,
            roomClass: "normal",
          },
        ],
        previous: missingCheckpoint,
        permitChain: fixture.state.permitChain,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_invalid"],
    });
  });

  it("current permit grant 未 discharge 时保持 tombstone，historical pending pin 延迟 exact 消费", () => {
    const fixture = v3RuntimeFixture();
    const firstRetirement = reconcileLiveMarketBaseResourceScope({
      tick: 200,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(1),
      previous: fixture.state.scope,
    });
    expect(firstRetirement.ok).toBe(true);
    if (!firstRetirement.ok) return;
    const rollover = rolloverScopeChurnPermit(
      fixture.state.permitChain!,
      fixture.state.scope!.laneLifecycles,
      firstRetirement.state.laneLifecycles,
      2_000,
    );
    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 201,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(1),
        previous: firstRetirement.state,
        permitChain: rollover.state,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_pin_set_missing"],
    });
    const currentPinned = reconcileLiveMarketBaseResourceScope({
      tick: 201,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(1),
      previous: firstRetirement.state,
      permitChain: rollover.state,
      pinnedLaneIds: [],
    });
    expect(currentPinned.ok).toBe(true);
    if (!currentPinned.ok) return;
    expect(currentPinned.state.recentLaneTombstones).toHaveLength(7);
    expect(
      currentPinned.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(0);

    const discharged = appendScopeChurnPermit(
      rollover.state,
      buildScopeChurnPermit(rollover.state, rollover.nextActive, 2_001),
      firstRetirement.state.laneLifecycles,
      2_001,
    );
    const pendingLaneId = currentPinned.state.recentLaneTombstones[0].laneId;
    const pendingPinned = reconcileLiveMarketBaseResourceScope({
      tick: 202,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(1),
      previous: currentPinned.state,
      permitChain: discharged,
      pinnedLaneIds: [pendingLaneId],
    });
    expect(pendingPinned.ok).toBe(true);
    if (!pendingPinned.ok) return;
    expect(pendingPinned.state.recentLaneTombstones).toHaveLength(1);
    expect(pendingPinned.state.recentLaneTombstones[0].laneId).toBe(
      pendingLaneId,
    );
    expect(
      pendingPinned.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(6);
  });

  it("33+ room incarnation 形成 225+ lane retirement 时只消费 exact permit discharge", () => {
    const fixture = v3RuntimeFixture();
    let scopeState = fixture.state.scope!;
    let chain = fixture.state.permitChain!;
    let oldLanes = scopeState.laneLifecycles;
    const initialScope = JSON.parse(
      JSON.stringify(scopeState),
    ) as MarketBaseResourceScopeState;

    for (let generation = 1; generation <= 2; generation += 1) {
      const reconciled = reconcileLiveMarketBaseResourceScope({
        tick: 200 + generation * 2,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(generation),
        previous: scopeState,
      });
      expect(reconciled.ok).toBe(true);
      if (!reconciled.ok) return;
      scopeState = reconciled.state;
      const newLanes = scopeState.laneLifecycles;
      chain = advanceScopeChurnPermit(
        chain,
        oldLanes,
        newLanes,
        2_000 + generation * 2,
      );
      oldLanes = newLanes;
    }
    expect(scopeState.recentLaneTombstones).toHaveLength(119);
    expect(chain.laneTombstoneCheckpoint.dischargedTombstones).toHaveLength(
      119,
    );
    expect(chain.laneTombstoneCheckpoint.compressedCount).toBe(0);

    const forged = JSON.parse(
      JSON.stringify(chain),
    ) as MarketBaseResourcePermitChainState;
    (forged.laneTombstoneCheckpoint.dischargedTombstones[0] as any).sellerRoom =
      "W0N0";
    const unauthenticated = reconcileLiveMarketBaseResourceScope({
      tick: 206,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(3),
      previous: scopeState,
      permitChain: forged,
    });
    expect(unauthenticated.ok).toBe(false);
    if (unauthenticated.ok === false) {
      expect(unauthenticated.blockers[0]).toMatch(
        /^derived_lane_tombstone_permit_invalid:/,
      );
    }

    const pinnedLaneId = scopeState.recentLaneTombstones[0].laneId;
    const pinned = reconcileLiveMarketBaseResourceScope({
      tick: 206,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(3),
      previous: scopeState,
      permitChain: chain,
      pinnedLaneIds: [pinnedLaneId],
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.state.recentLaneTombstones).toHaveLength(113);
    expect(
      pinned.state.recentLaneTombstones.some(
        (lane) => lane.laneId === pinnedLaneId,
      ),
    ).toBe(true);
    expect(pinned.state.laneTombstoneDischargeCheckpoint.dischargedCount).toBe(
      118,
    );

    const unpinned = reconcileLiveMarketBaseResourceScope({
      tick: 207,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(3),
      previous: pinned.state,
      permitChain: chain,
      pinnedLaneIds: [],
      expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
        pinned.state.laneTombstoneDischargeCheckpoint.checkpointCommitment,
    });
    expect(unpinned.ok).toBe(true);
    if (!unpinned.ok) return;
    expect(unpinned.state.recentLaneTombstones).toHaveLength(112);
    expect(
      unpinned.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(119);

    const generation33Lanes = unpinned.state.laneLifecycles;
    chain = advanceScopeChurnPermit(chain, oldLanes, generation33Lanes, 2_100);
    expect(chain.laneTombstoneCheckpoint.compressedCount).toBe(7);
    expect(chain.laneTombstoneCheckpoint.dischargedTombstones).toHaveLength(
      224,
    );

    const generation34 = reconcileLiveMarketBaseResourceScope({
      tick: 208,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(4),
      previous: unpinned.state,
      permitChain: chain,
      pinnedLaneIds: [],
    });
    expect(generation34.ok).toBe(true);
    if (!generation34.ok) return;
    expect(
      generation34.state.laneTombstoneDischargeCheckpoint.dischargedCount,
    ).toBe(231);
    expect(generation34.state.recentLaneTombstones).toHaveLength(112);

    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 209,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(4),
        previous: generation34.state,
        permitChain: chain,
        expectedPermitLaneTombstoneCheckpointCommitment: v3Digest(
          "rolled-permit-tombstone-checkpoint",
        ),
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_permit_checkpoint_rollback"],
    });

    const tampered = JSON.parse(
      JSON.stringify(generation34.state),
    ) as MarketBaseResourceScopeState;
    (tampered.laneTombstoneDischargeCheckpoint as any).dischargedPrefixHead =
      v3Digest("tampered-scope-discharge");
    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 209,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(4),
        previous: tampered,
        permitChain: chain,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_invalid"],
    });

    expect(
      reconcileLiveMarketBaseResourceScope({
        tick: 209,
        accountIdentity: V3_TEST_ACCOUNT,
        observations: scopeChurnObservations(4),
        previous: unpinned.state,
        permitChain: chain,
        expectedPreviousLaneTombstoneDischargeCheckpointCommitment:
          generation34.state.laneTombstoneDischargeCheckpoint
            .checkpointCommitment,
      }),
    ).toEqual({
      ok: false,
      blockers: ["derived_lane_tombstone_scope_checkpoint_rollback"],
    });

    const oldLaneRevival = reconcileLiveMarketBaseResourceScope({
      tick: 209,
      accountIdentity: V3_TEST_ACCOUNT,
      observations: scopeChurnObservations(0),
      previous: initialScope,
      permitChain: chain,
      expectedPreviousRoomCheckpointCommitment:
        generation34.state.roomRegistry.checkpointCommitment,
    });
    expect(oldLaneRevival.ok).toBe(false);
    if (oldLaneRevival.ok === false) {
      expect(oldLaneRevival.blockers).toContain(
        "room_incarnation_external_checkpoint_mismatch",
      );
    }
  });
});

describe("Market Base Resource V3 live WAL glue", () => {
  it("可信价格上调会在 prepare commit 前单调持久化到 state ratchet", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();

    runMarketBaseResourceAutomation(state, input(), deps);

    expect(state.pricingRatchet?.entries).toEqual(
      currentPolicyPricingRatchet().entries,
    );
    expect(
      deps.commitPreparedState.mock.calls[0][0].pricingRatchet.entries,
    ).toEqual(currentPolicyPricingRatchet().entries);
  });

  it("可信 floor 下降时整轮零 commit、零 claim、零 deal", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    state.pricingRatchet = currentPolicyPricingRatchet();
    deps.readTrustedFloors.mockReturnValue({
      ...Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          {
            value:
              policy.resource === RESOURCE_CATALYST
                ? policy.economicFloor - 1
                : policy.economicFloor,
            marketDate: "2026-07-27",
            updatedAt: harness.tick,
          },
        ]),
      ),
      [RESOURCE_ENERGY]: {
        value: 20,
        marketDate: "2026-07-27",
        updatedAt: harness.tick,
      },
    });

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.planComplete).toBe(false);
    expect(result.rejectedByReason).toHaveProperty(
      "market_base_v3_pricing_ratchet_rollback:X",
    );
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("state ratchet 回拨后不能借旧 trusted floor 自动修复", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    const rolledBack = MARKET_BASE_RESOURCE_POLICIES.map((policy) => ({
      resource: policy.resource,
      value:
        policy.resource === RESOURCE_CATALYST
          ? MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources[policy.resource]
              .ratchetFloor
          : policy.economicFloor,
      marketDate: "2026-07-27",
    }));
    state.pricingRatchet = buildMarketBaseResourcePricingRatchetState({
      initializedAt: 100,
      entries: rolledBack,
    });
    deps.readTrustedFloors.mockReturnValue({
      ...Object.fromEntries(
        MARKET_BASE_RESOURCE_POLICIES.map((policy) => [
          policy.resource,
          {
            value: policy.economicFloor,
            marketDate: "2026-07-27",
            updatedAt: harness.tick - 1,
          },
        ]),
      ),
      [RESOURCE_ENERGY]: {
        value: 20,
        marketDate: "2026-07-27",
        updatedAt: harness.tick,
      },
    });

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.planComplete).toBe(false);
    expect(result.rejectedByReason).toHaveProperty(
      "market_base_v3_pricing_ratchet_rollback:X",
    );
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("Energy 影子价必须逐字绑定可信 Energy ratchet 与分量最大值", () => {
    const { state, deps, input } = v3RuntimeFixture();
    const originalInput = input();
    const result = runMarketBaseResourceAutomation(
      state,
      {
        ...originalInput,
        readCandidates: () =>
          originalInput.readCandidates().map((candidate) => ({
            ...candidate,
            // 低报 effective 值，即使其余市场/库存证据完整也不得进入排序。
            effectiveEnergyShadowPrice: 1,
          })),
      },
      deps,
    );

    expect(result.planComplete).toBe(false);
    expect(Object.keys(result.rejectedByReason)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^market_base_v3_candidate_incomplete:${V3_TEST_ROOM}:`),
        ),
      ]),
    );
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("Energy 可选分量显式为 undefined 时先规范化再生成 canonical evidence", () => {
    const { state, deps, input } = v3RuntimeFixture();
    const runtimeInput = input();
    const originalReadCandidates = runtimeInput.readCandidates;
    runtimeInput.readCandidates = () =>
      originalReadCandidates().map((candidate) => ({
        ...candidate,
        energyShadowComponents: {
          ...candidate.energyShadowComponents,
          explicit: undefined,
        },
      }));
    deps.readCurrentBuyOrders.mockReturnValue([]);

    const result = runMarketBaseResourceAutomation(
      state,
      runtimeInput,
      deps,
    );

    expect(result.planComplete).toBe(true);
    expect(result.rejectedByReason).not.toHaveProperty(
      "canonical value contains undefined",
    );
    expect(state.lastPlanningSnapshot).toMatchObject({
      complete: true,
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("非 canonical protection 可选字段不得被洗白且在 commit 前闭锁", () => {
    const { state, deps, input } = v3RuntimeFixture();
    const runtimeInput = input();
    const originalReadCandidates = runtimeInput.readCandidates;
    runtimeInput.readCandidates = () =>
      originalReadCandidates().map((candidate) => ({
        ...candidate,
        protectionEntry: {
          ...candidate.protectionEntry,
          sourceContributions: [
            {
              dedupeKey: "floor:test",
              stableKey: "floor:test",
              anonymous: false,
              bucket: "hardReserve",
              amount: 100_000,
              sourceKinds: ["floor"],
              managedOrderId: undefined,
              observedAt: candidate.protectionEntry.observedAt,
              expiresAt: candidate.protectionEntry.expiresAt,
            },
          ],
        },
      }));

    const result = runMarketBaseResourceAutomation(
      state,
      runtimeInput,
      deps,
    );

    expect(result.planComplete).toBe(false);
    expect(result.rejectedByReason).toHaveProperty(
      "canonical value contains undefined",
    );
    expect(state.lastPlanningSnapshot).toMatchObject({
      complete: false,
      blocker: "canonical value contains undefined",
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("candidate ratchet floor 低于 current high-water 时整轮零写", () => {
    const { state, deps, input } = v3RuntimeFixture();
    state.pricingRatchet = currentPolicyPricingRatchet();
    const runtimeInput = input();
    const originalReadCandidates = runtimeInput.readCandidates;
    runtimeInput.readCandidates = () =>
      originalReadCandidates().map((candidate) =>
        candidate.resourceType === RESOURCE_CATALYST
          ? {
              ...candidate,
              ratchetFloor:
                MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[RESOURCE_CATALYST]
                  .economicFloor - 1,
            }
          : candidate,
      );

    const result = runMarketBaseResourceAutomation(state, runtimeInput, deps);

    expect(result.planComplete).toBe(false);
    expect(Object.keys(result.rejectedByReason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("market_base_v3_candidate_incomplete"),
      ]),
    );
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("late second-read blocker 不吞掉已确定的 lane-local incomplete reset", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    const hydrogenLane = state.scope!.laneLifecycles.find(
      (lane) => lane.resource === RESOURCE_HYDROGEN,
    )!;
    for (let tick = 101; tick <= 199; tick += 1) {
      state.scope = applyMarketBaseResourceShadowObservations(
        state.scope!,
        tick,
        [
          {
            laneId: hydrogenLane.laneId,
            result: "safe_no_opportunity",
          },
        ],
        hydrogenLane.laneId,
      );
    }
    expect(
      state.scope.laneLifecycles.find(
        (lane) => lane.laneId === hydrogenLane.laneId,
      )?.shadowEvidence.completeCycles,
    ).toBe(99);
    harness.tick = 200;
    let catalystRead = 0;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (resource === RESOURCE_HYDROGEN) {
          throw new Error("hydrogen book incomplete");
        }
        if (resource === RESOURCE_CATALYST) {
          catalystRead += 1;
          return [
            order(
              "x-buy",
              resource,
              catalystRead === 1 ? 700 : 701,
              1_000,
              "E1S1",
            ),
          ];
        }
        return [];
      },
    );

    const result = runMarketBaseResourceAutomation(state, input(), deps);
    const reset = state.scope.laneLifecycles.find(
      (lane) => lane.laneId === hydrogenLane.laneId,
    )!;

    expect(result.planComplete).toBe(false);
    expect(result.rejectedByReason).toHaveProperty(
      "market_base_second_read_changed",
    );
    expect(reset.stage).toBe("shadow");
    expect(reset.shadowEvidence.completeCycles).toBe(0);
    expect(reset.shadowEvidence.lastCompleteTick).toBe(200);
    expect(state.scope.shadowCursor).toBe(hydrogenLane.laneId);
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("prepare 在 claim/deal 前持久化，且同 tick 最多执行一次", () => {
    const { state, deps, input } = v3RuntimeFixture();
    const first = runMarketBaseResourceAutomation(state, input(), deps);
    runMarketBaseResourceAutomation(state, input(), deps);
    expect(state.ledger?.pending).toBeDefined();
    expect(state.ledger?.pending?.executionEvidence).toMatchObject({
      terminalResourceBefore: 200_000,
      terminalEnergyBefore: 50_000,
      terminalCooldownBefore: 0,
      creditsBefore: 10_000_000,
      observedOrderAmount: 1_000,
      observedOrderPriceMilli: 700_000,
      outgoingTransactionKeysBefore: [],
      outgoingWindowObservedAt: 101,
      outgoingWindowCoversAttemptAt: true,
    });
    // evidence 必须来自 prepare 前的第二次完整读；不得在 claim/deal 后补读。
    expect(deps.readCredits).toHaveBeenCalledTimes(2);
    expect(deps.commitPreparedState).toHaveBeenCalledTimes(1);
    expect(deps.claimPrepared).toHaveBeenCalledTimes(1);
    expect(deps.executePrepared).toHaveBeenCalledTimes(1);
    expect(deps.commitPreparedState.mock.invocationCallOrder[0]).toBeLessThan(
      deps.claimPrepared.mock.invocationCallOrder[0],
    );
    expect(deps.commitPreparedState.mock.invocationCallOrder[0]).toBeLessThan(
      deps.executePrepared.mock.invocationCallOrder[0],
    );
    const expectedAnchor = buildMarketBaseResourceLedgerRuntimeAnchor(
      state.ledger!,
      state.permitChain!,
    );
    expect(first.ledgerRuntimeAnchor).toEqual(expectedAnchor);
    expect(deps.commitPreparedState.mock.calls[0]?.[1]).toEqual(expectedAnchor);
  });

  it("runtime session 铸造后的 scope nested bitflip 由快照校验闭锁且零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let attacked = false;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (!attacked) {
          attacked = true;
          const target = state.scope!.laneLifecycles.find(
            (lane) => lane.resource === RESOURCE_CATALYST,
          )!;
          (
            target as unknown as {
              status: "retired";
            }
          ).status = "retired";
        }
        return resource === RESOURCE_CATALYST
          ? [order("x-buy", resource, 700, 1_000, "E1S1")]
          : [];
      },
    );

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_scope_snapshot_mismatch: 1,
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("runtime session 铸造后替换 scope 并单改 registry incarnation high-water 仍闭锁且零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let attacked = false;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (!attacked) {
          attacked = true;
          const forged = JSON.parse(
            JSON.stringify(state.scope),
          ) as MarketBaseResourceScopeState;
          const room = forged.roomRegistry.rooms[V3_TEST_ROOM]!;
          (
            room as unknown as {
              incarnationHighWater: number;
            }
          ).incarnationHighWater += 1;
          // 故意保留 registry 自报 checkpoint；inner exact commitment 必须
          // 承诺完整 registry payload，不能只信 checkpoint digest。
          state.scope = forged;
        }
        return resource === RESOURCE_CATALYST
          ? [order("x-buy", resource, 700, 1_000, "E1S1")]
          : [];
      },
    );

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_scope_snapshot_mismatch: 1,
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("runtime session 铸造后的 current permit grant 替换统一闭锁且零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let attacked = false;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (!attacked) {
          attacked = true;
          const forged = JSON.parse(
            JSON.stringify(state.permitChain),
          ) as MarketBaseResourcePermitChainState;
          const current = forged.retainedPermits[
            forged.retainedPermits.length - 1
          ] as MarketBaseResourcePermit;
          const target = current.signedLaneGrants.find(
            (grant) => grant.resource === RESOURCE_CATALYST,
          )!;
          (
            target as unknown as {
              newDealGrant: "suspended";
            }
          ).newDealGrant = "suspended";
          state.permitChain = forged;
        }
        return resource === RESOURCE_CATALYST
          ? [order("x-buy", resource, 700, 1_000, "E1S1")]
          : [];
      },
    );

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_permit_snapshot_mismatch: 1,
    });
    expect(state.blocker).toBe(
      "market_base_v3_runtime_permit_snapshot_mismatch",
    );
    expect(result.ledgerRuntimeAnchor).toBeUndefined();
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("runtime session 铸造后的 ledger root 替换统一闭锁且零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let attacked = false;
    deps.readCurrentBuyOrders.mockImplementation(
      (resource: ResourceConstant) => {
        if (!attacked) {
          attacked = true;
          const forged = JSON.parse(
            JSON.stringify(state.ledger),
          ) as NonNullable<MarketBaseResourceV3RuntimeState["ledger"]>;
          (
            forged as unknown as {
              nextAttemptSeq: number;
            }
          ).nextAttemptSeq += 1;
          state.ledger = forged;
        }
        return resource === RESOURCE_CATALYST
          ? [order("x-buy", resource, 700, 1_000, "E1S1")]
          : [];
      },
    );

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_ledger_snapshot_mismatch: 1,
    });
    expect(state.blocker).toBe(
      "market_base_v3_runtime_ledger_snapshot_mismatch",
    );
    expect(result.ledgerRuntimeAnchor).toBeUndefined();
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("outer anchor reader 与 runtime session 铸造成本计入同一 25 CPU 窗口", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    state.preflightAt = harness.tick;
    let anchorRead = false;
    const readLedgerRuntimeAnchor = deps.readLedgerRuntimeAnchor as jest.Mock;
    readLedgerRuntimeAnchor.mockImplementation(
      (current: MarketBaseResourceV3RuntimeState) => {
        anchorRead = true;
        return buildMarketBaseResourceLedgerRuntimeAnchor(
          current.ledger!,
          current.permitChain!,
        );
      },
    );
    deps.cpuUsed.mockImplementation(() => (anchorRead ? 26 : 0));

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(result.rejectedByReason).toMatchObject({
      market_base_cpu_ceiling_exceeded: 1,
    });
    expect(readLedgerRuntimeAnchor).toHaveBeenCalledTimes(1);
    expect(deps.readCurrentBuyOrders).not.toHaveBeenCalled();
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("prepare 前最后一次 cpuUsed 回调篡改 scope 仍由紧邻 write gate 闭锁", () => {
    const { state, deps, input } = v3RuntimeFixture();
    const readExecutorShard = deps.readExecutorShard as jest.Mock;
    let attacked = false;
    deps.cpuUsed.mockImplementation(() => {
      if (!attacked && readExecutorShard.mock.calls.length >= 3) {
        attacked = true;
        const forged = JSON.parse(
          JSON.stringify(state.scope),
        ) as MarketBaseResourceScopeState;
        const target = forged.laneLifecycles.find(
          (lane) => lane.resource === RESOURCE_CATALYST,
        )!;
        (
          target as unknown as {
            status: "retired";
          }
        ).status = "retired";
        state.scope = forged;
      }
      return 1;
    });

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(attacked).toBe(true);
    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_scope_snapshot_mismatch: 1,
    });
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("prepare 后 cpuUsed 回调替换 ledger 时回滚未提交 WAL 且零 claim/deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let attacked = false;
    deps.cpuUsed.mockImplementation(() => {
      if (
        !attacked &&
        state.ledger?.pending &&
        deps.commitPreparedState.mock.calls.length === 0
      ) {
        attacked = true;
        const forged = JSON.parse(JSON.stringify(state.ledger)) as NonNullable<
          MarketBaseResourceV3RuntimeState["ledger"]
        >;
        (
          forged as unknown as {
            nextAttemptSeq: number;
          }
        ).nextAttemptSeq += 1;
        state.ledger = forged;
      }
      return 1;
    });

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(attacked).toBe(true);
    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_ledger_snapshot_mismatch: 1,
    });
    expect(state.ledger?.pending).toBeUndefined();
    expect(deps.commitPreparedState).not.toHaveBeenCalled();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("claim 后 cpuUsed 回调替换 current permit 时释放 claim 并零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let attacked = false;
    deps.cpuUsed.mockImplementation(() => {
      if (!attacked && deps.claimPrepared.mock.calls.length > 0) {
        attacked = true;
        const forged = JSON.parse(
          JSON.stringify(state.permitChain),
        ) as MarketBaseResourcePermitChainState;
        const current = forged.retainedPermits[
          forged.retainedPermits.length - 1
        ] as MarketBaseResourcePermit;
        const target = current.signedLaneGrants.find(
          (grant) => grant.resource === RESOURCE_CATALYST,
        )!;
        (
          target as unknown as {
            newDealGrant: "suspended";
          }
        ).newDealGrant = "suspended";
        state.permitChain = forged;
      }
      return 1;
    });

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(attacked).toBe(true);
    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_runtime_permit_snapshot_mismatch: 1,
    });
    expect(deps.commitPreparedState).toHaveBeenCalledTimes(1);
    expect(deps.claimPrepared).toHaveBeenCalledTimes(1);
    expect(deps.releasePrepared).toHaveBeenCalledTimes(1);
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it.each(["false", "throw"])(
    "canonical prepare commit %s 时零 claim、零 deal、零 pending",
    (kind) => {
      const { state, deps, input } = v3RuntimeFixture();
      deps.commitPreparedState.mockImplementation(() => {
        if (kind === "throw") {
          throw new Error("commit unavailable");
        }
        return false;
      });

      const result = runMarketBaseResourceAutomation(state, input(), deps);

      expect(deps.claimPrepared).not.toHaveBeenCalled();
      expect(deps.executePrepared).not.toHaveBeenCalled();
      expect(state.ledger?.pending).toBeUndefined();
      expect(result.rejectedByReason).toMatchObject({
        market_base_v3_prepared_commit_failed: 1,
      });
    },
  );

  it("prepared root 在 claim 前失去 outer exact CAS 时保留 WAL、零 claim、零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    deps.validatePreparedCanonicalRoot.mockReturnValue(false);

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(deps.commitPreparedState).toHaveBeenCalledTimes(1);
    expect(deps.validatePreparedCanonicalRoot).toHaveBeenCalledTimes(1);
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
    expect(state.ledger?.pending).toBeDefined();
    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_prepared_root_cas_failed: 1,
    });
  });

  it("claim hook 替换 prepared root 时释放 claim、保留 WAL 且零 deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let reads = 0;
    deps.validatePreparedCanonicalRoot.mockImplementation(() => {
      reads += 1;
      return reads === 1;
    });

    const result = runMarketBaseResourceAutomation(state, input(), deps);

    expect(deps.commitPreparedState).toHaveBeenCalledTimes(1);
    expect(deps.validatePreparedCanonicalRoot).toHaveBeenCalledTimes(2);
    expect(deps.claimPrepared).toHaveBeenCalledTimes(1);
    expect(deps.releasePrepared).toHaveBeenCalledTimes(1);
    expect(deps.executePrepared).not.toHaveBeenCalled();
    expect(state.ledger?.pending).toBeDefined();
    expect(result.rejectedByReason).toMatchObject({
      market_base_v3_prepared_root_cas_failed: 1,
    });
  });

  it("execute 抛错时 deal 前的 canonical 快照已含 frozen pending", () => {
    const { state, deps, input } = v3RuntimeFixture();
    let canonicalSnapshot: MarketBaseResourceV3RuntimeState | undefined;
    deps.commitPreparedState.mockImplementation(
      (preparedState: MarketBaseResourceV3RuntimeState) => {
        canonicalSnapshot = JSON.parse(
          JSON.stringify(preparedState),
        ) as MarketBaseResourceV3RuntimeState;
        return true;
      },
    );
    deps.executePrepared.mockImplementation(() => {
      throw new Error("deal uncertain");
    });

    runMarketBaseResourceAutomation(state, input(), deps);

    expect(canonicalSnapshot?.ledger?.pending).toMatchObject({
      orderId: "x-buy",
      attemptAt: 101,
      executionPolicy: "canary",
    });
    expect(state.ledger?.pending).toBeDefined();
  });

  it("canonical commit 自身越过 CPU 上限后保留 pending 且不 claim/deal", () => {
    const { state, deps, input } = v3RuntimeFixture();
    deps.cpuUsed.mockImplementation(() =>
      deps.commitPreparedState.mock.calls.length > 0 ? 26 : 0,
    );

    runMarketBaseResourceAutomation(state, input(), deps);

    expect(state.ledger?.pending).toBeDefined();
    expect(deps.claimPrepared).not.toHaveBeenCalled();
    expect(deps.executePrepared).not.toHaveBeenCalled();
  });

  it("claim 后越过 CPU 上限只释放 claim 并保留 canonical pending", () => {
    const { state, deps, input } = v3RuntimeFixture();
    deps.cpuUsed.mockImplementation(() =>
      deps.claimPrepared.mock.calls.length > 0 ? 26 : 0,
    );

    runMarketBaseResourceAutomation(state, input(), deps);

    expect(deps.releasePrepared).toHaveBeenCalledTimes(1);
    expect(deps.executePrepared).not.toHaveBeenCalled();
    expect(state.ledger?.pending).toBeDefined();
  });

  it("claim 失败不 deal，pending 在后续完整空窗口收敛", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    harness.claim = false;
    runMarketBaseResourceAutomation(state, input(), deps);
    expect(deps.executePrepared).not.toHaveBeenCalled();
    expect(state.ledger?.pending).toBeDefined();
    for (let step = 0; step < 3; step += 1) {
      harness.tick += 1;
      runMarketBaseResourceAutomation(
        state,
        {
          ...input(),
          fullPlanningTick: false,
        },
        deps,
      );
    }
    expect(state.ledger?.pending).toBeUndefined();
    expect(
      state.ledger?.receipts[state.ledger.receipts.length - 1]?.status,
    ).toBe("not_filled");
  });

  it("OK 在下一 tick 的 outgoing 匹配后写入 confirmed receipt", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    runMarketBaseResourceAutomation(state, input(), deps);
    harness.tick += 1;
    harness.outgoing = [
      {
        transactionId: "tx-x",
        time: 101,
        amount: 1_000,
        resourceType: RESOURCE_CATALYST,
        from: V3_TEST_ROOM,
        to: "E1S1",
        order: { id: "x-buy", type: ORDER_BUY, price: 700 },
      },
    ];
    runMarketBaseResourceAutomation(
      state,
      { ...input(), fullPlanningTick: false },
      deps,
    );
    for (let step = 0; step < 2; step += 1) {
      harness.tick += 1;
      runMarketBaseResourceAutomation(
        state,
        {
          ...input(),
          fullPlanningTick: false,
        },
        deps,
      );
    }
    expect(state.ledger?.pending).toBeUndefined();
    expect(
      state.ledger?.receipts[state.ledger.receipts.length - 1],
    ).toMatchObject({
      status: "confirmed",
      transactionId: "tx-x",
      actualAmount: 1_000,
    });
  });

  it("同一 pending 出现两条匹配交易时永久隔离且保留 exposure", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    runMarketBaseResourceAutomation(state, input(), deps);
    harness.tick += 1;
    harness.outgoing = ["tx-x-1", "tx-x-2"].map((transactionId) => ({
      transactionId,
      time: 101,
      amount: 1_000,
      resourceType: RESOURCE_CATALYST,
      from: V3_TEST_ROOM,
      to: "E1S1",
      order: {
        id: "x-buy",
        type: ORDER_BUY,
        price: 700,
      },
    }));

    runMarketBaseResourceAutomation(
      state,
      {
        ...input(),
        fullPlanningTick: false,
      },
      deps,
    );

    expect(state.hardBlocker).toMatchObject({
      code: "market_base_v3_transaction_evidence_conflict",
    });
    expect(state.ledger?.pending).toBeDefined();
  });

  it("实际交易能耗越界时永久隔离且不猜测净额", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    runMarketBaseResourceAutomation(state, input(), deps);
    harness.tick += 1;
    harness.outgoing = [
      {
        transactionId: "tx-x-invalid-energy",
        time: 101,
        amount: 1_000,
        resourceType: RESOURCE_CATALYST,
        from: V3_TEST_ROOM,
        to: "E1S1",
        order: {
          id: "x-buy",
          type: ORDER_BUY,
          price: 700,
        },
      },
    ];
    deps.calculateTransactionEnergy = jest.fn(() => 1_001);

    runMarketBaseResourceAutomation(
      state,
      {
        ...input(),
        fullPlanningTick: false,
      },
      deps,
    );

    expect(state.hardBlocker).toMatchObject({
      code: "market_base_v3_actual_net_invalid",
    });
    expect(state.ledger?.pending).toBeDefined();
  });

  it("显式 non-OK 立刻 failed 并释放 claim", () => {
    const { state, harness, deps, input } = v3RuntimeFixture();
    harness.execute = ERR_NOT_ENOUGH_RESOURCES;
    runMarketBaseResourceAutomation(state, input(), deps);
    expect(state.ledger?.pending).toBeDefined();
    for (let step = 0; step < 2; step += 1) {
      harness.tick += 1;
      runMarketBaseResourceAutomation(
        state,
        {
          ...input(),
          fullPlanningTick: false,
        },
        deps,
      );
    }
    expect(state.ledger?.pending).toBeUndefined();
    expect(
      state.ledger?.receipts[state.ledger.receipts.length - 1]?.status,
    ).toBe("failed");
    expect(deps.releasePrepared).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "throw", "partial"])(
    "%s 执行结果保留 pending，物理差异随后进入 gap",
    (kind) => {
      const { state, harness, deps, input } = v3RuntimeFixture();
      harness.execute =
        kind === "throw"
          ? () => {
              throw new Error("deal uncertain");
            }
          : kind === "partial"
            ? undefined
            : 777;
      deps.executePrepared.mockImplementation(() =>
        typeof harness.execute === "function"
          ? harness.execute()
          : harness.execute,
      );
      runMarketBaseResourceAutomation(state, input(), deps);
      expect(state.ledger?.pending).toBeDefined();
      harness.tick += 1;
      harness.terminalResource -= 1_000;
      runMarketBaseResourceAutomation(
        state,
        { ...input(), fullPlanningTick: false },
        deps,
      );
      expect(state.blocker).toBe("market_base_v3_reconcile_gap");
      expect(state.hardBlocker).toMatchObject({
        code: "market_base_v3_reconcile_gap",
        detectedAt: harness.tick,
      });
      expect(state.ledger?.pending).toBeDefined();
      const latched = state.hardBlocker;

      harness.tick += 1;
      runMarketBaseResourceAutomation(
        state,
        {
          ...input(),
          fullPlanningTick: false,
        },
        deps,
      );

      expect(state.hardBlocker).toEqual(latched);
      expect(state.blocker).toBe("market_base_v3_reconcile_gap");
      expect(state.ledger?.pending).toBeDefined();
      expect(deps.executePrepared).toHaveBeenCalledTimes(1);
    },
  );
});

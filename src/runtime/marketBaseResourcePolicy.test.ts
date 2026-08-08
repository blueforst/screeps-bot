import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createMarketBaseRoomAdmissionPolicy,
  createMarketBaseSharedPolicy,
  deriveMarketBaseLaneId,
  isMarketBaseResource,
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_EVIDENCE_SHA256,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY,
  MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES,
  MARKET_BASE_RESOURCE_MAX_LANES,
  MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES,
  MARKET_BASE_RESOURCE_MAX_ROOMS,
  MARKET_BASE_RESOURCE_POLICIES,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  marketBaseDerivedLaneLifecycleCheckpointCommitment,
  marketBaseDerivedLaneSetFingerprint,
  marketBaseRoomRegistryCheckpointCommitment,
  parseMarketBaseResourceRawConfig,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  type MarketBaseResource,
  type MarketBaseRoomIncarnationRegistry,
  type MarketBaseRoomObservation,
  validateMarketBaseFloorBootstrap,
  validateMarketBaseDerivedLaneLifecycle,
  validateMarketBaseResourceRawConfig,
  verifyMarketBaseFloorEvidence,
} from "@/runtime/marketBaseResourcePolicy";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";

const EVIDENCE_PATH = resolve(
  process.cwd(),
  "openspec/changes/market-base-resource-all-rooms/evidence/floor-bootstrap-evidence.canonical.json",
);

function rawV3ResourceConfig(): Record<string, unknown> {
  return {
    sellResources: ["H", "O", "U", "L", "K", "Z", "X"],
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
  };
}

function observation(
  roomName: string,
  overrides: Partial<MarketBaseRoomObservation> = {},
): MarketBaseRoomObservation {
  return {
    roomName,
    visible: true,
    controllerMy: true,
    controllerOwner: "Forst",
    terminalId: `terminal-${roomName}`,
    terminalOwned: true,
    roomClass: "normal",
    ...overrides,
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireSuccessfulRooms(
  result: ReturnType<typeof reconcileMarketBaseSellerRooms>,
): Extract<typeof result, { ok: true }> {
  if (result.ok === false) {
    throw new Error(`unexpected blockers: ${result.blockers.join(",")}`);
  }
  return result;
}

describe("marketBaseResourcePolicy catalog/config/bootstrap", () => {
  it("只把七种基础矿物按 canonical 顺序收入 catalog，禁止资源再高价也不进入", () => {
    expect(MARKET_BASE_RESOURCE_CATALOG).toEqual([
      "H",
      "K",
      "L",
      "O",
      "U",
      "X",
      "Z",
    ]);
    for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
      expect(isMarketBaseResource(resource)).toBe(true);
    }
    for (const forbidden of [
      "energy",
      "G",
      "OH",
      "XUH2O",
      "power",
      "ops",
      "pixel",
      "silicon",
      "battery",
      "unknown",
    ]) {
      expect(isMarketBaseResource(forbidden)).toBe(false);
    }

    const highPriceOrders = [
      { resource: "energy", price: 1_000_000 },
      { resource: "XUH2O", price: 900_000 },
      { resource: "X", price: 601 },
    ];
    expect(
      highPriceOrders
        .filter((order) => isMarketBaseResource(order.resource))
        .map((order) => order.resource),
    ).toEqual(["X"]);
  });

  it("七份 policy/bootstrap 递归 immutable 且门槛精确冻结", () => {
    expect(MARKET_BASE_RESOURCE_POLICIES).toHaveLength(7);
    expect(Object.isFrozen(MARKET_BASE_RESOURCE_POLICIES)).toBe(true);
    expect(Object.isFrozen(MARKET_BASE_RESOURCE_POLICIES[0])).toBe(true);
    expect(Object.isFrozen(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP)).toBe(true);
    expect(
      Object.isFrozen(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources),
    ).toBe(true);
    expect(
      MARKET_BASE_RESOURCE_POLICIES.map(
        ({ resource, hardFloor, economicFloor, rollingMaxAmount }) => ({
          resource,
          hardFloor,
          economicFloor,
          rollingMaxAmount,
        }),
      ),
    ).toEqual([
      {
        resource: "H",
        hardFloor: 428,
        economicFloor: 451,
        rollingMaxAmount: 8_000,
      },
      {
        resource: "K",
        hardFloor: 96,
        economicFloor: 101,
        rollingMaxAmount: 5_000,
      },
      {
        resource: "L",
        hardFloor: 161,
        economicFloor: 169,
        rollingMaxAmount: 5_000,
      },
      {
        resource: "O",
        hardFloor: 138,
        economicFloor: 145,
        rollingMaxAmount: 5_000,
      },
      {
        resource: "U",
        hardFloor: 44,
        economicFloor: 46,
        rollingMaxAmount: 5_000,
      },
      {
        resource: "X",
        hardFloor: 600,
        economicFloor: 600,
        rollingMaxAmount: 8_000,
      },
      {
        resource: "Z",
        hardFloor: 43,
        economicFloor: 45,
        rollingMaxAmount: 5_000,
      },
    ]);
    expect(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.resources).toEqual({
      H: { observedFloor: 433.765, ratchetFloor: 433.765 },
      K: { observedFloor: 100.914, ratchetFloor: 100.914 },
      L: { observedFloor: 168.132, ratchetFloor: 168.132 },
      O: { observedFloor: 128.524, ratchetFloor: 128.524 },
      U: { observedFloor: 45.939, ratchetFloor: 45.939 },
      X: { observedFloor: 559.43, ratchetFloor: 559.43 },
      Z: { observedFloor: 41.623, ratchetFloor: 41.623 },
    });
  });

  it("raw validator 在 normalizer 前拒绝重复、缺项和禁止资源", () => {
    const valid = validateMarketBaseResourceRawConfig(rawV3ResourceConfig());
    expect(valid.valid).toBe(true);
    expect(valid.invalidReasons).toEqual([]);
    expect(valid.canonical?.sellResources).toEqual(
      MARKET_BASE_RESOURCE_CATALOG,
    );
    expect(valid.canonical?.sellResources).toEqual([
      "H",
      "K",
      "L",
      "O",
      "U",
      "X",
      "Z",
    ]);

    const shuffled = rawV3ResourceConfig();
    shuffled.sellResources = ["X", "H", "Z", "O", "K", "U", "L"];
    const normalized = validateMarketBaseResourceRawConfig(shuffled);
    expect(normalized.valid).toBe(true);
    expect(normalized.canonical?.sellResources).toEqual(
      MARKET_BASE_RESOURCE_CATALOG,
    );

    for (const forbidden of [
      "energy",
      "G",
      "OH",
      "XUH2O",
      "power",
      "ops",
      "silicon",
      "battery",
      "unknown",
    ]) {
      const raw = rawV3ResourceConfig();
      raw.sellResources = [...(raw.sellResources as string[]), forbidden];
      const result = validateMarketBaseResourceRawConfig(raw);
      expect(result.valid).toBe(false);
      expect(result.invalidReasons).toContain(
        `base_resource_sell_resource_forbidden:${forbidden}`,
      );
    }

    const duplicate = rawV3ResourceConfig();
    duplicate.sellResources = [...(duplicate.sellResources as string[]), "X"];
    expect(
      validateMarketBaseResourceRawConfig(duplicate).invalidReasons,
    ).toContain("base_resource_sell_resource_duplicate:X");

    const missing = rawV3ResourceConfig();
    missing.sellResources = (missing.sellResources as string[]).filter(
      (resource) => resource !== "O",
    );
    expect(
      validateMarketBaseResourceRawConfig(missing).invalidReasons,
    ).toContain("base_resource_sell_resource_missing:O");
  });

  it("共享 exact parser 与公开 validator 同源，但只由公开入口物化 fingerprint", () => {
    const raw = rawV3ResourceConfig();
    const parsed = parseMarketBaseResourceRawConfig(raw);
    const validated = validateMarketBaseResourceRawConfig(raw);

    expect(parsed.valid).toBe(true);
    expect(parsed.invalidReasons).toEqual([]);
    expect(parsed.parsed).toBeDefined();
    expect(parsed.parsed).not.toHaveProperty("fingerprint");
    expect(validated.canonical).toEqual({
      ...parsed.parsed,
      fingerprint: canonicalStableHashV1({
        config: parsed.parsed,
        domain: "market-base-resource:raw-config-v1",
        revision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
      }),
    });

    const malformed = rawV3ResourceConfig();
    malformed.sellResources = [
      ...(malformed.sellResources as string[]),
      "X",
      "energy",
    ];
    delete (malformed.hardFloor as Record<string, number>).O;
    (malformed.forecastBuffer as Record<string, number>).H = Number.NaN;
    expect(parseMarketBaseResourceRawConfig(malformed).invalidReasons).toEqual(
      validateMarketBaseResourceRawConfig(malformed).invalidReasons,
    );
  });

  it.each(["hardFloor", "economicFloor", "forecastBuffer"] as const)(
    "%s accessor 只读一次，第三读突变不能污染 parsed/canonical",
    (field) => {
      const fixture = () => {
        const raw = rawV3ResourceConfig();
        const expected = {
          ...(raw[field] as Record<MarketBaseResource, number>),
        };
        const reads = Object.fromEntries(
          MARKET_BASE_RESOURCE_CATALOG.map((resource) => [resource, 0]),
        ) as Record<MarketBaseResource, number>;
        const accessorMap: Record<string, number> = {};
        for (const resource of MARKET_BASE_RESOURCE_CATALOG) {
          Object.defineProperty(accessorMap, resource, {
            configurable: true,
            enumerable: true,
            get: () => {
              reads[resource] += 1;
              return reads[resource] >= 3
                ? expected[resource] + 1
                : expected[resource];
            },
          });
        }
        raw[field] = accessorMap;
        return { raw, expected, reads };
      };

      const parsedFixture = fixture();
      const parsed = parseMarketBaseResourceRawConfig(parsedFixture.raw);
      expect(parsed.valid).toBe(true);
      expect(parsed.parsed?.[field]).toEqual(parsedFixture.expected);
      expect(parsedFixture.reads).toEqual(
        Object.fromEntries(
          MARKET_BASE_RESOURCE_CATALOG.map((resource) => [resource, 1]),
        ),
      );

      const validatedFixture = fixture();
      const validated = validateMarketBaseResourceRawConfig(
        validatedFixture.raw,
      );
      const ordinary = validateMarketBaseResourceRawConfig(
        rawV3ResourceConfig(),
      );
      expect(validated.valid).toBe(true);
      expect(validated.canonical?.[field]).toEqual(validatedFixture.expected);
      expect(validated.canonical?.fingerprint).toBe(
        ordinary.canonical?.fingerprint,
      );
      expect(validatedFixture.reads).toEqual(
        Object.fromEntries(
          MARKET_BASE_RESOURCE_CATALOG.map((resource) => [resource, 1]),
        ),
      );
    },
  );

  it.each(["hardFloor", "economicFloor", "forecastBuffer"] as const)(
    "raw validator 拒绝 %s 的额外 threshold key",
    (field) => {
      const raw = rawV3ResourceConfig();
      raw[field] = {
        ...(raw[field] as Record<string, number>),
        energy: 999_999,
      };
      const result = validateMarketBaseResourceRawConfig(raw);
      expect(result.valid).toBe(false);
      expect(result.invalidReasons).toContain(
        `base_resource_${field}_extra_key:energy`,
      );
    },
  );

  it("raw validator 拒绝 threshold 缺项、改值和非有限值", () => {
    const missing = rawV3ResourceConfig();
    delete (missing.hardFloor as Record<string, number>).O;
    expect(
      validateMarketBaseResourceRawConfig(missing).invalidReasons,
    ).toContain("base_resource_hardFloor_missing_key:O");

    const changed = rawV3ResourceConfig();
    (changed.economicFloor as Record<string, number>).X = 599;
    expect(
      validateMarketBaseResourceRawConfig(changed).invalidReasons,
    ).toContain("base_resource_economicFloor_value_mismatch:X");

    const invalid = rawV3ResourceConfig();
    (invalid.forecastBuffer as Record<string, number>).H = Number.NaN;
    expect(
      validateMarketBaseResourceRawConfig(invalid).invalidReasons,
    ).toContain("base_resource_forecastBuffer_value_invalid:H");
  });

  it("canonical floor JSON 的完整 LF bytes、91 rows 与冻结算法可复算", () => {
    const bytes = readFileSync(EVIDENCE_PATH);
    expect(bytes[bytes.length - 1]).toBe(10);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      MARKET_BASE_RESOURCE_EVIDENCE_SHA256,
    );
    const result = verifyMarketBaseFloorEvidence(
      JSON.parse(bytes.toString("utf8")),
    );
    expect(result).toEqual({
      valid: true,
      invalidReasons: [],
      rowCount: 91,
    });
  });

  it("canonical evidence 的输入、结果、partial 或 policy 任一改写均拒绝", () => {
    const original = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));

    const changedInput = jsonClone(original);
    changedInput.resources.L.completeDays[0][3] += 1;
    expect(
      verifyMarketBaseFloorEvidence(changedInput).invalidReasons,
    ).toContain("floor_evidence_recompute_mismatch:L");

    const changedResult = jsonClone(original);
    changedResult.resources.H.trusted95Floor -= 1;
    expect(
      verifyMarketBaseFloorEvidence(changedResult).invalidReasons,
    ).toContain("floor_evidence_recompute_mismatch:H");

    const changedPartial = jsonClone(original);
    changedPartial.resources.X.excludedPartialDates[0] = "2026-07-13";
    expect(
      verifyMarketBaseFloorEvidence(changedPartial).invalidReasons,
    ).toContain("floor_evidence_partial_dates:X");

    const loweredPolicy = jsonClone(original);
    loweredPolicy.policy.O.economic = 128;
    expect(
      verifyMarketBaseFloorEvidence(loweredPolicy).invalidReasons,
    ).toContain("floor_evidence_policy_mismatch:O");
  });

  it("bootstrap 缺失、digest 改写、日期回拨和重复初始化全部 fail-closed", () => {
    expect(
      validateMarketBaseFloorBootstrap(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP),
    ).toEqual({ valid: true, invalidReasons: [] });

    const missing = jsonClone(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP) as Record<
      string,
      any
    >;
    delete missing.resources.O;
    expect(validateMarketBaseFloorBootstrap(missing).invalidReasons).toContain(
      "base_floor_bootstrap_resource_set_mismatch",
    );

    const digest = jsonClone(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP) as Record<
      string,
      any
    >;
    digest.evidenceSha256 = "0".repeat(64);
    expect(validateMarketBaseFloorBootstrap(digest).invalidReasons).toContain(
      "base_floor_bootstrap_evidence_digest_mismatch",
    );

    const rollback = jsonClone(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP) as Record<
      string,
      any
    >;
    rollback.historyDate = "2026-07-26";
    expect(
      validateMarketBaseFloorBootstrap(rollback, {
        minimumHistoryDate: "2026-07-27",
      }).invalidReasons,
    ).toEqual(
      expect.arrayContaining([
        "base_floor_bootstrap_history_date_mismatch",
        "base_floor_bootstrap_history_date_rollback",
      ]),
    );

    expect(
      validateMarketBaseFloorBootstrap(MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP, {
        previousFingerprint: MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP.fingerprint,
      }).invalidReasons,
    ).toContain("base_floor_bootstrap_duplicate");
  });
});

describe("marketBaseResourcePolicy room admission/incarnation/lane", () => {
  const admission = createMarketBaseRoomAdmissionPolicy("Forst");
  const shared = createMarketBaseSharedPolicy("Forst");

  it("policy 冻结 owner/visible/controller.my/owned terminal 和所有上界", () => {
    expect(admission).toMatchObject({
      revision: "owned-visible-terminal-v1",
      accountIdentity: "Forst",
      controllerMyRequired: true,
      visibilityRequired: true,
      terminalRequired: true,
      terminalOwnedRequired: true,
      autoAdmit: true,
      maxRooms: 16,
    });
    expect(MARKET_BASE_RESOURCE_LANE_DERIVATION_POLICY).toMatchObject({
      maxKnownRoomNames: 32,
      maxLanes: 112,
      maxRoomTombstones: 64,
      maxLaneTombstones: 224,
      maxShadowLanesPerCycle: 8,
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it.each([
    { visible: false },
    { controllerMy: false },
    { controllerOwner: "Other" },
    { terminalId: undefined },
    { terminalOwned: false },
  ] satisfies Array<Partial<MarketBaseRoomObservation>>)(
    "不满足准入事实 %o 时不创建 seller",
    (override) => {
      const result = requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick: 1,
          admissionPolicy: admission,
          observations: [observation("E1N1", override)],
        }),
      );
      expect(result.sellerRooms).toEqual([]);
      expect(result.state.knownRoomNames).toEqual([]);
    },
  );

  it("自动新房建立 generation 1 和七条 shadow+suspended lane", () => {
    const rooms = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    expect(rooms.sellerRooms).toHaveLength(1);
    expect(rooms.sellerRooms[0]).toMatchObject({
      roomName: "E1N1",
      incarnation: 1,
      previousInstanceId: null,
      status: "admitted",
    });

    const lanes = reconcileMarketBaseDerivedLanes({
      sharedPolicyFingerprint: shared.fingerprint,
      sellerRooms: rooms.sellerRooms,
    });
    expect(lanes.ok).toBe(true);
    expect(lanes.lanes).toHaveLength(7);
    expect(lanes.newLaneIds).toHaveLength(7);
    expect(
      lanes.lanes?.every(
        (lane) =>
          lane.stage === "shadow" &&
          lane.status === "suspended" &&
          lane.shadowEvidence.completeCycles === 0,
      ),
    ).toBe(true);
    expect(lanes.laneSetFingerprint).toBe(
      marketBaseDerivedLaneSetFingerprint(lanes.lanes!),
    );
  });

  it("qualified 及后续 lifecycle 必须绑定至少100周期和完整证据", () => {
    const rooms = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const reconciled = reconcileMarketBaseDerivedLanes({
      sharedPolicyFingerprint: shared.fingerprint,
      sellerRooms: rooms.sellerRooms,
    });
    const pristine = reconciled.lanes![0];
    const evidenceDigest = canonicalStableHashV1(
      "policy-test:qualified-evidence",
    );
    const qualified = {
      ...pristine,
      stage: "qualified" as const,
      shadowEvidence: {
        completeCycles: 100,
        lastCompleteTick: 1_000,
        evidenceDigest,
      },
    };
    expect(validateMarketBaseDerivedLaneLifecycle(qualified)).toBeUndefined();
    expect(
      validateMarketBaseDerivedLaneLifecycle({
        ...qualified,
        shadowEvidence: {
          ...qualified.shadowEvidence,
          completeCycles: 99,
        },
      }),
    ).toBe("derived_lane_qualification_evidence_incomplete");
    expect(
      validateMarketBaseDerivedLaneLifecycle({
        ...qualified,
        stage: "canary",
        status: "writable",
        shadowEvidence: {
          completeCycles: 100,
        },
      }),
    ).toBe("derived_lane_qualification_evidence_incomplete");
    expect(
      validateMarketBaseDerivedLaneLifecycle({
        ...qualified,
        stage: "review_paused",
        status: "writable",
      }),
    ).toBe("derived_lane_stage_status_invalid");
    expect(() =>
      marketBaseDerivedLaneLifecycleCheckpointCommitment([
        qualified,
        {
          ...qualified,
          shadowEvidence: {
            ...qualified.shadowEvidence,
            completeCycles: 0,
          },
        },
      ]),
    ).toThrow("derived_lane_qualification_evidence_incomplete");
  });

  it("同 owner+同 terminal 离开再准入也递增 incarnation，不复活旧 ID", () => {
    const first = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const firstRoom = first.sellerRooms[0];
    const absent = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 2,
        admissionPolicy: admission,
        observations: [],
        previous: first.state,
        expectedPreviousCheckpointCommitment: first.state.checkpointCommitment,
      }),
    );
    expect(absent.sellerRooms).toEqual([]);
    const returned = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 3,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
        previous: absent.state,
        expectedPreviousCheckpointCommitment: absent.state.checkpointCommitment,
      }),
    );
    expect(returned.sellerRooms[0].incarnation).toBe(2);
    expect(returned.sellerRooms[0].previousInstanceId).toBe(
      firstRoom.roomInstanceId,
    );
    expect(returned.sellerRooms[0].roomInstanceId).not.toBe(
      firstRoom.roomInstanceId,
    );
  });

  it("terminal A→B→A 与 normal→hub→normal 均生成从未使用的新实例", () => {
    const first = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const second = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 2,
        admissionPolicy: admission,
        previous: first.state,
        observations: [
          observation("E1N1", {
            terminalId: "terminal-B",
            roomClass: "hub",
          }),
        ],
      }),
    );
    const third = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 3,
        admissionPolicy: admission,
        previous: second.state,
        observations: [observation("E1N1")],
      }),
    );
    expect(
      [first, second, third].map((result) => result.sellerRooms[0].incarnation),
    ).toEqual([1, 2, 3]);
    expect(
      new Set(
        [first, second, third].map(
          (result) => result.sellerRooms[0].roomInstanceId,
        ),
      ).size,
    ).toBe(3);
    expect(third.sellerRooms[0].previousInstanceId).toBe(
      second.sellerRooms[0].roomInstanceId,
    );
  });

  it("130 次 terminal/class churn 保留 recent 64 并把旧 incarnation 折叠进 canonical high-water", () => {
    const first = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const firstRoom = first.sellerRooms[0];
    let current = first;
    let olderRegistry: MarketBaseRoomIncarnationRegistry | undefined;
    const instanceIds = [firstRoom.roomInstanceId];
    for (let index = 1; index <= 130; index += 1) {
      const next = requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick: index + 1,
          admissionPolicy: admission,
          observations: [
            observation("E1N1", {
              terminalId: `terminal-churn-${index}`,
              roomClass: index % 2 === 0 ? "normal" : "hub",
            }),
          ],
          previous: current.state,
          expectedPreviousCheckpointCommitment:
            current.state.checkpointCommitment,
        }),
      );
      current = next;
      instanceIds.push(next.sellerRooms[0].roomInstanceId);
      if (index === 70) {
        olderRegistry = jsonClone(next.state);
      }
    }

    expect(new Set(instanceIds).size).toBe(131);
    expect(current.sellerRooms[0]).toMatchObject({
      incarnation: 131,
      previousInstanceId: instanceIds[129],
    });
    expect(current.state.recentTombstones).toHaveLength(
      MARKET_BASE_RESOURCE_MAX_ROOM_TOMBSTONES,
    );
    expect(
      current.state.recentTombstones.map((entry) => entry.incarnation),
    ).toEqual(Array.from({ length: 64 }, (_value, index) => index + 67));
    expect(current.state.tombstonePrefixCheckpoint).toMatchObject({
      schemaVersion: 1,
      hashRevision: "market-base-resource-room-tombstones-v1",
      compressedCount: 66,
      roomHighWater: [
        {
          roomName: "E1N1",
          compressedCount: 66,
          incarnationHighWater: 66,
          firstInstanceId: instanceIds[0],
          lastInstanceId: instanceIds[65],
        },
      ],
    });

    const lastObservation = observation("E1N1", {
      terminalId: "terminal-churn-130",
      roomClass: "normal",
    });
    expect(
      requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick: 132,
          admissionPolicy: admission,
          observations: [lastObservation],
          previous: current.state,
          expectedPreviousCheckpointCommitment:
            current.state.checkpointCommitment,
        }),
      ).sellerRooms[0].roomInstanceId,
    ).toBe(instanceIds[130]);

    expect(
      reconcileMarketBaseSellerRooms({
        tick: 132,
        admissionPolicy: admission,
        observations: [lastObservation],
        previous: olderRegistry,
        expectedPreviousCheckpointCommitment:
          current.state.checkpointCommitment,
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_incarnation_external_checkpoint_mismatch"],
    });
  });

  it("已压缩旧 incarnation 不能靠回拨 high-water、替换 prefix 或重签 outer checkpoint 复活", () => {
    const first = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    let current = first;
    let olderPrefix:
      | MarketBaseRoomIncarnationRegistry["tombstonePrefixCheckpoint"]
      | undefined;
    for (let index = 1; index <= 130; index += 1) {
      current = requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick: index + 1,
          admissionPolicy: admission,
          observations: [
            observation("E1N1", {
              terminalId: `terminal-attack-${index}`,
            }),
          ],
          previous: current.state,
          expectedPreviousCheckpointCommitment:
            current.state.checkpointCommitment,
        }),
      );
      if (index === 70) {
        olderPrefix = jsonClone(current.state.tombstonePrefixCheckpoint);
      }
    }
    const currentObservation = observation("E1N1", {
      terminalId: "terminal-attack-130",
    });

    const revived = jsonClone(current.state) as any;
    revived.rooms.E1N1 = {
      roomName: "E1N1",
      incarnationHighWater: 1,
      lastInstanceId: first.sellerRooms[0].roomInstanceId,
      admitted: true,
      current: first.sellerRooms[0],
    };
    revived.recentTombstones = [];
    revived.checkpointCommitment =
      marketBaseRoomRegistryCheckpointCommitment(revived);
    const revival = reconcileMarketBaseSellerRooms({
      tick: 132,
      admissionPolicy: admission,
      observations: [observation("E1N1")],
      previous: revived,
    });
    expect(revival.ok).toBe(false);
    if (revival.ok === false) {
      expect(revival.blockers).toContain("room_incarnation_history_gap:E1N1");
    }

    const rolledPrefix = jsonClone(current.state) as any;
    rolledPrefix.tombstonePrefixCheckpoint = olderPrefix;
    rolledPrefix.checkpointCommitment =
      marketBaseRoomRegistryCheckpointCommitment(rolledPrefix);
    const rollback = reconcileMarketBaseSellerRooms({
      tick: 132,
      admissionPolicy: admission,
      observations: [currentObservation],
      previous: rolledPrefix,
    });
    expect(rollback.ok).toBe(false);
    if (rollback.ok === false) {
      expect(rollback.blockers).toEqual(
        expect.arrayContaining([
          "room_incarnation_tombstone_chain_invalid:E1N1",
          "room_incarnation_history_gap:E1N1",
        ]),
      );
    }

    const tamperedPrefix = jsonClone(current.state) as any;
    tamperedPrefix.tombstonePrefixCheckpoint.compressedPrefixHead =
      canonicalStableHashV1("policy-test:tampered-room-prefix");
    tamperedPrefix.checkpointCommitment =
      marketBaseRoomRegistryCheckpointCommitment(tamperedPrefix);
    const tampered = reconcileMarketBaseSellerRooms({
      tick: 132,
      admissionPolicy: admission,
      observations: [currentObservation],
      previous: tamperedPrefix,
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok === false) {
      expect(tampered.blockers).toContain(
        "room_incarnation_tombstone_prefix_invalid",
      );
    }
  });

  it("room prefix 已压缩后 active roster 仍以 16×7=112 闭合，17 房写前拒绝", () => {
    let current = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    for (let index = 1; index <= 65; index += 1) {
      current = requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick: index + 1,
          admissionPolicy: admission,
          observations: [
            observation("E1N1", {
              terminalId: `terminal-boundary-${index}`,
            }),
          ],
          previous: current.state,
          expectedPreviousCheckpointCommitment:
            current.state.checkpointCommitment,
        }),
      );
    }
    const activeObservations = [
      observation("E1N1", {
        terminalId: "terminal-boundary-65",
      }),
      ...Array.from({ length: 15 }, (_value, index) =>
        observation(`E${index + 2}N1`),
      ),
    ];
    const sixteenRooms = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 67,
        admissionPolicy: admission,
        observations: activeObservations,
        previous: current.state,
        expectedPreviousCheckpointCommitment:
          current.state.checkpointCommitment,
      }),
    );
    const lanes = reconcileMarketBaseDerivedLanes({
      sharedPolicyFingerprint: shared.fingerprint,
      sellerRooms: sixteenRooms.sellerRooms,
    });
    expect(sixteenRooms.sellerRooms).toHaveLength(16);
    expect(sixteenRooms.state.tombstonePrefixCheckpoint.compressedCount).toBe(
      1,
    );
    expect(lanes.ok).toBe(true);
    expect(lanes.lanes).toHaveLength(112);
    expect(
      reconcileMarketBaseSellerRooms({
        tick: 68,
        admissionPolicy: admission,
        observations: [...activeObservations, observation("E17N1")],
        previous: sixteenRooms.state,
        expectedPreviousCheckpointCommitment:
          sixteenRooms.state.checkpointCommitment,
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_admission_max_rooms_exceeded"],
    });
  });

  it("同 tick 同 roster 幂等；同 tick scope 变化或 tick 回拨 fail-closed", () => {
    const first = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 10,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const same = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 10,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
        previous: first.state,
      }),
    );
    expect(same.changed).toBe(false);
    expect(same.state).toBe(first.state);

    expect(
      reconcileMarketBaseSellerRooms({
        tick: 10,
        admissionPolicy: admission,
        observations: [],
        previous: first.state,
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_observation_same_tick_conflict"],
    });
    expect(
      reconcileMarketBaseSellerRooms({
        tick: 9,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
        previous: first.state,
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_incarnation_tick_rollback"],
    });
  });

  it("incarnation high-water、内部 checkpoint 或 permit 绑定回拨均拒绝", () => {
    const first = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const rolledHighWater = jsonClone(first.state) as any;
    rolledHighWater.rooms.E1N1.incarnationHighWater = 0;
    const highWaterResult = reconcileMarketBaseSellerRooms({
      tick: 2,
      admissionPolicy: admission,
      observations: [observation("E1N1")],
      previous: rolledHighWater,
    });
    expect(highWaterResult.ok).toBe(false);
    if (highWaterResult.ok === false) {
      expect(highWaterResult.blockers).toEqual(
        expect.arrayContaining([
          "room_incarnation_record_invalid:E1N1",
          "room_incarnation_checkpoint_mismatch",
        ]),
      );
    }

    const rolledCheckpoint = jsonClone(first.state) as any;
    rolledCheckpoint.checkpointCommitment = "csh1:rollback";
    expect(
      reconcileMarketBaseSellerRooms({
        tick: 2,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
        previous: rolledCheckpoint,
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_incarnation_checkpoint_mismatch"],
    });

    expect(
      reconcileMarketBaseSellerRooms({
        tick: 2,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
        previous: first.state,
        expectedPreviousCheckpointCommitment: "csh1:old-permit",
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_incarnation_external_checkpoint_mismatch"],
    });
  });

  it("16 rooms×7 resources 精确闭合为 112 lanes，17 rooms 整体拒绝", () => {
    const observations = Array.from(
      { length: MARKET_BASE_RESOURCE_MAX_ROOMS },
      (_value, index) => observation(`E${index + 1}N1`),
    );
    const rooms = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations,
      }),
    );
    const lanes = reconcileMarketBaseDerivedLanes({
      sharedPolicyFingerprint: shared.fingerprint,
      sellerRooms: rooms.sellerRooms,
    });
    expect(rooms.sellerRooms).toHaveLength(MARKET_BASE_RESOURCE_MAX_ROOMS);
    expect(lanes.ok).toBe(true);
    expect(lanes.lanes).toHaveLength(MARKET_BASE_RESOURCE_MAX_LANES);

    expect(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [...observations, observation("W17N1")],
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_admission_max_rooms_exceeded"],
    });
  });

  it("known room name 第 32 个可提交，第 33 个在写前拒绝", () => {
    let state: MarketBaseRoomIncarnationRegistry | undefined;
    let tick = 1;
    for (
      let index = 0;
      index < MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES;
      index += 1
    ) {
      const admitted = requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick,
          admissionPolicy: admission,
          observations: [observation(`E${index + 1}N9`)],
          previous: state,
          expectedPreviousCheckpointCommitment: state?.checkpointCommitment,
        }),
      );
      tick += 1;
      const absent = requireSuccessfulRooms(
        reconcileMarketBaseSellerRooms({
          tick,
          admissionPolicy: admission,
          observations: [],
          previous: admitted.state,
          expectedPreviousCheckpointCommitment:
            admitted.state.checkpointCommitment,
        }),
      );
      state = absent.state;
      tick += 1;
    }
    expect(state!.knownRoomNames).toHaveLength(
      MARKET_BASE_RESOURCE_MAX_KNOWN_ROOM_NAMES,
    );
    expect(
      reconcileMarketBaseSellerRooms({
        tick,
        admissionPolicy: admission,
        observations: [observation("W33N9")],
        previous: state,
        expectedPreviousCheckpointCommitment: state!.checkpointCommitment,
      }),
    ).toEqual({
      ok: false,
      blockers: ["room_admission_known_rooms_exceeded"],
    });
  });

  it("lane ID 只由 immutable resource policy+room instance 派生且稳定", () => {
    const rooms = requireSuccessfulRooms(
      reconcileMarketBaseSellerRooms({
        tick: 1,
        admissionPolicy: admission,
        observations: [observation("E1N1")],
      }),
    );
    const resource: MarketBaseResource = "X";
    const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
    const laneId = deriveMarketBaseLaneId({
      resourcePolicyId: policy.policyId,
      roomInstanceId: rooms.sellerRooms[0].roomInstanceId,
    });
    expect(laneId).toBe(
      deriveMarketBaseLaneId({
        resourcePolicyId: policy.policyId,
        roomInstanceId: rooms.sellerRooms[0].roomInstanceId,
      }),
    );
    expect(
      deriveMarketBaseLaneId({
        resourcePolicyId: MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE.H.policyId,
        roomInstanceId: rooms.sellerRooms[0].roomInstanceId,
      }),
    ).not.toBe(laneId);
  });
});

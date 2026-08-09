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

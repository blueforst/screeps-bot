import {
  createMarketBaseRoomAdmissionPolicy,
  createMarketBaseSharedPolicy,
  MARKET_BASE_RESOURCE_FLOOR_BOOTSTRAP,
  marketBaseDerivedLaneSetFingerprint,
  reconcileMarketBaseDerivedLanes,
  reconcileMarketBaseSellerRooms,
  type MarketBaseRoomObservation,
  validateMarketBaseFloorBootstrap,
} from "@/runtime/marketBaseResourcePolicy";



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
});

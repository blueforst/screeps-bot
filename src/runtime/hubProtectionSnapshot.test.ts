import {
  HUB_PROTECTION_SNAPSHOT_SCHEMA,
  beginHubProtectionAttempt,
  buildCommittedHubProtectionSnapshot,
  observeHubProtectionConfigIncarnation,
  publishCommittedHubProtectionSnapshot,
  publishInvalidHubProtectionSnapshot,
  readFreshCommittedHubProtectionSnapshot,
  type HubProtectionConfigInput,
  type HubRuntimeProtectionExtension,
} from "@/runtime/hubProtectionSnapshot";

const HUB_ROOM = "W1N1";
const TICK = 10_000;

function config(
  overrides: Partial<HubProtectionConfigInput> = {},
): HubProtectionConfigInput {
  return {
    enabled: true,
    hubRoomName: HUB_ROOM,
    planInterval: 50,
    reservePerRoom: 5_000,
    hubReservePerCompound: 10_000,
    targetCompounds: [RESOURCE_CATALYZED_UTRIUM_ACID],
    storagePauseFreeCapacity: 100_000,
    surplusThreshold: 1_500,
    internalOnly: true,
    distributedStorage: true,
    ...overrides,
  };
}

function distributedRuntime(
  hydrogenResidual = 3_000,
): HubRuntimeProtectionExtension & {
  distributedSynthesis: {
    dispatchAssignments: unknown[];
    routeDecisions: unknown[];
    allocationLedger: Record<string, unknown>;
  };
} {
  return {
    distributedSynthesis: {
      dispatchAssignments: [
        {
          roomName: HUB_ROOM,
          product: RESOURCE_HYDROXIDE,
          targetAmount: 1_000,
          isHubRoom: true,
        },
      ],
      routeDecisions: [],
      allocationLedger: {
        [RESOURCE_HYDROGEN]: {
          resource: RESOURCE_HYDROGEN,
          totalAmount: hydrogenResidual,
          roomCommitments: { [HUB_ROOM]: hydrogenResidual },
        },
        [RESOURCE_CATALYZED_UTRIUM_ACID]: {
          resource: RESOURCE_CATALYZED_UTRIUM_ACID,
          totalAmount: 50_000,
          roomCommitments: { [HUB_ROOM]: 50_000 },
        },
      },
    },
  };
}

function commit(
  runtime: ReturnType<typeof distributedRuntime>,
  cfg = config(),
  planMode: "distributed" | "fallback" | "blocked" = "distributed",
  tick = TICK,
) {
  const attempt = beginHubProtectionAttempt(runtime, cfg, tick);
  const snapshot = buildCommittedHubProtectionSnapshot({
    revision: attempt.attemptRevision,
    configIncarnation: attempt.configIncarnation,
    tick,
    expiresAt: tick + 50,
    config: cfg,
    runtime,
    synthesisRooms: {},
    transferTasks: {},
    planMode,
  });
  publishCommittedHubProtectionSnapshot(runtime, attempt, snapshot);
  return snapshot;
}

describe("Hub committed market protection snapshot", () => {
  it("publishes only base-mineral allocation residual from the same revision", () => {
    const runtime = distributedRuntime(3_000);
    const snapshot = commit(runtime);

    expect(snapshot.schema).toBe(HUB_PROTECTION_SNAPSHOT_SCHEMA);
    expect(
      snapshot.baseMineralSurplus.byRoom[HUB_ROOM][RESOURCE_HYDROGEN],
    ).toBe(3_000);
    expect(
      snapshot.baseMineralSurplus.byRoom[HUB_ROOM][
        RESOURCE_CATALYZED_UTRIUM_ACID
      ],
    ).toBeUndefined();
    expect(snapshot.baseMineralSurplus.revision).toBe(snapshot.planRevision);
    expect(snapshot.distributed.revision).toBe(snapshot.planRevision);
    expect(
      readFreshCommittedHubProtectionSnapshot(runtime, config(), TICK),
    ).toBe(snapshot);
  });

  it("starting a successor attempt immediately makes the old commit unreadable", () => {
    const runtime = distributedRuntime();
    const first = commit(runtime);

    const successor = beginHubProtectionAttempt(runtime, config(), TICK + 1);

    expect(successor.attemptRevision).toBe(first.planRevision + 1);
    expect(runtime.protectionAttemptHighWater).toBe(successor.attemptRevision);
    expect(
      readFreshCommittedHubProtectionSnapshot(runtime, config(), TICK + 1),
    ).toBeUndefined();
    expect(runtime.committedProtectionSnapshot).toEqual(
      expect.objectContaining({
        planRevision: successor.attemptRevision,
        status: "in_progress",
        valid: false,
      }),
    );
  });

  it("never reuses a prior config incarnation after A→B→A", () => {
    const runtime = distributedRuntime();
    const configA = config();
    const first = commit(runtime, configA);
    const firstIncarnation = first.configIncarnation;

    const configB = config({ surplusThreshold: 2_000 });
    const observedB = observeHubProtectionConfigIncarnation(
      runtime,
      configB,
      TICK + 1,
    );
    const observedAAgain = observeHubProtectionConfigIncarnation(
      runtime,
      configA,
      TICK + 2,
    );

    expect(observedB.changed).toBe(true);
    expect(observedB.observation.incarnation).toBe(firstIncarnation + 1);
    expect(observedAAgain.changed).toBe(true);
    expect(observedAAgain.observation.incarnation).toBe(
      firstIncarnation + 2,
    );
    expect(runtime.protectionConfigIncarnationHighWater).toBe(
      firstIncarnation + 2,
    );
    expect(
      readFreshCommittedHubProtectionSnapshot(
        runtime,
        configA,
        TICK + 2,
      ),
    ).toBeUndefined();
  });

  it("treats disable→reenable as a new config incarnation", () => {
    const runtime = distributedRuntime();
    const configA = config();
    const first = commit(runtime, configA);

    const disabled = observeHubProtectionConfigIncarnation(
      runtime,
      { ...configA, enabled: false },
      TICK + 1,
    );
    const reenabled = observeHubProtectionConfigIncarnation(
      runtime,
      configA,
      TICK + 2,
    );

    expect(disabled.observation.incarnation).toBe(
      first.configIncarnation + 1,
    );
    expect(reenabled.observation.incarnation).toBe(
      first.configIncarnation + 2,
    );
    expect(
      readFreshCommittedHubProtectionSnapshot(
        runtime,
        configA,
        TICK + 2,
      ),
    ).toBeUndefined();
  });

  it("advances past a one-sided config-incarnation high-water rollback", () => {
    const runtime = distributedRuntime();
    const configA = config();
    const first = commit(runtime, configA);
    runtime.protectionConfigIncarnationHighWater = 0;

    const recovered = observeHubProtectionConfigIncarnation(
      runtime,
      configA,
      TICK + 1,
    );

    expect(recovered.changed).toBe(true);
    expect(recovered.observation.incarnation).toBe(
      first.configIncarnation + 1,
    );
    expect(runtime.protectionConfigIncarnationHighWater).toBe(
      first.configIncarnation + 1,
    );
    expect(
      readFreshCommittedHubProtectionSnapshot(
        runtime,
        configA,
        TICK + 1,
      ),
    ).toBeUndefined();
  });

  it("publishes an invalid empty successor after an early-return/throw outcome", () => {
    const runtime = distributedRuntime();
    commit(runtime);
    const attempt = beginHubProtectionAttempt(runtime, config(), TICK + 1);

    publishInvalidHubProtectionSnapshot(
      runtime,
      attempt,
      config(),
      TICK + 1,
      "failed",
      "fixture_throw",
    );

    expect(runtime.committedProtectionSnapshot).toEqual(
      expect.objectContaining({
        planRevision: attempt.attemptRevision,
        status: "failed",
        valid: false,
        distributed: expect.objectContaining({
          dispatchAssignments: [],
          routeDecisions: [],
          allocationLedger: {},
        }),
        baseMineralSurplus: expect.objectContaining({
          byRoom: { [HUB_ROOM]: {} },
        }),
      }),
    );
    expect(
      readFreshCommittedHubProtectionSnapshot(runtime, config(), TICK + 1),
    ).toBeUndefined();
  });

  it("fallback and blocked commits explicitly publish an empty residual", () => {
    for (const planMode of ["fallback", "blocked"] as const) {
      const runtime = distributedRuntime(8_000);
      const snapshot = commit(runtime, config(), planMode);
      expect(snapshot.baseMineralSurplus.byRoom[HUB_ROOM]).toEqual({});
      expect(
        readFreshCommittedHubProtectionSnapshot(runtime, config(), TICK),
      ).toBe(snapshot);
    }
  });

  it("rejects config drift and any cross-revision child field", () => {
    const runtime = distributedRuntime();
    const snapshot = commit(runtime);

    expect(
      readFreshCommittedHubProtectionSnapshot(
        runtime,
        config({ reservePerRoom: 6_000 }),
        TICK,
      ),
    ).toBeUndefined();

    snapshot.distributed.revision += 1;
    expect(
      readFreshCommittedHubProtectionSnapshot(runtime, config(), TICK),
    ).toBeUndefined();
  });

  it("rejects a forged surplus that is larger than the committed residual", () => {
    const runtime = distributedRuntime(2_000);
    const snapshot = commit(runtime);
    snapshot.baseMineralSurplus.byRoom[HUB_ROOM][RESOURCE_HYDROGEN] = 2_001;

    expect(
      readFreshCommittedHubProtectionSnapshot(runtime, config(), TICK),
    ).toBeUndefined();
  });
});

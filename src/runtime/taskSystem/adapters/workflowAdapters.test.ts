import remoteMiningWorkflowDefault, {
  remoteMiningWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/remoteMiningWorkflow";
import colonizationWorkflowDefault, {
  colonizationWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/colonizationWorkflow";
import rescueWorkflowDefault, {
  rescueWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/rescueWorkflow";
import flagHaulingWorkflowDefault, {
  flagHaulingWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/flagHaulingWorkflow";
import crossShardColonizationWorkflowDefault, {
  crossShardColonizationWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/crossShardColonizationWorkflow";
import type { TaskSystemAdapter } from "@/runtime/taskSystem/model";

type UnknownRecord = Record<string, unknown>;

const ADAPTERS: readonly [string, TaskSystemAdapter][] = [
  ["remoteMining", remoteMiningWorkflowAdapter],
  ["colonization", colonizationWorkflowAdapter],
  ["rescue", rescueWorkflowAdapter],
  ["flagHauling", flagHaulingWorkflowAdapter],
  ["crossShardColonization", crossShardColonizationWorkflowAdapter],
];

function installData(data: UnknownRecord): UnknownRecord {
  Memory.data = data as unknown as NonNullable<Memory["data"]>;
  return data;
}

function remoteMiningTask(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    sourceRoom: "W1N1",
    targetRoom: "W2N2",
    status: "active",
    sourceIds: ["source-a", "source-b"],
    assignedAt: 10,
    updatedAt: 20,
    lastVerifiedAt: 18,
    ...overrides,
  };
}

function colonizationTask(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    sourceRoom: "W1N1",
    targetRoom: "W3N3",
    status: "claiming",
    flagName: "CL_W1N1",
    planReady: false,
    claimCompleted: false,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function rescueTask(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    sourceRoom: "W1N1",
    targetRoom: "W4N4",
    status: "bootstrapping",
    flagName: "RESCUE_W1N1",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function flagHaulingTask(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    sourceRoom: "W1N1",
    targetRoom: "W5N5",
    flagName: "HAUL_W1N1",
    targetX: 23,
    targetY: 17,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function crossShardColonizationTask(overrides: UnknownRecord = {}): UnknownRecord {
  return {
    targetShard: "shard2",
    targetRoom: "W6N6",
    preferredSourceRoom: "W1N1",
    sourceRoom: "W1N1",
    status: "ready",
    flagName: "CLX_shard2_W6N6_W1N1",
    portalId: "portal-a",
    portalRoom: "W8N8",
    destinationRoom: "W9N9",
    claimerConfigName: "W1N1:crossShard:shard2:W6N6:claimer:0",
    claimerName: "cross-shard-claimer",
    createdAt: 10,
    updatedAt: 20,
    lastReadyAt: 19,
    ...overrides,
  };
}

describe("domain workflow task-system adapters", () => {
  test("exports the five canonical default and named adapters", () => {
    expect(remoteMiningWorkflowDefault).toBe(remoteMiningWorkflowAdapter);
    expect(colonizationWorkflowDefault).toBe(colonizationWorkflowAdapter);
    expect(rescueWorkflowDefault).toBe(rescueWorkflowAdapter);
    expect(flagHaulingWorkflowDefault).toBe(flagHaulingWorkflowAdapter);
    expect(crossShardColonizationWorkflowDefault).toBe(crossShardColonizationWorkflowAdapter);
    expect(ADAPTERS.map(([, adapter]) => adapter.system)).toEqual([
      "remote-mining-workflow",
      "colonization-workflow",
      "rescue-workflow",
      "flag-hauling-workflow",
      "cross-shard-colonization-workflow",
    ]);
  });

  test("does not ensure missing stores or mutate an empty Memory.data object", () => {
    Memory.data = undefined;
    for (const [, adapter] of ADAPTERS) {
      expect(adapter.snapshot(undefined)).toEqual({
        entries: [],
        invalidCount: 0,
        issues: [],
      });
      expect(Memory.data).toBeUndefined();
    }

    const data = installData({});
    for (const [storeName, adapter] of ADAPTERS) {
      expect(adapter.snapshot(undefined)).toEqual({
        entries: [],
        invalidCount: 0,
        issues: [],
      });
      expect(Memory.data).toBe(data);
      expect(Object.prototype.hasOwnProperty.call(data, storeName)).toBe(false);
    }
  });

  test("preserves domain status, flag, source-target, retry, and shard facts", () => {
    installData({
      remoteMining: {
        W2N2: remoteMiningTask({
          status: "abandoned",
          abandonedReason: "unsafe",
          nextRetryAt: 5_020,
        }),
      },
      colonization: {
        W3N3: colonizationTask({
          status: "waiting_plan",
          claimCompleted: true,
          scoutSafe: true,
          scoutRouteRooms: ["W1N1", "W2N2", "W3N3"],
          dangerousRooms: ["W2N2"],
          temporaryDangerousRooms: { W2N2: 900 },
          permanentDangerousRooms: ["W7N7"],
          scoutedAt: 17,
          planRetryAt: 70,
          safeRouteRetryKey: "route:v1",
        }),
      },
      rescue: {
        W4N4: rescueTask({
          status: "managed",
          routeRooms: ["W1N1", "W2N2", "W4N4"],
        }),
      },
      flagHauling: {
        HAUL_W1N1: flagHaulingTask(),
      },
      crossShardColonization: {
        "shard2:W6N6": crossShardColonizationTask({
          status: "bootstrapping",
          reason: "bootstrap squad dispatched",
          claimerConfigName: "W1N1:crossShard:claimer:0",
          claimerName: "cross-shard-claimer",
          bootstrapConfigNames: ["bootstrap-harvester", "bootstrap-worker"],
          claimedAt: 30,
          bootstrapDispatchedAt: 40,
          lastObservedAt: 35,
        }),
      },
    });

    const remote = remoteMiningWorkflowAdapter.snapshot(undefined).entries[0];
    expect(remote).toEqual(expect.objectContaining({
      ref: {
        system: "remote-mining-workflow",
        namespace: "remoteMining",
        scope: { kind: "cross_room", fromRoomName: "W1N1", toRoomName: "W2N2" },
        localId: "W2N2",
      },
      activity: "terminal",
      sourceState: "abandoned",
      authorities: [
        { role: "producer", id: "remoteMining" },
        { role: "workflow_owner", id: "W1N1", component: "source-room" },
      ],
      sourceRoom: "W1N1",
      targetRoom: "W2N2",
      sourceIds: ["source-a", "source-b"],
      abandonedReason: "unsafe",
      nextRetryAt: 5_020,
      blocker: "unsafe",
    }));
    expect(remote.retryAt).toBeUndefined();
    expect(remote.issues).toContainEqual(expect.objectContaining({
      code: "remote-mining-inert-retry",
      field: "nextRetryAt",
    }));

    const colonization = colonizationWorkflowAdapter.snapshot(undefined).entries[0];
    expect(colonization).toEqual(expect.objectContaining({
      activity: "blocked",
      sourceState: "waiting_plan",
      blocker: "waiting_plan",
      retryAt: 70,
      planRetryAt: 70,
      safeRouteRetryAt: undefined,
      flagName: "CL_W1N1",
      sourceRoom: "W1N1",
      targetRoom: "W3N3",
      scoutRouteRooms: ["W1N1", "W2N2", "W3N3"],
      temporaryDangerousRooms: { W2N2: 900 },
      authorities: [
        { role: "producer", id: "CL_W1N1", component: "flag" },
        { role: "workflow_owner", id: "W1N1", component: "source-room" },
      ],
    }));

    expect(rescueWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
      activity: "running",
      sourceState: "managed",
      flagName: "RESCUE_W1N1",
      sourceRoom: "W1N1",
      targetRoom: "W4N4",
      routeRooms: ["W1N1", "W2N2", "W4N4"],
    }));

    expect(flagHaulingWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
      activity: "running",
      sourceState: "present",
      flagName: "HAUL_W1N1",
      sourceRoom: "W1N1",
      targetRoom: "W5N5",
      targetX: 23,
      targetY: 17,
    }));

    const crossShard = crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0];
    expect(crossShard).toEqual(expect.objectContaining({
      ref: {
        system: "cross-shard-colonization-workflow",
        namespace: "crossShardColonization",
        scope: { kind: "shard_room", shardName: "shard2", roomName: "W6N6" },
        localId: "shard2:W6N6",
      },
      activity: "running",
      sourceState: "bootstrapping",
      targetShard: "shard2",
      targetRoom: "W6N6",
      sourceRoom: "W1N1",
      flagName: "CLX_shard2_W6N6_W1N1",
      reason: "bootstrap squad dispatched",
      blocker: undefined,
      bootstrapConfigNames: ["bootstrap-harvester", "bootstrap-worker"],
      bootstrapDispatchedAt: 40,
      lastProgressAt: 40,
    }));
  });

  test("maps every known workflow status without replacing sourceState", () => {
    const remoteStatuses = {
      scouting: "running",
      active: "running",
      suspended: "blocked",
      defending: "running",
      abandoned: "terminal",
    } as const;
    for (const [status, activity] of Object.entries(remoteStatuses)) {
      const stateFacts: UnknownRecord = {};
      if (status === "suspended") {
        stateFacts.suspendReason = "hostile_creeps";
        stateFacts.suspendedAt = 12;
        stateFacts.lastThreatAt = 18;
      }
      if (status === "defending") {
        stateFacts.defendingSince = 12;
        stateFacts.lastDefenseThreatAt = 18;
        stateFacts.defenseReason = "npc_invader";
      }
      installData({ remoteMining: { W2N2: remoteMiningTask({ status, ...stateFacts }) } });
      expect(remoteMiningWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
        activity,
        sourceState: status,
      }));
    }

    const colonizationStatuses = {
      claiming: "running",
      clearing: "running",
      waiting_plan: "blocked",
      bootstrapping: "running",
      managed: "running",
    } as const;
    for (const [status, activity] of Object.entries(colonizationStatuses)) {
      const stateFacts: UnknownRecord = {};
      if (status === "waiting_plan") {
        stateFacts.claimCompleted = true;
        stateFacts.planReady = false;
      }
      if (status === "bootstrapping" || status === "managed") {
        stateFacts.claimCompleted = true;
        stateFacts.planReady = true;
      }
      installData({ colonization: { W3N3: colonizationTask({ status, ...stateFacts }) } });
      expect(colonizationWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
        activity,
        sourceState: status,
      }));
    }

    for (const status of ["bootstrapping", "managed"] as const) {
      installData({ rescue: { W4N4: rescueTask({ status }) } });
      expect(rescueWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(expect.objectContaining({
        activity: "running",
        sourceState: status,
      }));
    }

    const crossShardStatuses = {
      planning: "available",
      ready: "available",
      spawning: "running",
      in_transit: "running",
      claimed: "running",
      bootstrapping: "running",
      completed: "terminal",
      blocked: "blocked",
      failed: "terminal",
    } as const;
    for (const [status, activity] of Object.entries(crossShardStatuses)) {
      const stateFacts: UnknownRecord = {};
      if (status === "in_transit") stateFacts.launchedAt = 15;
      if (status === "claimed") stateFacts.claimedAt = 15;
      if (status === "bootstrapping") stateFacts.bootstrapDispatchedAt = 15;
      if (status === "completed") stateFacts.completedAt = 15;
      if (status === "blocked" || status === "failed") stateFacts.reason = `${status}-reason`;
      installData({
        crossShardColonization: {
          "shard2:W6N6": crossShardColonizationTask({ status, ...stateFacts }),
        },
      });
      expect(crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0]).toEqual(
        expect.objectContaining({ activity, sourceState: status }),
      );
    }
  });

  test("accepts RemoteMining atomic writer facts and rejects incomplete suspended or defending states", () => {
    installData({
      remoteMining: {
        W2N2: remoteMiningTask({
          status: "suspended",
          suspendReason: "hostile_creeps",
          suspendedAt: 12,
          lastThreatAt: 18,
        }),
        W3N3: remoteMiningTask({
          targetRoom: "W3N3",
          status: "defending",
          defendingSince: 11,
          lastDefenseThreatAt: 19,
          defenseReason: "npc_invader_core",
        }),
      },
    });

    const validEntries = remoteMiningWorkflowAdapter.snapshot(undefined).entries;
    expect(validEntries[0]).toEqual(expect.objectContaining({
      activity: "blocked",
      sourceState: "suspended",
      suspendReason: "hostile_creeps",
      suspendedAt: 12,
      lastThreatAt: 18,
    }));
    expect(validEntries[1]).toEqual(expect.objectContaining({
      activity: "running",
      sourceState: "defending",
      defendingSince: 11,
      lastDefenseThreatAt: 19,
      defenseReason: "npc_invader_core",
    }));

    const incompleteCases: readonly [string, UnknownRecord, string][] = [
      [
        "suspended",
        { suspendReason: undefined, suspendedAt: 12, lastThreatAt: 18 },
        "suspendReason",
      ],
      [
        "suspended",
        { suspendReason: "hostile_creeps", suspendedAt: undefined, lastThreatAt: 18 },
        "suspendedAt",
      ],
      [
        "suspended",
        { suspendReason: "hostile_creeps", suspendedAt: 12, lastThreatAt: undefined },
        "lastThreatAt",
      ],
      [
        "defending",
        { defendingSince: undefined, lastDefenseThreatAt: 18, defenseReason: "npc_invader" },
        "defendingSince",
      ],
      [
        "defending",
        { defendingSince: 12, lastDefenseThreatAt: undefined, defenseReason: "npc_invader" },
        "lastDefenseThreatAt",
      ],
      [
        "defending",
        { defendingSince: 12, lastDefenseThreatAt: 18, defenseReason: undefined },
        "defenseReason",
      ],
    ];
    for (const [status, facts, missingField] of incompleteCases) {
      installData({ remoteMining: { W2N2: remoteMiningTask({ status, ...facts }) } });
      const entry = remoteMiningWorkflowAdapter.snapshot(undefined).entries[0];
      expect(entry.activity).toBe("unknown");
      expect(entry.sourceState).toBe(status);
      expect(entry.issues).toContainEqual(expect.objectContaining({
        code: "remote-mining-state-fact-conflict",
        field: missingField,
      }));
    }
  });

  test("validates Colonization plan and claim facts against status writers", () => {
    const cases: readonly [string, boolean, boolean, string][] = [
      ["waiting_plan", false, true, "blocked"],
      ["waiting_plan", true, true, "unknown"],
      ["waiting_plan", false, false, "unknown"],
      ["bootstrapping", true, true, "running"],
      ["bootstrapping", false, true, "unknown"],
      ["bootstrapping", true, false, "unknown"],
      // managed writer only changes status, so it preserves any already-valid boolean pair.
      ["managed", false, false, "running"],
    ];

    for (const [status, planReady, claimCompleted, activity] of cases) {
      installData({
        colonization: {
          W3N3: colonizationTask({ status, planReady, claimCompleted }),
        },
      });
      const entry = colonizationWorkflowAdapter.snapshot(undefined).entries[0];
      expect(entry.activity).toBe(activity);
      expect(entry.sourceState).toBe(status);
      if (activity === "unknown") {
        expect(entry.issues).toContainEqual(expect.objectContaining({
          code: "colonization-state-fact-conflict",
          field: "status",
        }));
      }
    }
  });

  test("requires CrossShard source and portal facts for runnable manager states", () => {
    const statuses = ["ready", "spawning", "in_transit", "bootstrapping"] as const;
    for (const status of statuses) {
      const timestamps: UnknownRecord = {};
      if (status === "in_transit") timestamps.launchedAt = 15;
      if (status === "bootstrapping") timestamps.bootstrapDispatchedAt = 15;

      installData({
        crossShardColonization: {
          "shard2:W6N6": crossShardColonizationTask({ status, ...timestamps }),
        },
      });
      expect(crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0].activity)
        .not.toBe("unknown");

      for (const missingField of ["sourceRoom", "portalRoom"] as const) {
        installData({
          crossShardColonization: {
            "shard2:W6N6": crossShardColonizationTask({
              status,
              ...timestamps,
              [missingField]: undefined,
            }),
          },
        });
        const entry = crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0];
        expect(entry.activity).toBe("unknown");
        expect(entry.sourceState).toBe(status);
        expect(entry.issues).toContainEqual(expect.objectContaining({
          code: "cross-shard-state-fact-conflict",
          field: missingField,
        }));
      }
    }

    for (const status of ["ready", "spawning", "in_transit"] as const) {
      const timestamps: UnknownRecord = status === "in_transit" ? { launchedAt: 15 } : {};
      for (const missingField of ["claimerConfigName", "claimerName"] as const) {
        installData({
          crossShardColonization: {
            "shard2:W6N6": crossShardColonizationTask({
              status,
              ...timestamps,
              [missingField]: undefined,
            }),
          },
        });
        const entry = crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0];
        expect(entry.activity).toBe("unknown");
        expect(entry.issues).toContainEqual(expect.objectContaining({
          code: "cross-shard-state-fact-conflict",
          field: missingField,
        }));
      }
    }

    const timestampCases: readonly [string, string][] = [
      ["in_transit", "launchedAt"],
      ["claimed", "claimedAt"],
      ["bootstrapping", "bootstrapDispatchedAt"],
      ["completed", "completedAt"],
    ];
    for (const [status, requiredTimestamp] of timestampCases) {
      installData({
        crossShardColonization: {
          "shard2:W6N6": crossShardColonizationTask({ status }),
        },
      });
      const entry = crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0];
      expect(entry.activity).toBe("unknown");
      expect(entry.issues).toContainEqual(expect.objectContaining({
        code: "state-fact-conflict",
        field: requiredTimestamp,
      }));
    }

    for (const [status, timestamp, activity] of [
      ["claimed", { claimedAt: 15 }, "running"],
      ["completed", { completedAt: 15 }, "terminal"],
    ] as const) {
      installData({
        crossShardColonization: {
          "shard2:W6N6": crossShardColonizationTask({
            status,
            ...timestamp,
            sourceRoom: undefined,
            portalRoom: undefined,
            claimerConfigName: undefined,
            claimerName: undefined,
          }),
        },
      });
      expect(crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0].activity)
        .toBe(activity);
    }
  });

  test("keeps independent Colonization retries instead of inventing one ordering", () => {
    installData({
      colonization: {
        W3N3: colonizationTask({
          status: "waiting_plan",
          planRetryAt: 70,
          safeRouteRetryAt: 60,
        }),
      },
    });

    const entry = colonizationWorkflowAdapter.snapshot(undefined).entries[0];
    expect(entry.planRetryAt).toBe(70);
    expect(entry.safeRouteRetryAt).toBe(60);
    expect(entry.retryAt).toBeUndefined();
    expect(entry.issues).toContainEqual(expect.objectContaining({
      code: "multiple-domain-retries",
      field: "retryAt",
    }));
  });

  test("fails closed for unknown status and malformed fields while retaining provable refs", () => {
    installData({
      remoteMining: {
        W2N2: remoteMiningTask({ status: "future", sourceIds: "legacy", updatedAt: -1 }),
        broken: null,
      },
      colonization: {
        W3N3: colonizationTask({ status: "future", flagName: undefined, planReady: undefined }),
        broken: 1,
      },
      rescue: {
        W4N4: rescueTask({ status: "future", flagName: undefined, routeRooms: "legacy" }),
        broken: [],
      },
      flagHauling: {
        HAUL_W1N1: flagHaulingTask({ flagName: undefined, targetX: 50 }),
        broken: "legacy",
      },
      crossShardColonization: {
        "shard2:W6N6": crossShardColonizationTask({ status: "future", flagName: undefined }),
        broken: false,
      },
    });

    for (const [, adapter] of ADAPTERS) {
      const result = adapter.snapshot(undefined);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].activity).toBe("unknown");
      expect(result.entries[0].issues.length).toBeGreaterThan(0);
      expect(result.invalidCount).toBe(1);
      expect(result.issues).toHaveLength(1);
    }

    expect(remoteMiningWorkflowAdapter.snapshot(undefined).entries[0].sourceState).toBe("future");
    expect(colonizationWorkflowAdapter.snapshot(undefined).entries[0].issues).toContainEqual(
      expect.objectContaining({ code: "invalid-flag-name" }),
    );
    expect(rescueWorkflowAdapter.snapshot(undefined).entries[0].issues).toContainEqual(
      expect.objectContaining({ code: "unknown-domain-status" }),
    );
    expect(flagHaulingWorkflowAdapter.snapshot(undefined).entries[0].issues).toContainEqual(
      expect.objectContaining({ code: "invalid-room-coordinate" }),
    );
    expect(crossShardColonizationWorkflowAdapter.snapshot(undefined).entries[0].issues).toContainEqual(
      expect.objectContaining({ code: "unknown-domain-status" }),
    );
  });

  test("uses a valid room store key to retain legacy entries with a missing target fact", () => {
    installData({
      remoteMining: {
        W2N2: remoteMiningTask({ targetRoom: undefined }),
      },
      colonization: {
        W3N3: colonizationTask({ targetRoom: undefined }),
      },
      rescue: {
        W4N4: rescueTask({ targetRoom: undefined }),
      },
    });

    for (const adapter of [
      remoteMiningWorkflowAdapter,
      colonizationWorkflowAdapter,
      rescueWorkflowAdapter,
    ]) {
      const result = adapter.snapshot(undefined);
      expect(result.invalidCount).toBe(0);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].activity).toBe("unknown");
      expect(result.entries[0].issues).toContainEqual(expect.objectContaining({
        code: "invalid-target-room",
        field: "targetRoom",
      }));
    }
  });

  test("reports malformed store shapes without changing them", () => {
    for (const [storeName, adapter] of ADAPTERS) {
      const store = Object.freeze([Object.freeze({ sourceRoom: "W1N1" })]);
      const data = installData({ [storeName]: store });

      expect(adapter.snapshot(undefined)).toEqual({
        entries: [],
        invalidCount: 1,
        issues: [expect.objectContaining({ code: "invalid-workflow-store" })],
      });
      expect((data as UnknownRecord)[storeName]).toBe(store);
      expect(store).toHaveLength(1);
    }
  });

  test("bounds system-level malformed diagnostics while retaining the exact invalid count", () => {
    const malformedEntries = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`broken-${index}`, index]),
    );
    installData({ remoteMining: malformedEntries });

    const result = remoteMiningWorkflowAdapter.snapshot(undefined);
    expect(result.entries).toEqual([]);
    expect(result.invalidCount).toBe(25);
    expect(result.issues).toHaveLength(20);
  });

  test("returns deterministic, deeply isolated output without sorting or changing sources", () => {
    const remoteLate = remoteMiningTask({
      targetRoom: "W3N3",
      sourceIds: ["late-source"],
    });
    const remoteEarly = remoteMiningTask({
      targetRoom: "W2N2",
      sourceIds: ["early-source"],
    });
    const colonization = colonizationTask({
      scoutRouteRooms: ["W1N1", "W3N3"],
      temporaryDangerousRooms: { W8N8: 100 },
    });
    const rescue = rescueTask({ routeRooms: ["W1N1", "W4N4"] });
    const hauling = flagHaulingTask();
    const crossShard = crossShardColonizationTask({
      bootstrapConfigNames: ["bootstrap-a"],
    });
    const data = installData({
      remoteMining: { W3N3: remoteLate, W2N2: remoteEarly },
      colonization: { W3N3: colonization },
      rescue: { W4N4: rescue },
      flagHauling: { HAUL_W1N1: hauling },
      crossShardColonization: { "shard2:W6N6": crossShard },
    });
    const before = JSON.stringify(data);

    const remoteResult = remoteMiningWorkflowAdapter.snapshot(undefined);
    const colonizationResult = colonizationWorkflowAdapter.snapshot(undefined);
    const rescueResult = rescueWorkflowAdapter.snapshot(undefined);
    const haulingResult = flagHaulingWorkflowAdapter.snapshot(undefined);
    const crossShardResult = crossShardColonizationWorkflowAdapter.snapshot(undefined);

    expect(remoteResult.entries.map((entry) => entry.ref.localId)).toEqual(["W2N2", "W3N3"]);

    const mutableRemote = remoteResult.entries[0] as any;
    mutableRemote.ref.scope.toRoomName = "W9N9";
    mutableRemote.authorities[0].id = "changed";
    mutableRemote.sourceIds[0] = "changed";
    mutableRemote.issues.push({ code: "changed", message: "changed" });

    const mutableColonization = colonizationResult.entries[0] as any;
    mutableColonization.scoutRouteRooms[0] = "W9N9";
    mutableColonization.temporaryDangerousRooms.W8N8 = 1;

    (rescueResult.entries[0] as any).routeRooms[0] = "W9N9";
    (haulingResult.entries[0] as any).targetX = 0;
    (crossShardResult.entries[0] as any).bootstrapConfigNames[0] = "changed";

    expect(JSON.stringify(data)).toBe(before);
    expect(Object.keys((data.remoteMining as UnknownRecord))).toEqual(["W3N3", "W2N2"]);
    expect((remoteEarly.sourceIds as string[])[0]).toBe("early-source");
    expect((colonization.scoutRouteRooms as string[])[0]).toBe("W1N1");
    expect((colonization.temporaryDangerousRooms as UnknownRecord).W8N8).toBe(100);
    expect((rescue.routeRooms as string[])[0]).toBe("W1N1");
    expect(hauling.targetX).toBe(23);
    expect((crossShard.bootstrapConfigNames as string[])[0]).toBe("bootstrap-a");

    const second = remoteMiningWorkflowAdapter.snapshot(undefined).entries[0];
    expect(second.ref.scope).toEqual({
      kind: "cross_room",
      fromRoomName: "W1N1",
      toRoomName: "W2N2",
    });
    expect(second.authorities[0].id).toBe("remoteMining");
    expect(second.sourceIds).toEqual(["early-source"]);
    expect(second.issues).toEqual([]);
  });
});

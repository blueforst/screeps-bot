import {
  remoteMiningWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/remoteMiningWorkflow";
import {
  colonizationWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/colonizationWorkflow";
import {
  rescueWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/rescueWorkflow";
import {
  flagHaulingWorkflowAdapter,
} from "@/runtime/taskSystem/adapters/flagHaulingWorkflow";
import {
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

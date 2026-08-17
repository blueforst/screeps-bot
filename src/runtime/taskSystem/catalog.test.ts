import {
  TASK_SYSTEM_CATALOG,
  isTaskSystemId,
  type TaskSystemCatalogEntry,
  type TaskSystemId,
} from "@/runtime/taskSystem/catalog";

const EXPECTED_CATALOG = {
  "worker-work": {
    model: "dispatch_projection",
    durability: "heap",
    scope: "room",
    reconcile: "world_projection",
    claim: "slot",
    domainOwner: "workerTaskPool",
  },
  "carrier-logistics": {
    model: "dispatch_projection",
    durability: "heap",
    scope: "room",
    reconcile: "owner_snapshot",
    claim: "same_tick_amount",
    domainOwner: "carrierTaskBoard",
  },
  "power-creep-action": {
    model: "actor_queue",
    durability: "actor_memory",
    scope: "actor",
    reconcile: "actor_queue",
    claim: "exclusive_actor",
    domainOwner: "powerCreepControl",
  },
  "resource-transfer": {
    model: "durable_command",
    durability: "memory",
    scope: "cross_room",
    reconcile: "additive_command",
    claim: "domain_owned",
    domainOwner: "resourceTransferTasks",
  },
  "factory-command": {
    model: "durable_command",
    durability: "memory",
    scope: "room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "factoryControl",
  },
  "remote-mining-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "remoteMining",
  },
  "colonization-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "colonization",
  },
  "rescue-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "rescue",
  },
  "flag-hauling-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "flagHauling",
  },
  "cross-shard-colonization-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "shard_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "crossShardColonization",
  },
  "war-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "warControl",
  },
  "power-bank-workflow": {
    model: "domain_workflow",
    durability: "memory",
    scope: "object",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "powerBankHarvest",
  },
  "spawn-production": {
    model: "production_intent",
    durability: "memory",
    scope: "global",
    reconcile: "desired_actor",
    claim: "queue_owner",
    domainOwner: "spawnPlanner",
  },
} as const satisfies Record<string, TaskSystemCatalogEntry>;

type ExpectedTaskSystemId = keyof typeof EXPECTED_CATALOG;
type ExpectedTaskSystemGuard = (value: unknown) => value is TaskSystemId;
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

const taskSystemIdMatchesOwnKeys: IsExactly<TaskSystemId, ExpectedTaskSystemId> = true;
const taskSystemGuardMatchesContract: IsExactly<
  typeof isTaskSystemId,
  ExpectedTaskSystemGuard
> = true;

void taskSystemIdMatchesOwnKeys;
void taskSystemGuardMatchesContract;

describe("task system catalog", () => {
  test("contains exactly the thirteen canonical systems and capability metadata", () => {
    expect(Object.keys(TASK_SYSTEM_CATALOG).sort()).toEqual(
      Object.keys(EXPECTED_CATALOG).sort(),
    );
    expect(TASK_SYSTEM_CATALOG).toEqual(EXPECTED_CATALOG);
  });

  test("is frozen at the catalog and entry boundaries", () => {
    expect(Object.isFrozen(TASK_SYSTEM_CATALOG)).toBe(true);
    for (const entry of Object.values(TASK_SYSTEM_CATALOG)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  test("accepts every canonical system", () => {
    for (const system of Object.keys(EXPECTED_CATALOG) as ExpectedTaskSystemId[]) {
      expect(isTaskSystemId(system)).toBe(true);
    }
  });

  test("rejects every unknown, inherited, or non-string value", () => {
    for (const value of [
      "",
      "unknown-system",
      "constructor",
      "toString",
      "__proto__",
      undefined,
      null,
      0,
      {},
      [],
    ]) {
      expect(isTaskSystemId(value)).toBe(false);
    }
  });
});

export type TaskSystemModel =
  | "dispatch_projection"
  | "actor_queue"
  | "durable_command"
  | "domain_workflow"
  | "production_intent";

export type TaskSystemDurability = "heap" | "actor_memory" | "memory";

export type TaskSystemScopeKind =
  | "room"
  | "actor"
  | "cross_room"
  | "shard_room"
  | "object"
  | "global";

export type TaskSystemReconcileMode =
  | "world_projection"
  | "owner_snapshot"
  | "actor_queue"
  | "additive_command"
  | "domain_transition"
  | "desired_actor";

export type TaskSystemClaimMode =
  | "slot"
  | "same_tick_amount"
  | "exclusive_actor"
  | "domain_owned"
  | "queue_owner"
  | "none";

export interface TaskSystemCatalogEntry {
  readonly model: TaskSystemModel;
  readonly durability: TaskSystemDurability;
  readonly scope: TaskSystemScopeKind;
  readonly reconcile: TaskSystemReconcileMode;
  readonly claim: TaskSystemClaimMode;
  readonly domainOwner: string;
}

export const TASK_SYSTEM_CATALOG = Object.freeze({
  "worker-work": Object.freeze({
    model: "dispatch_projection",
    durability: "heap",
    scope: "room",
    reconcile: "world_projection",
    claim: "slot",
    domainOwner: "workerTaskPool",
  }),
  "carrier-logistics": Object.freeze({
    model: "dispatch_projection",
    durability: "heap",
    scope: "room",
    reconcile: "owner_snapshot",
    claim: "same_tick_amount",
    domainOwner: "carrierTaskBoard",
  }),
  "power-creep-action": Object.freeze({
    model: "actor_queue",
    durability: "actor_memory",
    scope: "actor",
    reconcile: "actor_queue",
    claim: "exclusive_actor",
    domainOwner: "powerCreepControl",
  }),
  "resource-transfer": Object.freeze({
    model: "durable_command",
    durability: "memory",
    scope: "cross_room",
    reconcile: "additive_command",
    claim: "domain_owned",
    domainOwner: "resourceTransferTasks",
  }),
  "factory-command": Object.freeze({
    model: "durable_command",
    durability: "memory",
    scope: "room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "factoryControl",
  }),
  "remote-mining-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "remoteMining",
  }),
  "colonization-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "colonization",
  }),
  "rescue-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "rescue",
  }),
  "flag-hauling-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "flagHauling",
  }),
  "cross-shard-colonization-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "shard_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "crossShardColonization",
  }),
  "war-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "cross_room",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "warControl",
  }),
  "power-bank-workflow": Object.freeze({
    model: "domain_workflow",
    durability: "memory",
    scope: "object",
    reconcile: "domain_transition",
    claim: "domain_owned",
    domainOwner: "powerBankHarvest",
  }),
  "spawn-production": Object.freeze({
    model: "production_intent",
    durability: "memory",
    scope: "global",
    reconcile: "desired_actor",
    claim: "queue_owner",
    domainOwner: "spawnPlanner",
  }),
} as const satisfies Record<string, TaskSystemCatalogEntry>);

export type TaskSystemId = keyof typeof TASK_SYSTEM_CATALOG;

export function isTaskSystemId(value: unknown): value is TaskSystemId {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(TASK_SYSTEM_CATALOG, value);
}

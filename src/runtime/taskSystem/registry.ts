import carrierLogisticsAdapter, {
  type CarrierLogisticsAdapterContext,
} from "@/runtime/taskSystem/adapters/carrierLogistics";
import colonizationWorkflowAdapter, {
  type ColonizationWorkflowAdapterContext,
} from "@/runtime/taskSystem/adapters/colonizationWorkflow";
import crossShardColonizationWorkflowAdapter, {
  type CrossShardColonizationWorkflowAdapterContext,
} from "@/runtime/taskSystem/adapters/crossShardColonizationWorkflow";
import factoryCommandAdapter, {
  type FactoryCommandAdapterContext,
} from "@/runtime/taskSystem/adapters/factoryCommand";
import flagHaulingWorkflowAdapter, {
  type FlagHaulingWorkflowAdapterContext,
} from "@/runtime/taskSystem/adapters/flagHaulingWorkflow";
import powerBankWorkflowAdapter from "@/runtime/taskSystem/adapters/powerBankWorkflow";
import powerCreepActionAdapter, {
  type PowerCreepActionAdapterContext,
} from "@/runtime/taskSystem/adapters/powerCreepAction";
import remoteMiningWorkflowAdapter, {
  type RemoteMiningWorkflowAdapterContext,
} from "@/runtime/taskSystem/adapters/remoteMiningWorkflow";
import rescueWorkflowAdapter, {
  type RescueWorkflowAdapterContext,
} from "@/runtime/taskSystem/adapters/rescueWorkflow";
import resourceTransferAdapter, {
  type ResourceTransferAdapterContext,
} from "@/runtime/taskSystem/adapters/resourceTransfer";
import { spawnProductionAdapter } from "@/runtime/taskSystem/adapters/spawnProduction";
import warWorkflowAdapter from "@/runtime/taskSystem/adapters/warWorkflow";
import workerWorkAdapter, {
  type WorkerWorkAdapterContext,
} from "@/runtime/taskSystem/adapters/workerWork";
import type { TaskSystemId } from "@/runtime/taskSystem/catalog";
import type { TaskSystemAdapter } from "@/runtime/taskSystem/model";

type WarWorkflowAdapterContext = Parameters<typeof warWorkflowAdapter.snapshot>[0];
type PowerBankWorkflowAdapterContext = Parameters<typeof powerBankWorkflowAdapter.snapshot>[0];

/**
 * 每个 key 都是独立的来源命名空间。需要预取快照的 adapter 使用必填 context；
 * 自行只读 Memory/Game 的 adapter 保留可选槽位，wrapper 仍只会传递本 system 的值。
 */
export interface TaskSystemCollectionSources {
  readonly "worker-work": WorkerWorkAdapterContext;
  readonly "carrier-logistics": CarrierLogisticsAdapterContext;
  readonly "power-creep-action": PowerCreepActionAdapterContext;
  readonly "resource-transfer"?: ResourceTransferAdapterContext;
  readonly "factory-command": FactoryCommandAdapterContext;
  readonly "remote-mining-workflow"?: RemoteMiningWorkflowAdapterContext;
  readonly "colonization-workflow"?: ColonizationWorkflowAdapterContext;
  readonly "rescue-workflow"?: RescueWorkflowAdapterContext;
  readonly "flag-hauling-workflow"?: FlagHaulingWorkflowAdapterContext;
  readonly "cross-shard-colonization-workflow"?: CrossShardColonizationWorkflowAdapterContext;
  readonly "war-workflow"?: WarWorkflowAdapterContext;
  readonly "power-bank-workflow"?: PowerBankWorkflowAdapterContext;
  readonly "spawn-production"?: undefined;
}

export interface TaskSystemCollectionContext {
  readonly observedAt: number;
  readonly shard: string;
  readonly sources: TaskSystemCollectionSources;
}

export type RegisteredTaskSystemAdapter<K extends TaskSystemId = TaskSystemId> =
  TaskSystemAdapter<TaskSystemCollectionContext> & { readonly system: K };

export type TaskSystemAdapterRegistry = {
  readonly [K in TaskSystemId]: RegisteredTaskSystemAdapter<K>;
};

function bindSourceAdapter<K extends TaskSystemId, TSource>(
  system: K,
  adapter: TaskSystemAdapter<TSource>,
  selectSource: (context: TaskSystemCollectionContext) => TSource,
): RegisteredTaskSystemAdapter<K> {
  return Object.freeze({
    system,
    snapshot(context: TaskSystemCollectionContext) {
      if (adapter.system !== system) {
        throw new Error(`Task system adapter mismatch: expected ${system}, received ${adapter.system}`);
      }
      return adapter.snapshot(selectSource(context));
    },
  });
}

function bindSourceFreeAdapter<K extends TaskSystemId>(
  system: K,
  adapter: TaskSystemAdapter<void>,
): RegisteredTaskSystemAdapter<K> {
  return Object.freeze({
    system,
    snapshot() {
      if (adapter.system !== system) {
        throw new Error(`Task system adapter mismatch: expected ${system}, received ${adapter.system}`);
      }
      return adapter.snapshot();
    },
  });
}

export const TASK_SYSTEM_ADAPTER_REGISTRY: TaskSystemAdapterRegistry = Object.freeze({
  "worker-work": bindSourceAdapter(
    "worker-work",
    workerWorkAdapter,
    (context) => context.sources["worker-work"],
  ),
  "carrier-logistics": bindSourceAdapter(
    "carrier-logistics",
    carrierLogisticsAdapter,
    (context) => context.sources["carrier-logistics"],
  ),
  "power-creep-action": bindSourceAdapter(
    "power-creep-action",
    powerCreepActionAdapter,
    (context) => context.sources["power-creep-action"],
  ),
  "resource-transfer": bindSourceAdapter(
    "resource-transfer",
    resourceTransferAdapter,
    (context) => context.sources["resource-transfer"],
  ),
  "factory-command": bindSourceAdapter(
    "factory-command",
    factoryCommandAdapter,
    (context) => context.sources["factory-command"],
  ),
  "remote-mining-workflow": bindSourceAdapter(
    "remote-mining-workflow",
    remoteMiningWorkflowAdapter,
    (context) => context.sources["remote-mining-workflow"],
  ),
  "colonization-workflow": bindSourceAdapter(
    "colonization-workflow",
    colonizationWorkflowAdapter,
    (context) => context.sources["colonization-workflow"],
  ),
  "rescue-workflow": bindSourceAdapter(
    "rescue-workflow",
    rescueWorkflowAdapter,
    (context) => context.sources["rescue-workflow"],
  ),
  "flag-hauling-workflow": bindSourceAdapter(
    "flag-hauling-workflow",
    flagHaulingWorkflowAdapter,
    (context) => context.sources["flag-hauling-workflow"],
  ),
  "cross-shard-colonization-workflow": bindSourceAdapter(
    "cross-shard-colonization-workflow",
    crossShardColonizationWorkflowAdapter,
    (context) => context.sources["cross-shard-colonization-workflow"],
  ),
  "war-workflow": bindSourceAdapter(
    "war-workflow",
    warWorkflowAdapter,
    (context) => context.sources["war-workflow"],
  ),
  "power-bank-workflow": bindSourceAdapter(
    "power-bank-workflow",
    powerBankWorkflowAdapter,
    (context) => context.sources["power-bank-workflow"],
  ),
  "spawn-production": bindSourceFreeAdapter("spawn-production", spawnProductionAdapter),
});

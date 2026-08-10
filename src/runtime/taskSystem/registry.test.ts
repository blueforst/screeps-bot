import carrierLogisticsAdapter from "@/runtime/taskSystem/adapters/carrierLogistics";
import colonizationWorkflowAdapter from "@/runtime/taskSystem/adapters/colonizationWorkflow";
import crossShardColonizationWorkflowAdapter from "@/runtime/taskSystem/adapters/crossShardColonizationWorkflow";
import factoryCommandAdapter from "@/runtime/taskSystem/adapters/factoryCommand";
import flagHaulingWorkflowAdapter from "@/runtime/taskSystem/adapters/flagHaulingWorkflow";
import powerBankWorkflowAdapter from "@/runtime/taskSystem/adapters/powerBankWorkflow";
import powerCreepActionAdapter from "@/runtime/taskSystem/adapters/powerCreepAction";
import remoteMiningWorkflowAdapter from "@/runtime/taskSystem/adapters/remoteMiningWorkflow";
import rescueWorkflowAdapter from "@/runtime/taskSystem/adapters/rescueWorkflow";
import resourceTransferAdapter from "@/runtime/taskSystem/adapters/resourceTransfer";
import { spawnProductionAdapter } from "@/runtime/taskSystem/adapters/spawnProduction";
import warWorkflowAdapter from "@/runtime/taskSystem/adapters/warWorkflow";
import workerWorkAdapter from "@/runtime/taskSystem/adapters/workerWork";
import { TASK_SYSTEM_CATALOG, type TaskSystemId } from "@/runtime/taskSystem/catalog";
import type { TaskSystemAdapter, TaskSystemAdapterResult } from "@/runtime/taskSystem/model";
import {
  TASK_SYSTEM_ADAPTER_REGISTRY,
  type TaskSystemCollectionContext,
  type TaskSystemCollectionSources,
} from "@/runtime/taskSystem/registry";

const EMPTY_RESULT: TaskSystemAdapterResult = {
  entries: [],
  invalidCount: 0,
  issues: [],
};

const SOURCE_MARKERS = {
  "worker-work": { board: {}, assignments: {} },
  "carrier-logistics": { board: {} },
  "power-creep-action": {
    powerCreepMemory: { marker: "power-creep-action" },
    actorNames: ["marker"],
  },
  "resource-transfer": { marker: "resource-transfer" },
  "factory-command": { tasks: { marker: "factory-command" } },
  "remote-mining-workflow": { marker: "remote-mining-workflow" },
  "colonization-workflow": { marker: "colonization-workflow" },
  "rescue-workflow": { marker: "rescue-workflow" },
  "flag-hauling-workflow": { marker: "flag-hauling-workflow" },
  "cross-shard-colonization-workflow": {
    marker: "cross-shard-colonization-workflow",
  },
  "war-workflow": { marker: "war-workflow" },
  "power-bank-workflow": { marker: "power-bank-workflow" },
  "spawn-production": undefined,
} satisfies TaskSystemCollectionSources;

const ADAPTERS_BY_SYSTEM = {
  "worker-work": workerWorkAdapter,
  "carrier-logistics": carrierLogisticsAdapter,
  "power-creep-action": powerCreepActionAdapter,
  "resource-transfer": resourceTransferAdapter,
  "factory-command": factoryCommandAdapter,
  "remote-mining-workflow": remoteMiningWorkflowAdapter,
  "colonization-workflow": colonizationWorkflowAdapter,
  "rescue-workflow": rescueWorkflowAdapter,
  "flag-hauling-workflow": flagHaulingWorkflowAdapter,
  "cross-shard-colonization-workflow": crossShardColonizationWorkflowAdapter,
  "war-workflow": warWorkflowAdapter,
  "power-bank-workflow": powerBankWorkflowAdapter,
  "spawn-production": spawnProductionAdapter,
} as const satisfies Record<TaskSystemId, TaskSystemAdapter<any>>;

function createContext(): TaskSystemCollectionContext {
  return {
    observedAt: 12345,
    shard: "shard:registry->test",
    sources: SOURCE_MARKERS,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("task system adapter registry", () => {
  test("statically covers the catalog exactly once and exposes immutable wrappers", () => {
    const catalogSystems = Object.keys(TASK_SYSTEM_CATALOG).sort();
    const registrySystems = Object.keys(TASK_SYSTEM_ADAPTER_REGISTRY).sort();

    expect(registrySystems).toEqual(catalogSystems);
    expect(new Set(registrySystems).size).toBe(13);
    expect(Object.isFrozen(TASK_SYSTEM_ADAPTER_REGISTRY)).toBe(true);

    for (const system of registrySystems as TaskSystemId[]) {
      expect(TASK_SYSTEM_ADAPTER_REGISTRY[system].system).toBe(system);
      expect(ADAPTERS_BY_SYSTEM[system].system).toBe(system);
      expect(Object.isFrozen(TASK_SYSTEM_ADAPTER_REGISTRY[system])).toBe(true);
    }
  });

  test("passes only the matching canonical source context to each adapter", () => {
    const context = createContext();
    const spies = Object.fromEntries(
      (Object.keys(ADAPTERS_BY_SYSTEM) as TaskSystemId[]).map((system) => [
        system,
        jest.spyOn(ADAPTERS_BY_SYSTEM[system] as any, "snapshot")
          .mockReturnValue(EMPTY_RESULT),
      ]),
    ) as Record<TaskSystemId, jest.SpyInstance>;

    for (const system of Object.keys(TASK_SYSTEM_ADAPTER_REGISTRY) as TaskSystemId[]) {
      TASK_SYSTEM_ADAPTER_REGISTRY[system].snapshot(context);
    }

    for (const system of Object.keys(ADAPTERS_BY_SYSTEM) as TaskSystemId[]) {
      expect(spies[system]).toHaveBeenCalledTimes(1);
      if (system === "spawn-production") {
        expect(spies[system]).toHaveBeenCalledWith();
      } else {
        expect(spies[system]).toHaveBeenCalledWith(SOURCE_MARKERS[system]);
      }
    }
  });
});

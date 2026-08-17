import {
  LEGACY_X_V1_OUTCOME_GOLDEN,
  defaultMarketDirectContinuousDependencies,
  migrateLegacyDirectToContinuous,
  type MarketDirectContinuousTerminalEnergyContribution,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  LEGACY_X_PROCESSED_EVIDENCE_KEY,
} from "@/runtime/marketDirectContinuousLedger";
import {
  createDirectAutomationState,
  type DirectAutomationState,
} from "@/runtime/marketSaleDirectAutomation";
import {
  clearCarrierTaskBoardForTest,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";
import {
  createCarrierDispatchRef,
  encodeCarrierDispatchStepKey,
} from "@/runtime/dispatchOwnership/ref";

const MIGRATION_TICK = 72_587_210;
const RUN_TICK = MIGRATION_TICK + 2_000;
const LONG_CARRIER_NAMESPACE =
  `factory:long-producer:${"owner->".repeat(32)}`;
const LONG_CARRIER_LOCAL_ID =
  `factory-supply:${"task:".repeat(32)}`;
const LONG_CARRIER_STEP_ID =
  `energy-step:${"step->".repeat(32)}`;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function exactLegacyState(): DirectAutomationState {
  const state = createDirectAutomationState();
  state.directDealOutcomes = [clone(LEGACY_X_V1_OUTCOME_GOLDEN)];
  state.processedDirectTransactionKeys = [
    LEGACY_X_PROCESSED_EVIDENCE_KEY,
  ];
  state.directConfirmedDealCount = 1;
  state.directPausedForReview = true;
  return state;
}











function longCarrierEnergyContribution(
  amount = 5_000,
): MarketDirectContinuousTerminalEnergyContribution {
  const ref = createCarrierDispatchRef(
    LONG_CARRIER_NAMESPACE,
    "E6N59",
    LONG_CARRIER_LOCAL_ID,
  );
  if (!ref) {
    throw new Error("long Carrier ref fixture is invalid");
  }
  const id = encodeCarrierDispatchStepKey(
    ref,
    LONG_CARRIER_STEP_ID,
  );
  if (id.length <= 256) {
    throw new Error("long Carrier key fixture did not cross the legacy limit");
  }
  return {
    id,
    amount,
    kind: "terminal_production_commitment",
  };
}









describe("Continuous Direct automation state and permits", () => {

  it("默认 canonical reader 独立重建 pending send、fee、reservation 与 producer-scoped terminal carriers", () => {
    const previousCfg = Memory.cfg;
    const previousData = Memory.data;
    const previousRuntime = Memory.runtime;
    const mutableGame = Game as unknown as {
      market?: Game["market"];
    };
    const previousMarket = mutableGame.market;
    Game.time = RUN_TICK;
    Memory.cfg = {
      resourceControl: {
        rooms: {
          E6N59: {
            terminalEnergyReserve: 30_000,
            transferBatchSize: 10_000,
          },
        },
      },
    } as unknown as Memory["cfg"];
    Memory.data = {
      resourceControl: {
        taskSchemaVersion: 2,
        tasks: {
          "energy-task": {
            id: "energy-task",
            resource: RESOURCE_ENERGY,
            fromRoomName: "E6N59",
            toRoomName: "E7N59",
            amount: 1_000,
            remainingAmount: 1_000,
            status: "pending",
            createdAt: RUN_TICK,
            updatedAt: RUN_TICK,
            origin: "manual",
            lastProgressAt: RUN_TICK,
          },
        },
      },
    } as unknown as Memory["data"];
    Memory.runtime = {
      resourceReservations: {
        "E6N59:energy:factory": {
          roomName: "E6N59",
          resource: RESOURCE_ENERGY,
          holderId: "factory",
          amount: 5_000,
          updatedAt: RUN_TICK,
          expiresAt: RUN_TICK + 1,
        },
      },
    } as unknown as Memory["runtime"];
    clearCarrierTaskBoardForTest();
    replaceCarrierTasksForProducerRoom("factory:test", "E6N59", [{
      id: "factory-supply",
      type: "factory_supply",
      priority: 1,
      steps: [
        {
          id: "energy-step",
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "factory",
          fromId: "terminal:E6N59",
          toId: "factory:E6N59",
          amount: 2_000,
        },
      ],
    }]);
    replaceCarrierTasksForProducerRoom("factory:z->secondary", "E6N59", [{
      id: "factory-supply",
      type: "factory_supply",
      priority: 1,
      steps: [
        {
          id: "energy-step",
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "factory",
          fromId: "terminal:E6N59",
          toId: "factory:E6N59",
          amount: 3_000,
        },
      ],
    }]);
    replaceCarrierTasksForProducerRoom(LONG_CARRIER_NAMESPACE, "E6N59", [{
      id: LONG_CARRIER_LOCAL_ID,
      type: "factory_supply",
      priority: 1,
      steps: [
        {
          id: LONG_CARRIER_STEP_ID,
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "factory",
          fromId: "terminal:E6N59",
          toId: "factory:E6N59",
          amount: 4_000,
        },
      ],
    }]);
    mutableGame.market = {
      ...(previousMarket || {}),
      calcTransactionCost: jest.fn(() => 500),
    } as Game["market"];

    try {
      expect(
        defaultMarketDirectContinuousDependencies
          .readCanonicalTerminalEnergyContributions(
            "E6N59",
          ),
      ).toEqual([
        longCarrierEnergyContribution(4_000),
        {
          id: "[\"carrier-dispatch-step-v1\",\"carrier-logistics\",\"factory:test\",\"room\",\"E6N59\",\"factory-supply\",\"energy-step\"]",
          amount: 2_000,
          kind: "terminal_production_commitment",
        },
        {
          id: "[\"carrier-dispatch-step-v1\",\"carrier-logistics\",\"factory:z->secondary\",\"room\",\"E6N59\",\"factory-supply\",\"energy-step\"]",
          amount: 3_000,
          kind: "terminal_production_commitment",
        },
        {
          id: "ordinary-terminal-target:E6N59",
          amount: 30_000,
          kind: "ordinary_terminal_target",
        },
        {
          id: "production-reservation:factory",
          amount: 5_000,
          kind: "terminal_production_commitment",
        },
        {
          id: "resource-transfer:energy-task:energy",
          amount: 1_000,
          kind: "pending_energy_send",
        },
        {
          id: "resource-transfer:energy-task:fee",
          amount: 500,
          kind: "pending_internal_send_fee",
        },
      ]);
      const reservation = (
        Memory.runtime!.resourceReservations as Record<
          string,
          { holderId: string }
        >
      )["E6N59:energy:factory"];
      reservation.holderId = `untrusted:${"x".repeat(300)}`;
      expect(
        defaultMarketDirectContinuousDependencies
          .readCanonicalTerminalEnergyContributions(
            "E6N59",
          ),
      ).toBeUndefined();
    } finally {
      Memory.cfg = previousCfg;
      Memory.data = previousData;
      Memory.runtime = previousRuntime;
      clearCarrierTaskBoardForTest();
      mutableGame.market = previousMarket;
    }
  });

  it("legacy 计数越过唯一 canary 时按 rollback evidence lost 永久闭锁", () => {
    const legacy = exactLegacyState();
    legacy.directConfirmedDealCount = 2;

    const blocked = migrateLegacyDirectToContinuous(
      legacy,
      MIGRATION_TICK,
    );

    expect(blocked.migrationStatus).toBe("blocked");
    expect(blocked.migrationBlockedReason).toBe(
      "rollback_evidence_lost",
    );
    expect(blocked.ledger.blocker?.code).toBe(
      "rollback_evidence_lost",
    );
    expect(blocked.ledger.receipts).toEqual([]);
    expect(blocked.lifecycleByEntry).toEqual({});
  });
});

import {
  claimCarrierAmountSlice,
  clearCarrierAmountSlicesForTest,
  releaseUncommittedCarrierAmountSlices,
  type CarrierAmountSliceStepBudget,
} from "@/runtime/dispatchOwnership/carrierAmountSlice";
import {
  createCarrierDispatchRef,
  type CarrierDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

function carrierRef(
  namespace: string,
  localId: string,
  roomName = "W1N1",
): CarrierDispatchRef {
  const ref = createCarrierDispatchRef(namespace, roomName, localId);
  if (!ref) throw new Error("test fixture must be a valid CarrierDispatchRef");
  return ref;
}

function claim(
  taskRef: CarrierDispatchRef,
  taskSteps: readonly CarrierAmountSliceStepBudget[],
  stepId: string,
  claimantId: string,
  requestedAmount: number,
) {
  return claimCarrierAmountSlice({
    taskRef,
    taskSteps,
    stepId,
    claimantId,
    requestedAmount,
  });
}

describe("CarrierAmountSlicePort", () => {
  beforeEach(() => {
    clearCarrierAmountSlicesForTest();
    Game.time = 10_000;
    Game.creeps = {};
  });

  it("does not materialize the ledger for cleanup or malformed claims", () => {
    const validRef = carrierRef("producer", "task");
    const invalidRef = {
      ...validRef,
      scope: { kind: "room", roomName: "not-a-room" },
    } as CarrierDispatchRef;

    releaseUncommittedCarrierAmountSlices(validRef);
    expect(claim(invalidRef, [{ id: "step", amount: 500 }], "step", "c1", 500))
      .toBeNull();
    expect(claim(validRef, [{ id: "other", amount: 500 }], "step", "c1", 500))
      .toBeNull();

    expect(Object.prototype.hasOwnProperty.call(global, "__carrierTaskClaims"))
      .toBe(false);
  });

  it("isolates delimiter-heavy refs and retains the claim-time owned identity", () => {
    const aliasedRef = carrierRef("producer\u0000segment", "task:\"\\");
    const originalRef = carrierRef("producer\u0000segment", "task:\"\\");
    const collidingUnderDelimiterConcat = carrierRef(
      "producer",
      "segment\u0000task:\"\\",
    );
    const stepId = "step:\u0000->\"\\";
    const steps = [{ id: stepId, amount: 500 }];

    const first = claim(aliasedRef, steps, stepId, "carrier-a", 500);
    expect(first?.amount).toBe(500);
    const second = claim(
      collidingUnderDelimiterConcat,
      steps,
      stepId,
      "carrier-b",
      500,
    );
    expect(second?.amount).toBe(500);
    second?.commit();

    const mutableAlias = aliasedRef as unknown as {
      namespace: string;
      localId: string;
      scope: { roomName: string };
    };
    mutableAlias.namespace = "mutated-owner";
    mutableAlias.localId = "mutated-task";
    mutableAlias.scope.roomName = "W9N9";

    releaseUncommittedCarrierAmountSlices(originalRef);
    const replacement = claim(originalRef, steps, stepId, "carrier-c", 500);
    expect(replacement?.amount).toBe(500);
    expect(claim(
      collidingUnderDelimiterConcat,
      steps,
      stepId,
      "carrier-d",
      500,
    )).toBeNull();

    first?.commit();
    first?.release();
    expect(claim(originalRef, steps, stepId, "carrier-e", 500)).toBeNull();
    replacement?.release();
  });

  it("caps the task and each structurally indexed step while allowing one slice per claimant", () => {
    const ref = carrierRef("producer:steps", "task->steps");
    const firstStep = "step:\u0000a";
    const secondStep = "step:\"\\b";
    const steps = [
      { id: firstStep, amount: 600 },
      { id: secondStep, amount: 400 },
    ];

    const first = claim(ref, steps, firstStep, "same-carrier", 800);
    expect(first?.amount).toBe(600);
    expect(claim(ref, steps, secondStep, "same-carrier", 400)).toBeNull();
    expect(claim(ref, steps, firstStep, "other-carrier", 400)).toBeNull();
    const second = claim(ref, steps, secondStep, "third-carrier", 800);
    expect(second?.amount).toBe(400);
  });

  it("releases failed slices, keeps committed slices, and ignores stale handles", () => {
    const ref = carrierRef("producer", "execution-outcome");
    const steps = [{ id: "step", amount: 1_000 }];
    const stale = claim(ref, steps, "step", "reused-carrier", 1_000);
    expect(stale?.amount).toBe(1_000);
    stale?.release();

    const committed = claim(ref, steps, "step", "reused-carrier", 700);
    expect(committed?.amount).toBe(700);
    stale?.commit();
    stale?.release();
    committed?.commit();
    committed?.release();

    expect(claim(ref, steps, "step", "blocked-carrier", 1_000)?.amount)
      .toBe(300);
  });

  it("retains slices across exact refresh and releases only uncommitted work on owner deletion", () => {
    const ref = carrierRef("refresh-owner", "refresh-task");
    const initialSteps = [
      { id: "first", amount: 700 },
      { id: "second", amount: 300 },
    ];
    const uncommitted = claim(ref, initialSteps, "first", "carrier-a", 400);
    const committed = claim(ref, initialSteps, "second", "carrier-b", 300);
    committed?.commit();

    const refreshedRef = carrierRef("refresh-owner", "refresh-task");
    const refreshedSteps = initialSteps.map((step) => ({ ...step }));
    expect(claim(refreshedRef, refreshedSteps, "first", "carrier-c", 700)?.amount)
      .toBe(300);

    releaseUncommittedCarrierAmountSlices(refreshedRef);
    const afterDeletion = claim(
      refreshedRef,
      refreshedSteps,
      "first",
      "carrier-d",
      700,
    );
    expect(afterDeletion?.amount).toBe(700);
    expect(claim(refreshedRef, refreshedSteps, "second", "carrier-e", 300))
      .toBeNull();

    uncommitted?.commit();
    uncommitted?.release();
  });

  it("reclaims a committed slice when its live claimant dies", () => {
    const ref = carrierRef("producer", "dead-claimant");
    const steps = [{ id: "step", amount: 1_000 }];
    Game.creeps["live-carrier"] = { name: "live-carrier" } as Creep;
    const committed = claim(ref, steps, "step", "live-carrier", 1_000);
    committed?.commit();
    expect(claim(ref, steps, "step", "blocked", 1_000)).toBeNull();

    delete Game.creeps["live-carrier"];
    expect(claim(ref, steps, "step", "replacement", 1_000)?.amount)
      .toBe(1_000);
  });

  it("treats prototype-property claimant names only as own creep identities", () => {
    const inheritedRef = carrierRef("producer", "inherited-claimant");
    const protoRef = carrierRef("producer", "proto-claimant");
    const liveThenDeadRef = carrierRef("producer", "own-claimant");
    const steps = [{ id: "step", amount: 1_000 }];

    const inherited = claim(
      inheritedRef,
      steps,
      "step",
      "constructor",
      1_000,
    );
    inherited?.commit();
    Game.creeps = Object.create(null) as Record<string, Creep>;
    expect(claim(inheritedRef, steps, "step", "replacement-a", 1_000))
      .toBeNull();

    Game.creeps = {};
    const inheritedProto = claim(
      protoRef,
      steps,
      "step",
      "__proto__",
      1_000,
    );
    inheritedProto?.commit();
    Game.creeps = Object.create(null) as Record<string, Creep>;
    expect(claim(protoRef, steps, "step", "replacement-proto", 1_000))
      .toBeNull();

    Game.creeps = {};
    Object.defineProperty(Game.creeps, "toString", {
      value: { name: "toString" } as Creep,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const own = claim(
      liveThenDeadRef,
      steps,
      "step",
      "toString",
      1_000,
    );
    own?.commit();
    delete Game.creeps["toString"];
    expect(claim(liveThenDeadRef, steps, "step", "replacement-b", 1_000)?.amount)
      .toBe(1_000);
  });

  it("invalidates old budgets and handles on tick or Game identity changes", () => {
    const ref = carrierRef("producer", "runtime-boundary");
    const steps = [{ id: "step", amount: 1_000 }];
    const staleTick = claim(ref, steps, "step", "old-tick", 1_000);
    Game.time += 1;
    const currentTick = claim(ref, steps, "step", "current-tick", 1_000);
    staleTick?.commit();
    staleTick?.release();
    expect(claim(ref, steps, "step", "tick-blocked", 1_000)).toBeNull();
    currentTick?.release();

    const originalGame = Game;
    try {
      const replacementGame = {
        ...originalGame,
        time: originalGame.time,
        creeps: {},
      } as Game;
      (global as typeof global & { Game: Game }).Game = replacementGame;
      const currentGame = claim(ref, steps, "step", "current-game", 1_000);
      expect(currentGame?.amount).toBe(1_000);
      currentTick?.commit();
      currentTick?.release();
      expect(claim(ref, steps, "step", "game-blocked", 1_000)).toBeNull();
      currentGame?.release();
    } finally {
      (global as typeof global & { Game: Game }).Game = originalGame;
    }
  });
});

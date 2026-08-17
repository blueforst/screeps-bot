import {
  bindCarrierDispatchBinding,
  bindWorkerDispatchBinding,
  clearLegacyCarrierDispatchBinding,
  promoteLegacyCarrierDispatchBinding,
  promoteLegacyWorkerDispatchBinding,
  readCarrierDispatchBinding,
  readWorkerDispatchBinding,
  releaseCarrierDispatchBinding,
  releaseWorkerDispatchBinding,
} from "@/runtime/dispatchOwnership/actorBinding";
import {
  createCarrierDispatchRef,
  createWorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  peekCreepAssignmentState,
  pruneDeadCreepAssignmentState,
} from "@/runtime/creepAssignmentState";

type MutableGlobal = typeof global & {
  __creepAssignmentState?: Record<string, unknown>;
};

const runtimeGlobal = global as MutableGlobal;

describe("local dispatch actor binding", () => {
  beforeEach(() => {
    clearCreepAssignmentStateForTest();
    Game.creeps = {};
  });

  test("binds owned refs, keeps slots independent, and isolates read snapshots", () => {
    const input = createWorkerDispatchRef("W1N1", "build:1")!;
    const carrier = createCarrierDispatchRef("producer:a", "W1N1", "carry:1")!;

    expect(bindWorkerDispatchBinding("Worker1", input)).toBe(true);
    expect(bindCarrierDispatchBinding("Worker1", carrier)).toBe(true);
    expect(Object.getPrototypeOf(runtimeGlobal.__creepAssignmentState)).toBeNull();
    (input as { localId: string }).localId = "mutated";
    (input.scope as { roomName: string }).roomName = "W2N2";

    const stored = readWorkerDispatchBinding("Worker1");
    expect(stored).toEqual(createWorkerDispatchRef("W1N1", "build:1"));
    expect(stored).not.toBe(input);
    expect(stored?.scope).not.toBe(input.scope);
    const snapshot = peekCreepAssignmentState("Worker1")!;
    (snapshot.dispatchBindings!.carrier as { localId: string }).localId = "snapshot-only";
    expect(readCarrierDispatchBinding("Worker1")).toEqual(carrier);
    expect(releaseWorkerDispatchBinding("Worker1", createWorkerDispatchRef("W1N1", "build:1")!))
      .toBe(true);
    expect(readCarrierDispatchBinding("Worker1")).toEqual(carrier);
    expect(ensureCreepAssignmentState("Worker1")).toEqual(expect.objectContaining({
      synthesisCarrierTaskId: "carry:1",
      dispatchBindings: { carrier },
    }));
  });

  test("uses expected-ref CAS and stale releases cannot overwrite newer ownership", () => {
    const refA = createWorkerDispatchRef("W1N1", "A")!;
    const refB = createWorkerDispatchRef("W1N1", "B")!;

    expect(bindWorkerDispatchBinding("Worker1", refA)).toBe(true);
    expect(bindWorkerDispatchBinding("Worker1", refB)).toBe(false);
    expect(bindWorkerDispatchBinding("Worker1", refB, refA)).toBe(true);
    expect(releaseWorkerDispatchBinding("Worker1", refA)).toBe(false);
    ensureCreepAssignmentState("Worker1").taskId = "drift";
    expect(bindWorkerDispatchBinding("Worker1", { ...refB, scope: { ...refB.scope } }, refB))
      .toBe(true);
    expect(readWorkerDispatchBinding("Worker1")).toEqual(refB);
    expect(ensureCreepAssignmentState("Worker1").taskId).toBe("B");
    expect(releaseWorkerDispatchBinding("Worker1", refB)).toBe(true);
    expect(readWorkerDispatchBinding("Worker1")).toBeUndefined();
  });

  test("safe reads neither ensure state nor execute malformed canonical accessors", () => {
    const privateKeysBefore = Reflect.ownKeys(global);
    expect(readWorkerDispatchBinding("Missing")).toBeUndefined();
    expect(runtimeGlobal.__creepAssignmentState).toBeUndefined();
    expect(Reflect.ownKeys(global)).toEqual(privateKeysBefore);

    let getterCalls = 0;
    const state = ensureCreepAssignmentState("Worker1") as unknown as Record<string, unknown>;
    state.taskId = "legacy";
    Object.defineProperty(state, "dispatchBindings", {
      get: () => {
        getterCalls += 1;
        return { worker: createWorkerDispatchRef("W1N1", "legacy") };
      },
      configurable: true,
    });

    expect(readWorkerDispatchBinding("Worker1")).toBeUndefined();
    expect(getterCalls).toBe(0);
    expect(bindWorkerDispatchBinding("Worker1", createWorkerDispatchRef("W1N1", "next")!))
      .toBe(false);
    expect(getterCalls).toBe(0);

    Object.defineProperty(state, "dispatchBindings", {
      value: {
        worker: {
          system: "worker-work",
          namespace: "wrong",
          scope: { kind: "room", roomName: "W1N1" },
          localId: "legacy",
        },
      },
      configurable: true,
      enumerable: true,
      writable: true,
    });
    expect(readWorkerDispatchBinding("Worker1")).toBeUndefined();
  });

  test("promotes legacy mirrors only from exact unique proof and prefers canonical evidence", () => {
    ensureCreepAssignmentState("Worker1").taskId = "shared";
    const wrongRoom = createWorkerDispatchRef("W2N2", "shared")!;
    const exact = createWorkerDispatchRef("W1N1", "shared")!;
    const resolver = jest.fn(() => [wrongRoom, exact]);

    expect(promoteLegacyWorkerDispatchBinding("Worker1", "W1N1", resolver)).toEqual(exact);
    expect(resolver).toHaveBeenCalledWith("W1N1", "shared");
    expect(readWorkerDispatchBinding("Worker1")).toEqual(exact);
    expect(ensureCreepAssignmentState("Worker1").taskId).toBe("shared");

    const state = ensureCreepAssignmentState("CarrierAmbiguous");
    state.synthesisCarrierTaskId = "shared";
    const otherRoom = createCarrierDispatchRef("producer:a", "W2N2", "shared")!;
    expect(promoteLegacyCarrierDispatchBinding("CarrierAmbiguous", "W1N1", () => [otherRoom]))
      .toBeUndefined();
    expect(state.synthesisCarrierTaskId).toBeUndefined();

    state.synthesisCarrierTaskId = "shared";
    const first = createCarrierDispatchRef("producer:a", "W1N1", "shared")!;
    const second = createCarrierDispatchRef("producer:b", "W1N1", "shared")!;
    expect(promoteLegacyCarrierDispatchBinding("CarrierAmbiguous", "W1N1", () => [first, second]))
      .toBeUndefined();
    expect(state.synthesisCarrierTaskId).toBeUndefined();
    const canonical = createCarrierDispatchRef("producer:a", "W1N1", "canonical")!;
    expect(bindCarrierDispatchBinding("CarrierCanonical", canonical)).toBe(true);
    ensureCreepAssignmentState("CarrierCanonical").synthesisCarrierTaskId = "drift";
    const canonicalResolver = jest.fn(() => [
      createCarrierDispatchRef("producer:b", "W1N1", "drift")!,
    ]);

    expect(promoteLegacyCarrierDispatchBinding("CarrierCanonical", "W1N1", canonicalResolver))
      .toEqual(canonical);
    expect(canonicalResolver).not.toHaveBeenCalled();
    expect(ensureCreepAssignmentState("CarrierCanonical").synthesisCarrierTaskId)
      .toBe("canonical");
  });

  test("returns exact canonical evidence without descriptor writes or frozen-mirror churn", () => {
    const canonical = createWorkerDispatchRef("W1N1", "canonical")!;
    const rawState = {
      dispatchBindings: { worker: canonical },
      taskId: canonical.localId,
    };
    const descriptorWrites: PropertyKey[] = [];
    const stateProxy = new Proxy(rawState, {
      defineProperty(target, property, descriptor): boolean {
        descriptorWrites.push(property);
        return Reflect.defineProperty(target, property, descriptor);
      },
      deleteProperty(target, property): boolean {
        descriptorWrites.push(property);
        return Reflect.deleteProperty(target, property);
      },
    });
    const store = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(store, "Worker1", {
      value: stateProxy,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    runtimeGlobal.__creepAssignmentState = store;
    const workerResolver = jest.fn(() => []);

    const promoted = promoteLegacyWorkerDispatchBinding(
      "Worker1",
      "W1N1",
      workerResolver,
    );
    expect(promoted).toEqual(canonical);
    expect(promoted).not.toBe(canonical);
    expect(promoted?.scope).not.toBe(canonical.scope);
    expect(workerResolver).not.toHaveBeenCalled();
    expect(descriptorWrites).toEqual([]);
    expect(rawState.dispatchBindings.worker).toBe(canonical);

    clearCreepAssignmentStateForTest();
    const carrier = createCarrierDispatchRef("producer:a", "W1N1", "canonical")!;
    expect(bindCarrierDispatchBinding("Carrier1", carrier)).toBe(true);
    const state = ensureCreepAssignmentState("Carrier1");
    Object.defineProperty(state, "synthesisCarrierTaskId", {
      value: carrier.localId,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const mirrorDescriptor = Object.getOwnPropertyDescriptor(
      state,
      "synthesisCarrierTaskId",
    );
    const bindings = state.dispatchBindings;
    const carrierResolver = jest.fn(() => []);

    expect(promoteLegacyCarrierDispatchBinding(
      "Carrier1",
      "W1N1",
      carrierResolver,
    )).toEqual(carrier);
    expect(carrierResolver).not.toHaveBeenCalled();
    expect(state.dispatchBindings).toBe(bindings);
    expect(Object.getOwnPropertyDescriptor(state, "synthesisCarrierTaskId"))
      .toEqual(mirrorDescriptor);

    clearCreepAssignmentStateForTest();
    const driftRef = createCarrierDispatchRef("producer:a", "W1N1", "canonical")!;
    expect(bindCarrierDispatchBinding("CarrierDrift", driftRef)).toBe(true);
    const driftState = ensureCreepAssignmentState("CarrierDrift");
    Object.defineProperty(driftState, "synthesisCarrierTaskId", {
      value: "drift",
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const driftBindings = driftState.dispatchBindings;
    const driftDescriptor = Object.getOwnPropertyDescriptor(
      driftState,
      "synthesisCarrierTaskId",
    );
    expect(promoteLegacyCarrierDispatchBinding("CarrierDrift", "W1N1", () => []))
      .toBeUndefined();
    expect(readCarrierDispatchBinding("CarrierDrift")).toEqual(driftRef);
    expect(driftState.dispatchBindings).toBe(driftBindings);
    expect(Object.getOwnPropertyDescriptor(driftState, "synthesisCarrierTaskId"))
      .toEqual(driftDescriptor);
  });

  test("treats prototype-like actor names as own keys across bind, prune, and release", () => {
    for (const actorName of ["__proto__", "constructor", "toString"]) {
      clearCreepAssignmentStateForTest();
      Game.creeps = {};
      const ref = createCarrierDispatchRef("producer", "W1N1", actorName)!;
      expect(bindCarrierDispatchBinding(actorName, ref)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(runtimeGlobal.__creepAssignmentState, actorName))
        .toBe(true);
      expect(readCarrierDispatchBinding(actorName)).toEqual(ref);

      Object.defineProperty(Game.creeps, actorName, {
        value: { name: actorName },
        configurable: true,
        enumerable: true,
        writable: true,
      });
      expect(pruneDeadCreepAssignmentState()).toBe(0);
      delete Game.creeps[actorName];
      expect(pruneDeadCreepAssignmentState()).toBe(1);
      expect(readCarrierDispatchBinding(actorName)).toBeUndefined();

      expect(bindCarrierDispatchBinding(actorName, ref)).toBe(true);
      expect(releaseCarrierDispatchBinding(actorName, ref)).toBe(true);
      expect(readCarrierDispatchBinding(actorName)).toBeUndefined();
    }

    clearCreepAssignmentStateForTest();
    runtimeGlobal.__creepAssignmentState = {};
    const inheritedConstructor = (runtimeGlobal.__creepAssignmentState as Record<string, unknown>).constructor;
    expect(inheritedConstructor).toBe(Object);

    const ref = createWorkerDispatchRef("W1N1", "task")!;
    expect(bindWorkerDispatchBinding("constructor", ref)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(runtimeGlobal.__creepAssignmentState, "constructor"))
      .toBe(true);
    expect(readWorkerDispatchBinding("constructor")).toEqual(ref);
    expect(Object.getPrototypeOf(runtimeGlobal.__creepAssignmentState)).toBe(Object.prototype);
  });

  test("rolls back bind, CAS rebind, and release when mirror synchronization is locked", () => {
    const state = ensureCreepAssignmentState("Worker1");
    Object.defineProperty(state, "taskId", {
      value: "locked",
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const ref = createWorkerDispatchRef("W1N1", "next")!;

    expect(bindWorkerDispatchBinding("Worker1", ref)).toBe(false);
    expect(readWorkerDispatchBinding("Worker1")).toBeUndefined();
    expect(state.taskId).toBe("locked");

    const refA = createWorkerDispatchRef("W1N1", "A")!;
    const refB = createWorkerDispatchRef("W1N1", "B")!;
    expect(bindWorkerDispatchBinding("Worker2", refA)).toBe(true);
    const casState = ensureCreepAssignmentState("Worker2");
    Object.defineProperty(casState, "taskId", {
      value: "A",
      configurable: false,
      enumerable: true,
      writable: false,
    });

    expect(bindWorkerDispatchBinding("Worker2", refB, refA)).toBe(false);
    expect(readWorkerDispatchBinding("Worker2")).toEqual(refA);
    expect(casState.taskId).toBe("A");

    const carrierRef = createCarrierDispatchRef("producer", "W1N1", "task")!;
    expect(bindCarrierDispatchBinding("Carrier1", carrierRef)).toBe(true);
    const carrierState = ensureCreepAssignmentState("Carrier1");
    Object.defineProperty(carrierState, "synthesisCarrierTaskId", {
      value: "task",
      configurable: false,
      enumerable: true,
      writable: false,
    });
    expect(releaseCarrierDispatchBinding("Carrier1", carrierRef)).toBe(false);
    expect(readCarrierDispatchBinding("Carrier1")).toEqual(carrierRef);
    expect(clearLegacyCarrierDispatchBinding("Carrier1")).toBe(false);
  });

  test("successful writes preserve opposite malformed slots without invoking accessors or proxies", () => {
    const state = ensureCreepAssignmentState("Worker1");
    let getterCalls = 0;
    const originalBindings = {} as Record<string, unknown>;
    const carrierGetter = (): unknown => {
      getterCalls += 1;
      return createCarrierDispatchRef("producer", "W1N1", "carrier");
    };
    Object.defineProperty(originalBindings, "carrier", {
      get: carrierGetter,
      configurable: false,
      enumerable: true,
    });
    state.dispatchBindings = originalBindings as NonNullable<typeof state.dispatchBindings>;

    const workerRef = createWorkerDispatchRef("W1N1", "worker")!;
    expect(bindWorkerDispatchBinding("Worker1", workerRef)).toBe(true);
    expect(getterCalls).toBe(0);
    expect(readWorkerDispatchBinding("Worker1")).toEqual(workerRef);
    const carrierDescriptor = Object.getOwnPropertyDescriptor(
      state.dispatchBindings,
      "carrier",
    );
    expect(carrierDescriptor?.get).toBe(carrierGetter);
    expect(carrierDescriptor?.configurable).toBe(false);
    expect(getterCalls).toBe(0);

    expect(releaseWorkerDispatchBinding("Worker1", workerRef)).toBe(true);
    const carrierAfterRelease = Object.getOwnPropertyDescriptor(
      state.dispatchBindings,
      "carrier",
    );
    expect(carrierAfterRelease?.get).toBe(carrierGetter);
    expect(carrierAfterRelease?.configurable).toBe(false);
    expect(getterCalls).toBe(0);

    const proxyState = ensureCreepAssignmentState("Worker2");
    let trapCalls = 0;
    const carrierProxy = new Proxy({}, {
      get: () => {
        trapCalls += 1;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys: () => {
        trapCalls += 1;
        return [];
      },
    });
    const proxyBindings = { carrier: carrierProxy };
    proxyState.dispatchBindings = proxyBindings as unknown as NonNullable<
      typeof proxyState.dispatchBindings
    >;

    const proxyWorkerRef = createWorkerDispatchRef("W1N1", "worker")!;
    expect(bindWorkerDispatchBinding("Worker2", proxyWorkerRef)).toBe(true);
    expect(trapCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(proxyState.dispatchBindings, "carrier")?.value)
      .toBe(carrierProxy);
    expect(trapCalls).toBe(0);
  });

});

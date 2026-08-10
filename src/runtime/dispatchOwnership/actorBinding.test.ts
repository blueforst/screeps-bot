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

  test("binds an owned Worker ref copy and synchronizes its compatibility mirror", () => {
    const input = createWorkerDispatchRef("W1N1", "build:1")!;

    expect(bindWorkerDispatchBinding("Worker1", input)).toBe(true);
    expect(Object.getPrototypeOf(runtimeGlobal.__creepAssignmentState)).toBeNull();
    (input as { localId: string }).localId = "mutated";
    (input.scope as { roomName: string }).roomName = "W2N2";

    const stored = readWorkerDispatchBinding("Worker1");
    expect(stored).toEqual(createWorkerDispatchRef("W1N1", "build:1"));
    expect(stored).not.toBe(input);
    expect(stored?.scope).not.toBe(input.scope);
    expect(ensureCreepAssignmentState("Worker1").taskId).toBe("build:1");
  });

  test("uses expected-ref CAS for rebind and makes a stale release a no-op", () => {
    const refA = createWorkerDispatchRef("W1N1", "A")!;
    const refB = createWorkerDispatchRef("W1N1", "B")!;

    expect(bindWorkerDispatchBinding("Worker1", refA)).toBe(true);
    expect(bindWorkerDispatchBinding("Worker1", refB)).toBe(false);
    expect(bindWorkerDispatchBinding("Worker1", refB, refA)).toBe(true);
    expect(releaseWorkerDispatchBinding("Worker1", refA)).toBe(false);
    expect(readWorkerDispatchBinding("Worker1")).toEqual(refB);
    expect(ensureCreepAssignmentState("Worker1").taskId).toBe("B");
    expect(releaseWorkerDispatchBinding("Worker1", refB)).toBe(true);
    expect(readWorkerDispatchBinding("Worker1")).toBeUndefined();
    expect(ensureCreepAssignmentState("Worker1").taskId).toBeUndefined();
  });

  test("keeps Worker and Carrier slots independent while preserving both mirrors", () => {
    const worker = createWorkerDispatchRef("W1N1", "worker-task")!;
    const carrier = createCarrierDispatchRef("producer:a", "W1N1", "carrier-task")!;

    expect(bindWorkerDispatchBinding("Hybrid", worker)).toBe(true);
    expect(bindCarrierDispatchBinding("Hybrid", carrier)).toBe(true);
    expect(readWorkerDispatchBinding("Hybrid")).toEqual(worker);
    expect(readCarrierDispatchBinding("Hybrid")).toEqual(carrier);
    expect(releaseWorkerDispatchBinding("Hybrid", worker)).toBe(true);
    expect(readCarrierDispatchBinding("Hybrid")).toEqual(carrier);
    expect(ensureCreepAssignmentState("Hybrid")).toEqual(expect.objectContaining({
      synthesisCarrierTaskId: "carrier-task",
      dispatchBindings: { carrier },
    }));
  });

  test("safe reads do not ensure, repair mirror drift, or expose stored aliases", () => {
    const privateKeysBefore = Reflect.ownKeys(global);
    expect(readWorkerDispatchBinding("Missing")).toBeUndefined();
    expect(runtimeGlobal.__creepAssignmentState).toBeUndefined();
    expect(Reflect.ownKeys(global)).toEqual(privateKeysBefore);

    const ref = createWorkerDispatchRef("W1N1", "canonical")!;
    expect(bindWorkerDispatchBinding("Worker1", ref)).toBe(true);
    ensureCreepAssignmentState("Worker1").taskId = "drift";
    const read = readWorkerDispatchBinding("Worker1")!;
    (read as { localId: string }).localId = "snapshot-only";
    (read.scope as { roomName: string }).roomName = "W9N9";

    expect(ensureCreepAssignmentState("Worker1").taskId).toBe("drift");
    expect(readWorkerDispatchBinding("Worker1")).toEqual(ref);
  });

  test("fails closed on malformed canonical scope, namespace, and accessors without executing them", () => {
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

  test("promotes a legacy Worker mirror only from one exact expected-room proof", () => {
    ensureCreepAssignmentState("Worker1").taskId = "shared";
    const wrongRoom = createWorkerDispatchRef("W2N2", "shared")!;
    const exact = createWorkerDispatchRef("W1N1", "shared")!;
    const resolver = jest.fn(() => [wrongRoom, exact]);

    expect(promoteLegacyWorkerDispatchBinding("Worker1", "W1N1", resolver)).toEqual(exact);
    expect(resolver).toHaveBeenCalledWith("W1N1", "shared");
    expect(readWorkerDispatchBinding("Worker1")).toEqual(exact);
    expect(ensureCreepAssignmentState("Worker1").taskId).toBe("shared");
  });

  test("clears a zero- or multi-owner Carrier legacy mirror without guessing another room", () => {
    const state = ensureCreepAssignmentState("Carrier1");
    state.synthesisCarrierTaskId = "shared";
    const otherRoom = createCarrierDispatchRef("producer:a", "W2N2", "shared")!;
    expect(promoteLegacyCarrierDispatchBinding("Carrier1", "W1N1", () => [otherRoom]))
      .toBeUndefined();
    expect(state.synthesisCarrierTaskId).toBeUndefined();

    state.synthesisCarrierTaskId = "shared";
    const first = createCarrierDispatchRef("producer:a", "W1N1", "shared")!;
    const second = createCarrierDispatchRef("producer:b", "W1N1", "shared")!;
    expect(promoteLegacyCarrierDispatchBinding("Carrier1", "W1N1", () => [first, second]))
      .toBeUndefined();
    expect(state.synthesisCarrierTaskId).toBeUndefined();
    expect(readCarrierDispatchBinding("Carrier1")).toBeUndefined();
  });

  test("gives canonical evidence priority and command-side mirror synchronization", () => {
    const canonical = createCarrierDispatchRef("producer:a", "W1N1", "canonical")!;
    expect(bindCarrierDispatchBinding("Carrier1", canonical)).toBe(true);
    ensureCreepAssignmentState("Carrier1").synthesisCarrierTaskId = "drift";
    const resolver = jest.fn(() => [createCarrierDispatchRef("producer:b", "W1N1", "drift")!]);

    expect(promoteLegacyCarrierDispatchBinding("Carrier1", "W1N1", resolver)).toEqual(canonical);
    expect(resolver).not.toHaveBeenCalled();
    expect(ensureCreepAssignmentState("Carrier1").synthesisCarrierTaskId).toBe("canonical");
  });

  test("promotes an exact canonical Worker binding with zero descriptor writes", () => {
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
    const resolver = jest.fn(() => []);

    const promoted = promoteLegacyWorkerDispatchBinding(
      "Worker1",
      "W1N1",
      resolver,
    );
    expect(promoted).toEqual(canonical);
    expect(promoted).not.toBe(canonical);
    expect(promoted?.scope).not.toBe(canonical.scope);
    expect(resolver).not.toHaveBeenCalled();
    expect(descriptorWrites).toEqual([]);
    expect(rawState.dispatchBindings.worker).toBe(canonical);
  });

  test("returns an exact canonical Carrier binding when its correct mirror is frozen", () => {
    const canonical = createCarrierDispatchRef("producer:a", "W1N1", "canonical")!;
    expect(bindCarrierDispatchBinding("Carrier1", canonical)).toBe(true);
    const state = ensureCreepAssignmentState("Carrier1");
    Object.defineProperty(state, "synthesisCarrierTaskId", {
      value: canonical.localId,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const mirrorDescriptor = Object.getOwnPropertyDescriptor(
      state,
      "synthesisCarrierTaskId",
    );
    const bindings = state.dispatchBindings;
    const resolver = jest.fn(() => []);

    expect(promoteLegacyCarrierDispatchBinding(
      "Carrier1",
      "W1N1",
      resolver,
    )).toEqual(canonical);
    expect(resolver).not.toHaveBeenCalled();
    expect(state.dispatchBindings).toBe(bindings);
    expect(Object.getOwnPropertyDescriptor(state, "synthesisCarrierTaskId"))
      .toEqual(mirrorDescriptor);
  });

  test("fails closed without changing canonical evidence when a drifting mirror is frozen", () => {
    const canonical = createCarrierDispatchRef("producer:a", "W1N1", "canonical")!;
    expect(bindCarrierDispatchBinding("Carrier1", canonical)).toBe(true);
    const state = ensureCreepAssignmentState("Carrier1");
    Object.defineProperty(state, "synthesisCarrierTaskId", {
      value: "drift",
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const mirrorDescriptor = Object.getOwnPropertyDescriptor(
      state,
      "synthesisCarrierTaskId",
    );
    const bindings = state.dispatchBindings;

    expect(promoteLegacyCarrierDispatchBinding(
      "Carrier1",
      "W1N1",
      () => [],
    )).toBeUndefined();
    expect(readCarrierDispatchBinding("Carrier1")).toEqual(canonical);
    expect(state.dispatchBindings).toBe(bindings);
    expect(Object.getOwnPropertyDescriptor(state, "synthesisCarrierTaskId"))
      .toEqual(mirrorDescriptor);
  });

  test.each(["__proto__", "constructor", "toString"])(
    "treats actor name %s as an own data key across bind/read/release/prune",
    (actorName) => {
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
    },
  );

  test("handles a legacy ordinary-object store with prototype-like actor keys by own-property semantics", () => {
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

  test("isolates canonical refs in assignment snapshots", () => {
    const ref = createCarrierDispatchRef("producer", "W1N1", "task")!;
    expect(bindCarrierDispatchBinding("Carrier1", ref)).toBe(true);
    const snapshot = peekCreepAssignmentState("Carrier1")!;
    const snapshotRef = snapshot.dispatchBindings?.carrier!;
    (snapshotRef as { localId: string }).localId = "snapshot-only";
    (snapshotRef.scope as { roomName: string }).roomName = "W2N2";

    expect(readCarrierDispatchBinding("Carrier1")).toEqual(ref);
  });

  test("rolls binding writes back when a non-configurable mirror cannot be synchronized", () => {
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
  });

  test("keeps the old binding and mirror when a CAS rebind cannot synchronize its mirror", () => {
    const refA = createWorkerDispatchRef("W1N1", "A")!;
    const refB = createWorkerDispatchRef("W1N1", "B")!;
    expect(bindWorkerDispatchBinding("Worker1", refA)).toBe(true);
    const state = ensureCreepAssignmentState("Worker1");
    Object.defineProperty(state, "taskId", {
      value: "A",
      configurable: false,
      enumerable: true,
      writable: false,
    });

    expect(bindWorkerDispatchBinding("Worker1", refB, refA)).toBe(false);
    expect(readWorkerDispatchBinding("Worker1")).toEqual(refA);
    expect(state.taskId).toBe("A");
  });

  test("identical canonical CAS is a zero-write no-op when its mirror is exact", () => {
    const canonical = createWorkerDispatchRef("W1N1", "sticky")!;
    let oppositeGetterCalls = 0;
    const bindings = { worker: canonical } as Record<string, unknown>;
    const oppositeGetter = (): unknown => {
      oppositeGetterCalls += 1;
      return createCarrierDispatchRef("producer", "W1N1", "carrier");
    };
    Object.defineProperty(bindings, "carrier", {
      get: oppositeGetter,
      configurable: false,
      enumerable: true,
    });
    const rawState = {
      dispatchBindings: bindings,
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

    expect(bindWorkerDispatchBinding(
      "Worker1",
      createWorkerDispatchRef("W1N1", "sticky")!,
      createWorkerDispatchRef("W1N1", "sticky")!,
    )).toBe(true);
    expect(descriptorWrites).toEqual([]);
    expect(rawState.dispatchBindings).toBe(bindings);
    expect(Object.getOwnPropertyDescriptor(bindings, "worker")?.value).toBe(canonical);
    const oppositeDescriptor = Object.getOwnPropertyDescriptor(bindings, "carrier");
    expect(oppositeDescriptor?.get).toBe(oppositeGetter);
    expect(oppositeGetterCalls).toBe(0);
  });

  test("identical canonical CAS repairs only a drifting mirror", () => {
    const canonical = createWorkerDispatchRef("W1N1", "sticky")!;
    expect(bindWorkerDispatchBinding("Worker1", canonical)).toBe(true);
    const state = ensureCreepAssignmentState("Worker1");
    const originalBindings = state.dispatchBindings;
    state.taskId = "drift";

    expect(bindWorkerDispatchBinding(
      "Worker1",
      createWorkerDispatchRef("W1N1", "sticky")!,
      createWorkerDispatchRef("W1N1", "sticky")!,
    )).toBe(true);
    expect(state.dispatchBindings).toBe(originalBindings);
    expect(state.taskId).toBe("sticky");
  });

  test("restores the exact dispatchBindings value when bind mirror synchronization fails", () => {
    const state = ensureCreepAssignmentState("Worker1");
    const malformedCarrier = { system: "carrier-logistics", namespace: 42 };
    const originalBindings = { carrier: malformedCarrier };
    state.dispatchBindings = originalBindings as unknown as NonNullable<
      typeof state.dispatchBindings
    >;
    Object.defineProperty(state, "taskId", {
      value: "locked",
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const originalBindingsDescriptor = Object.getOwnPropertyDescriptor(
      state,
      "dispatchBindings",
    );
    const originalMirrorDescriptor = Object.getOwnPropertyDescriptor(state, "taskId");

    expect(bindWorkerDispatchBinding(
      "Worker1",
      createWorkerDispatchRef("W1N1", "next")!,
    )).toBe(false);
    expect(state.dispatchBindings).toBe(originalBindings);
    expect(Object.getOwnPropertyDescriptor(state.dispatchBindings, "carrier")?.value)
      .toBe(malformedCarrier);
    expect(Object.getOwnPropertyDescriptor(state, "dispatchBindings"))
      .toEqual(originalBindingsDescriptor);
    expect(Object.getOwnPropertyDescriptor(state, "taskId"))
      .toEqual(originalMirrorDescriptor);
    expect(state.taskId).toBe("locked");
  });

  test("restores the exact dispatchBindings value when release mirror deletion fails", () => {
    const ref = createWorkerDispatchRef("W1N1", "task")!;
    expect(bindWorkerDispatchBinding("Worker1", ref)).toBe(true);
    const state = ensureCreepAssignmentState("Worker1");
    const malformedCarrier = { system: "carrier-logistics", namespace: 42 };
    const originalBindings = {
      worker: state.dispatchBindings?.worker,
      carrier: malformedCarrier,
    };
    state.dispatchBindings = originalBindings as unknown as NonNullable<
      typeof state.dispatchBindings
    >;
    Object.defineProperty(state, "taskId", {
      value: "task",
      configurable: false,
      enumerable: true,
      writable: false,
    });
    const originalBindingsDescriptor = Object.getOwnPropertyDescriptor(
      state,
      "dispatchBindings",
    );
    const originalMirrorDescriptor = Object.getOwnPropertyDescriptor(state, "taskId");

    expect(releaseWorkerDispatchBinding("Worker1", ref)).toBe(false);
    expect(state.dispatchBindings).toBe(originalBindings);
    expect(state.dispatchBindings?.worker).toEqual(ref);
    expect(Object.getOwnPropertyDescriptor(state.dispatchBindings, "carrier")?.value)
      .toBe(malformedCarrier);
    expect(Object.getOwnPropertyDescriptor(state, "dispatchBindings"))
      .toEqual(originalBindingsDescriptor);
    expect(Object.getOwnPropertyDescriptor(state, "taskId"))
      .toEqual(originalMirrorDescriptor);
    expect(state.taskId).toBe("task");
  });

  test("successful binding preserves an opposite malformed accessor without executing it", () => {
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
  });

  test("successful binding preserves an opposite Proxy value without touching its traps", () => {
    const state = ensureCreepAssignmentState("Worker1");
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
    const originalBindings = { carrier: carrierProxy };
    state.dispatchBindings = originalBindings as unknown as NonNullable<
      typeof state.dispatchBindings
    >;

    const workerRef = createWorkerDispatchRef("W1N1", "worker")!;
    expect(bindWorkerDispatchBinding("Worker1", workerRef)).toBe(true);
    expect(trapCalls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(state.dispatchBindings, "carrier")?.value)
      .toBe(carrierProxy);
    expect(trapCalls).toBe(0);
  });

  test("rolls release back when a non-configurable mirror cannot be cleared", () => {
    const ref = createCarrierDispatchRef("producer", "W1N1", "task")!;
    expect(bindCarrierDispatchBinding("Carrier1", ref)).toBe(true);
    const state = ensureCreepAssignmentState("Carrier1");
    Object.defineProperty(state, "synthesisCarrierTaskId", {
      value: "task",
      configurable: false,
      enumerable: true,
      writable: false,
    });

    expect(releaseCarrierDispatchBinding("Carrier1", ref)).toBe(false);
    expect(readCarrierDispatchBinding("Carrier1")).toEqual(ref);
    expect(state.synthesisCarrierTaskId).toBe("task");
    expect(clearLegacyCarrierDispatchBinding("Carrier1")).toBe(false);
  });
});

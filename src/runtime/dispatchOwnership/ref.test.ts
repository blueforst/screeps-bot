import { TASK_SYSTEM_CATALOG } from "@/runtime/taskSystem/catalog";
import type { WorkRef } from "@/runtime/taskSystem/model";
import {
  cloneCarrierDispatchRef,
  cloneWorkerDispatchRef,
  compareDispatchRefs,
  createCarrierDispatchRef,
  createWorkerDispatchRef,
  encodeCarrierDispatchStepKey,
  equalDispatchRefs,
  isCarrierDispatchRef,
  isCarrierDispatchStepKey,
  isValidDispatchRoomName,
  isWorkerDispatchRef,
  type CarrierDispatchRef,
  type WorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

const workerAssignableToWorkRef: WorkRef = createWorkerDispatchRef("W1N1", "build:1")!;
const carrierAssignableToWorkRef: WorkRef = createCarrierDispatchRef(
  "resourceControl",
  "W1N1",
  "transfer:1",
)!;
void workerAssignableToWorkRef;
void carrierAssignableToWorkRef;

function dataRecord(values: Record<string, unknown>): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return record;
}

describe("local dispatch structured refs", () => {
  test("uses the catalog-canonical system and namespace literals", () => {
    const worker = createWorkerDispatchRef("W1N1", "build:1");
    const carrier = createCarrierDispatchRef("producer:a", "W1N1", "haul:1");

    expect(worker).toEqual({
      system: "worker-work",
      namespace: TASK_SYSTEM_CATALOG["worker-work"].domainOwner,
      scope: { kind: "room", roomName: "W1N1" },
      localId: "build:1",
    });
    expect(carrier?.system).toBe("carrier-logistics");
    expect(TASK_SYSTEM_CATALOG["carrier-logistics"].domainOwner).toBe("carrierTaskBoard");
  });

  test("accepts Screeps room names and rejects empty and prototype-like outer scopes", () => {
    expect(["W0N0", "E12S34", "sim"].every(isValidDispatchRoomName)).toBe(true);
    expect(["", "W1", "__proto__", "constructor", "toString", "W-1N1"]
      .some(isValidDispatchRoomName)).toBe(false);
    expect(createWorkerDispatchRef("constructor", "task")).toBeUndefined();
    expect(createCarrierDispatchRef("producer", "__proto__", "task")).toBeUndefined();
    expect(createCarrierDispatchRef("", "W1N1", "task")).toBeUndefined();
  });

  test("treats producer and local ids with prototype names or delimiters as ordinary data", () => {
    const carrier = createCarrierDispatchRef("__proto__", "W1N1", "constructor:->\0\\\"");
    const worker = createWorkerDispatchRef("W1N1", "toString");

    expect(isCarrierDispatchRef(carrier)).toBe(true);
    expect(isWorkerDispatchRef(worker)).toBe(true);
    expect(carrier?.namespace).toBe("__proto__");
    expect(worker?.localId).toBe("toString");
  });

  test("requires own data fields and never executes accessors", () => {
    let getterCalls = 0;
    const inherited = Object.create({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "task",
    }) as Record<string, unknown>;
    const accessor = dataRecord({
      namespace: "workerTaskPool",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "task",
    });
    Object.defineProperty(accessor, "system", {
      get: () => {
        getterCalls += 1;
        return "worker-work";
      },
      enumerable: true,
    });
    const scopeAccessor = dataRecord({ kind: "room" });
    Object.defineProperty(scopeAccessor, "roomName", {
      get: () => {
        getterCalls += 1;
        return "W1N1";
      },
      enumerable: true,
    });
    const nestedAccessor = dataRecord({
      system: "worker-work",
      namespace: "workerTaskPool",
      scope: scopeAccessor,
      localId: "task",
    });

    expect(isWorkerDispatchRef(inherited)).toBe(false);
    expect(isWorkerDispatchRef(accessor)).toBe(false);
    expect(isWorkerDispatchRef(nestedAccessor)).toBe(false);
    expect(getterCalls).toBe(0);
  });

  test("fails closed on malformed scope, namespace, and system combinations", () => {
    expect(isWorkerDispatchRef({
      system: "worker-work",
      namespace: "other",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "task",
    })).toBe(false);
    expect(isCarrierDispatchRef({
      system: "carrier-logistics",
      namespace: "producer",
      scope: { kind: "actor", roomName: "W1N1" },
      localId: "task",
    })).toBe(false);
    expect(isCarrierDispatchRef({
      system: "carrier-logistics",
      namespace: "producer",
      scope: { kind: "room", roomName: "constructor" },
      localId: "task",
    })).toBe(false);
  });

  test("clones nested scope and compares structured fields without mutating inputs", () => {
    const raw = {
      system: "carrier-logistics",
      namespace: "producer:a->b",
      scope: { kind: "room", roomName: "W1N1" },
      localId: "task:a->b",
    } as CarrierDispatchRef;
    const clone = cloneCarrierDispatchRef(raw)!;
    (raw as { namespace: string }).namespace = "mutated";
    (raw.scope as { roomName: string }).roomName = "W2N2";

    expect(clone).toEqual(createCarrierDispatchRef("producer:a->b", "W1N1", "task:a->b"));
    expect(clone).not.toBe(raw);
    expect(clone.scope).not.toBe(raw.scope);
    expect(equalDispatchRefs(clone, createCarrierDispatchRef("producer:a->b", "W1N1", "task:a->b"))).toBe(true);
    expect(equalDispatchRefs(clone, createCarrierDispatchRef("producer:a", "W1N1", "b->task:a->b"))).toBe(false);
    expect(cloneWorkerDispatchRef(createWorkerDispatchRef("W1N1", "task"))).toEqual(
      createWorkerDispatchRef("W1N1", "task"),
    );
  });

  test("provides a deterministic structured comparator", () => {
    const refs = [
      createWorkerDispatchRef("W2N2", "z")!,
      createCarrierDispatchRef("producer:b", "W1N1", "a")!,
      createCarrierDispatchRef("producer:a", "W1N1", "z")!,
      createCarrierDispatchRef("producer:a", "W1N1", "a")!,
    ];
    const before = refs.slice();

    expect(refs.slice().sort(compareDispatchRefs)).toEqual([
      createCarrierDispatchRef("producer:a", "W1N1", "a"),
      createCarrierDispatchRef("producer:a", "W1N1", "z"),
      createCarrierDispatchRef("producer:b", "W1N1", "a"),
      createWorkerDispatchRef("W2N2", "z"),
    ]);
    expect(refs).toEqual(before);
  });

  test("encodes full Carrier ref and step as an injective opaque tuple", () => {
    const first = createCarrierDispatchRef("a:b", "W1N1", "c->d")!;
    const second = createCarrierDispatchRef("a", "W1N1", "b:c->d")!;
    const firstKey = encodeCarrierDispatchStepKey(first, "step:\0\\\"");
    const secondKey = encodeCarrierDispatchStepKey(second, "step:\0\\\"");

    expect(firstKey).not.toBe(secondKey);
    expect(JSON.parse(firstKey)).toEqual([
      "carrier-dispatch-step-v1",
      "carrier-logistics",
      "a:b",
      "room",
      "W1N1",
      "c->d",
      "step:\0\\\"",
    ]);
    expect(() => encodeCarrierDispatchStepKey(first, "")).toThrow(TypeError);
  });

  test("validates canonical Carrier step keys without exposing parsed identity", () => {
    const ref = createCarrierDispatchRef(
      "__proto__:producer->\0\\\"",
      "W12S34",
      "constructor:task->\0\\\"",
    )!;
    const key = encodeCarrierDispatchStepKey(ref, "toString:step->\0\\\"");

    expect(isCarrierDispatchStepKey(key)).toBe(true);
    expect(isCarrierDispatchStepKey(new String(key))).toBe(false);
    expect(isCarrierDispatchStepKey(undefined)).toBe(false);
  });

  test("accepts long canonical keys and rejects forged or non-canonical tuples", () => {
    const longNamespace = `producer:${["a->", "\\", "\"", "\0"].join("").repeat(6_000)}`;
    const longLocalId = `task:${["b:", "\\", "\0", "->", "\""].join("").repeat(6_000)}`;
    const longStepId = `step:${["c->:", "\\", "\"", "\0"].join("").repeat(6_000)}`;
    const ref = createCarrierDispatchRef(longNamespace, "E99N1", longLocalId)!;
    const longKey = encodeCarrierDispatchStepKey(ref, longStepId);
    expect(longKey.length).toBeGreaterThan(100_000);
    expect(isCarrierDispatchStepKey(longKey)).toBe(true);

    const validTuple = JSON.parse(longKey) as unknown[];
    const variants: unknown[] = [
      "not-json",
      JSON.stringify({ tuple: validTuple }),
      JSON.stringify(validTuple.slice(0, 6)),
      JSON.stringify([...validTuple, "extra"]),
      JSON.stringify(["wrong-tag", ...validTuple.slice(1)]),
      JSON.stringify([validTuple[0], "worker-work", ...validTuple.slice(2)]),
      JSON.stringify([...validTuple.slice(0, 3), "actor", ...validTuple.slice(4)]),
      JSON.stringify([...validTuple.slice(0, 4), "constructor", ...validTuple.slice(5)]),
      JSON.stringify([...validTuple.slice(0, 2), "", ...validTuple.slice(3)]),
      JSON.stringify([...validTuple.slice(0, 5), "", validTuple[6]]),
      JSON.stringify([...validTuple.slice(0, 6), ""]),
      ` ${longKey}`,
      longKey.replace("producer", "\\u0070roducer"),
    ];
    for (const variant of variants) {
      expect(isCarrierDispatchStepKey(variant)).toBe(false);
    }
  });
});

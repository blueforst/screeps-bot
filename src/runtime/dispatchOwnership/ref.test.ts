import { TASK_SYSTEM_CATALOG } from "@/runtime/taskSystem/catalog";
import type { WorkRef } from "@/runtime/taskSystem/model";
import {
  createCarrierDispatchRef,
  createWorkerDispatchRef,
  isValidDispatchRoomName,
} from "@/runtime/dispatchOwnership/ref";

const workerAssignableToWorkRef: WorkRef = createWorkerDispatchRef("W1N1", "build:1")!;
const carrierAssignableToWorkRef: WorkRef = createCarrierDispatchRef(
  "resourceControl",
  "W1N1",
  "transfer:1",
)!;
void workerAssignableToWorkRef;
void carrierAssignableToWorkRef;


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
});

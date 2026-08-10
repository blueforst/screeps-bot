import {
  claimCarrierTaskStepAmount,
  clearCarrierTaskBoardForTest,
  findCarrierTaskByRef,
  getMutableCarrierTaskByRefForTest,
  listCarrierDispatchEntriesByRoom,
  listCarrierTasksByRoom,
  peekCarrierTaskBoard,
  replaceCarrierTasksForProducerRoom,
  type CarrierDispatchEntry,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest } from "@/runtime/creepAssignmentState";
import {
  createWorkerDispatchRef,
  type CarrierDispatchRef,
  type WorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";
import { workerSlotClaimPort } from "@/runtime/dispatchOwnership/workerSlot";
import {
  assignWorkerTask,
  clearWorkerTaskBoardForTest,
  getWorkerTasksByRoom,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import type { WorkerTask } from "@/types/system";

/**
 * Non-production local-dispatch performance characterization.
 *
 * Wall-clock samples are observations only: the old and current values came
 * from separate Jest processes, so their ratio is not a deployment gate.
 * Pass/fail complexity evidence comes from explicit calls and proxies around
 * public inputs/read DTOs. Carrier's private Map hierarchy is never inspected,
 * proxied, or exposed by this test.
 */

const ROOM_COUNT = 20;
const TASKS_PER_ROOM = 20;
const ACTOR_COUNT = 50;
const WARMUP_BATCHES = 5;
const MEASURED_BATCHES = 30;
const ITERATIONS_PER_BATCH = 100;

const PRE_CHANGE_OBSERVATION = {
  workerCurrent: { median: 12.083, p95: 12.378 },
  workerRelease: { median: 39.879, p95: 40.633 },
  carrierList: { median: 13.476, p95: 14.086 },
  carrierClaim: { median: 12.937, p95: 13.586 },
  carrierReplace: { median: 61.892, p95: 66.713 },
} as const;

interface BatchDistribution {
  readonly samples: number[];
  readonly median: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

interface ScenarioObservation extends BatchDistribution {
  readonly relativeToPreChange: {
    readonly median: number;
    readonly p95: number;
  };
}

type RuntimeGlobal = typeof global & {
  __workerTaskBoard?: Record<string, Record<string, WorkerTask>>;
  __runtimeServices?: unknown;
};

interface WorkerFixture {
  readonly actors: Creep[];
  readonly actorRefs: WorkerDispatchRef[];
  readonly actorTasks: WorkerTask[];
  readonly roomNames: string[];
}

interface CarrierFixture {
  readonly draftsByRoom: ReadonlyMap<string, readonly CarrierTaskDraft[]>;
  readonly producerByRoom: ReadonlyMap<string, string>;
  readonly roomNames: string[];
}

interface WorkerBoardProbeCounts {
  exactRoomDescriptorReads: number;
  exactTaskDescriptorReads: number;
  boardEnumerations: number;
}

interface CarrierInputProbeCounts {
  actorDescriptorReads: number;
  actorEnumerations: number;
  draftIndexReads: number;
  stepIndexReads: number;
  refDescriptorReads: number;
  stepArrayEnumerations: number;
  stepEntryDescriptorReads: number;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank percentile: rank = ceil(p * N), using one-based rank. */
function nearestRankP95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function characterizeCurrent(
  expectedResultUnits: number,
  preChange: { readonly median: number; readonly p95: number },
  runIteration: () => number,
): ScenarioObservation {
  const runBatch = (): { readonly elapsedMs: number; readonly resultUnits: number } => {
    let resultUnits = 0;
    const startedAt = process.hrtime.bigint();
    for (let iteration = 0; iteration < ITERATIONS_PER_BATCH; iteration += 1) {
      resultUnits += runIteration();
    }
    return {
      elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      resultUnits,
    };
  };

  for (let warmup = 0; warmup < WARMUP_BATCHES; warmup += 1) {
    expect(runBatch().resultUnits).toBe(expectedResultUnits);
  }

  const samples: number[] = [];
  for (let batch = 0; batch < MEASURED_BATCHES; batch += 1) {
    const result = runBatch();
    expect(result.resultUnits).toBe(expectedResultUnits);
    samples.push(round(result.elapsedMs));
  }

  const currentMedian = round(median(samples));
  const currentP95 = round(nearestRankP95(samples));
  return {
    samples,
    median: currentMedian,
    p95: currentP95,
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    relativeToPreChange: {
      median: round(currentMedian / preChange.median),
      p95: round(currentP95 / preChange.p95),
    },
  };
}

function createRoomNames(): string[] {
  return Array.from({ length: ROOM_COUNT }, (_unused, index) => `W${index + 1}N1`);
}

function makeWorkerTask(roomName: string, taskIndex: number): WorkerTask {
  return {
    id: `worker:${roomName}:task:${taskIndex}`,
    type: "upgrade",
    targetId: `worker:${roomName}:target:${taskIndex}`,
    roomName,
    priority: 300,
    assignedCreeps: [],
    maxAssignees: ACTOR_COUNT,
    status: "active",
    updatedAt: Game.time,
  };
}

function makeActor(name: string, roomName: string): Creep {
  return {
    name,
    memory: {},
    room: { name: roomName },
    pos: {
      x: 24,
      y: 25,
      roomName,
      getRangeTo: () => 1,
    },
  } as unknown as Creep;
}

function installWorkerFixture(targets: Record<string, RoomObject>): WorkerFixture {
  clearCreepAssignmentStateForTest();
  clearWorkerTaskBoardForTest();
  Game.creeps = {};
  const roomNames = createRoomNames();
  const tasksByRoom = new Map<string, WorkerTask[]>();

  for (const roomName of roomNames) {
    const tasks: WorkerTask[] = [];
    const store = getWorkerTasksByRoom(roomName);
    for (let taskIndex = 0; taskIndex < TASKS_PER_ROOM; taskIndex += 1) {
      const task = makeWorkerTask(roomName, taskIndex);
      store[task.id] = task;
      tasks.push(task);
      targets[task.targetId] = {
        id: task.targetId,
        my: true,
        level: 3,
        pos: { x: 25, y: 25, roomName },
      } as unknown as StructureController;
    }
    tasksByRoom.set(roomName, tasks);
  }

  const actors: Creep[] = [];
  const actorTasks: WorkerTask[] = [];
  const actorRefs: WorkerDispatchRef[] = [];
  for (let actorIndex = 0; actorIndex < ACTOR_COUNT; actorIndex += 1) {
    const roomName = roomNames[actorIndex % ROOM_COUNT];
    const task = tasksByRoom.get(roomName)![Math.floor(actorIndex / ROOM_COUNT)];
    const actor = makeActor(`baseline-worker-${actorIndex}`, roomName);
    const ref = createWorkerDispatchRef(roomName, task.id);
    if (!ref) throw new Error("expected a valid WorkerDispatchRef");
    actors.push(actor);
    actorTasks.push(task);
    actorRefs.push(ref);
    Game.creeps[actor.name] = actor;
    expect(workerSlotClaimPort.acquire(actor.name, ref, task)).toBe(true);
  }
  return { actors, actorRefs, actorTasks, roomNames };
}

function makeCarrierDraft(roomName: string, taskIndex: number): CarrierTaskDraft {
  return {
    id: `carrier:${roomName}:task:${taskIndex}`,
    type: "terminal_feed",
    priority: TASKS_PER_ROOM - taskIndex,
    steps: [{
      id: `carrier:${roomName}:step:${taskIndex}`,
      resource: RESOURCE_ENERGY,
      fromKind: "storage",
      toKind: "terminal",
      fromId: `carrier:${roomName}:from:${taskIndex}`,
      toId: `carrier:${roomName}:to:${taskIndex}`,
      amount: ACTOR_COUNT * 10,
    }],
  };
}

function installCarrierFixture(): CarrierFixture {
  clearCarrierTaskBoardForTest();
  const roomNames = createRoomNames();
  const draftsByRoom = new Map<string, readonly CarrierTaskDraft[]>();
  const producerByRoom = new Map<string, string>();
  for (const roomName of roomNames) {
    const producer = `baseline-producer:${roomName}`;
    const drafts = Array.from(
      { length: TASKS_PER_ROOM },
      (_unused, taskIndex) => makeCarrierDraft(roomName, taskIndex),
    );
    draftsByRoom.set(roomName, drafts);
    producerByRoom.set(roomName, producer);
    replaceCarrierTasksForProducerRoom(producer, roomName, drafts);
  }
  return { draftsByRoom, producerByRoom, roomNames };
}

function listCarrierEntries(fixture: CarrierFixture): CarrierDispatchEntry[] {
  return fixture.roomNames.flatMap(
    (roomName) => [...listCarrierDispatchEntriesByRoom(roomName)],
  );
}

function instrumentWorkerExactBoard(
  roomNames: readonly string[],
  counts: WorkerBoardProbeCounts,
): () => void {
  const runtimeGlobal = global as RuntimeGlobal;
  const board = runtimeGlobal.__workerTaskBoard;
  if (!board) throw new Error("expected Worker board");
  const originals = new Map<string, Record<string, WorkerTask>>();

  for (const roomName of roomNames) {
    const original = board[roomName];
    originals.set(roomName, original);
    board[roomName] = new Proxy(original, {
      getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
        if (typeof property === "string" && property.startsWith("worker:")) {
          counts.exactTaskDescriptorReads += 1;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
  }
  runtimeGlobal.__workerTaskBoard = new Proxy(board, {
    getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
      if (typeof property === "string" && originals.has(property)) {
        counts.exactRoomDescriptorReads += 1;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    ownKeys(target): ArrayLike<string | symbol> {
      counts.boardEnumerations += 1;
      return Reflect.ownKeys(target);
    },
  });

  return (): void => {
    runtimeGlobal.__workerTaskBoard = board;
    for (const [roomName, original] of originals) board[roomName] = original;
  };
}

function probeWorkerReleaseComplexity(fixture: WorkerFixture): Record<string, number> {
  const counts: WorkerBoardProbeCounts = {
    exactRoomDescriptorReads: 0,
    exactTaskDescriptorReads: 0,
    boardEnumerations: 0,
  };
  const restore = instrumentWorkerExactBoard(fixture.roomNames, counts);
  let acquireCalls = 0;
  let releaseCalls = 0;
  for (let iteration = 0; iteration < ITERATIONS_PER_BATCH; iteration += 1) {
    for (let actorIndex = 0; actorIndex < ACTOR_COUNT; actorIndex += 1) {
      const actor = fixture.actors[actorIndex];
      acquireCalls += 1;
      expect(workerSlotClaimPort.acquire(
        actor.name,
        fixture.actorRefs[actorIndex],
        fixture.actorTasks[actorIndex],
      )).toBe(true);
      releaseCalls += 1;
      releaseWorkerTask(actor);
    }
  }
  restore();
  expect(counts).toEqual({
    exactRoomDescriptorReads: ACTOR_COUNT * ITERATIONS_PER_BATCH,
    exactTaskDescriptorReads: ACTOR_COUNT * ITERATIONS_PER_BATCH,
    boardEnumerations: 0,
  });
  return { acquireCalls, releaseCalls, ...counts };
}

function probeWorkerAcquireReconcileComplexity(
  actors: readonly Creep[],
): Record<string, number> {
  clearCreepAssignmentStateForTest();
  let assignedCreepsDescriptorReads = 0;
  let acquireCalls = 0;
  let reconcileCalls = 0;
  for (let actorIndex = 0; actorIndex < actors.length; actorIndex += 1) {
    const roomName = actors[actorIndex].room.name;
    const source = makeWorkerTask(roomName, TASKS_PER_ROOM + actorIndex);
    const task = new Proxy(source, {
      getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
        if (property === "assignedCreeps") assignedCreepsDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const ref = createWorkerDispatchRef(roomName, task.id)!;
    acquireCalls += 1;
    expect(workerSlotClaimPort.acquire(actors[actorIndex].name, ref, task)).toBe(true);
    reconcileCalls += 1;
    expect(workerSlotClaimPort.reconcile(actors[actorIndex].name, ref, task)).toBe(true);
  }
  expect(assignedCreepsDescriptorReads).toBe(ACTOR_COUNT * 3);
  return { acquireCalls, reconcileCalls, assignedCreepsDescriptorReads };
}

function emptyCarrierCounts(): CarrierInputProbeCounts {
  return {
    actorDescriptorReads: 0,
    actorEnumerations: 0,
    draftIndexReads: 0,
    stepIndexReads: 0,
    refDescriptorReads: 0,
    stepArrayEnumerations: 0,
    stepEntryDescriptorReads: 0,
  };
}

function wrapCarrierRefForProbe(
  ref: CarrierDispatchRef,
  counts: CarrierInputProbeCounts,
): CarrierDispatchRef {
  const scope = new Proxy(ref.scope, {
    getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
      if (property === "kind" || property === "roomName") counts.refDescriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  return new Proxy({ ...ref, scope }, {
    getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
      if (
        property === "system"
        || property === "namespace"
        || property === "scope"
        || property === "localId"
      ) {
        counts.refDescriptorReads += 1;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

function instrumentCarrierActors(counts: CarrierInputProbeCounts): () => void {
  const original = Game.creeps;
  Game.creeps = new Proxy(original, {
    getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
      if (typeof property === "string") counts.actorDescriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    ownKeys(target): ArrayLike<string | symbol> {
      counts.actorEnumerations += 1;
      return Reflect.ownKeys(target);
    },
  });
  return (): void => {
    Game.creeps = original;
  };
}

function probeCarrierComplexity(
  fixture: CarrierFixture,
  actors: readonly Creep[],
): Record<string, unknown> {
  const counts = emptyCarrierCounts();
  const restoreActors = instrumentCarrierActors(counts);

  const exactEntries = listCarrierEntries(fixture);
  let exactCalls = 0;
  let exactResults = 0;
  for (const entry of exactEntries) {
    exactCalls += 1;
    if (findCarrierTaskByRef(wrapCarrierRefForProbe(entry.ref, counts))) {
      exactResults += 1;
    }
  }
  expect(exactCalls).toBe(ROOM_COUNT * TASKS_PER_ROOM);
  expect(exactResults).toBe(exactCalls);
  expect(counts.refDescriptorReads).toBe(exactCalls * 6);
  expect(counts.actorDescriptorReads).toBe(0);

  let listCalls = 0;
  let listResults = 0;
  for (const roomName of fixture.roomNames) {
    listCalls += 1;
    listResults += listCarrierTasksByRoom(roomName).length;
  }
  expect(listCalls).toBe(ROOM_COUNT);
  expect(listResults).toBe(ROOM_COUNT * TASKS_PER_ROOM);
  expect(counts.actorDescriptorReads).toBe(0);

  let replaceCalls = 0;
  let replaceResults = 0;
  for (let iteration = 0; iteration < ITERATIONS_PER_BATCH; iteration += 1) {
    for (const roomName of fixture.roomNames) {
      const proxiedDrafts = fixture.draftsByRoom.get(roomName)!.map((draft) => ({
        ...draft,
        steps: new Proxy([...draft.steps], {
          get(target, property, receiver): unknown {
            if (typeof property === "string" && /^\d+$/.test(property)) {
              counts.stepIndexReads += 1;
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      }));
      const drafts = new Proxy(proxiedDrafts, {
        get(target, property, receiver): unknown {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            counts.draftIndexReads += 1;
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      replaceCalls += 1;
      replaceCarrierTasksForProducerRoom(
        fixture.producerByRoom.get(roomName)!,
        roomName,
        drafts,
      );
      replaceResults += drafts.length;
    }
  }
  expect(replaceCalls).toBe(ROOM_COUNT * ITERATIONS_PER_BATCH);
  expect(replaceResults).toBe(ROOM_COUNT * TASKS_PER_ROOM * ITERATIONS_PER_BATCH);
  expect(counts.draftIndexReads).toBe(replaceResults);
  expect(counts.stepIndexReads).toBe(replaceResults);
  expect(counts.actorDescriptorReads).toBe(0);

  const refreshedEntries = listCarrierEntries(fixture);
  const claimTasks = refreshedEntries.slice(0, ACTOR_COUNT).map((entry) => {
    const mutable = getMutableCarrierTaskByRefForTest(entry.ref);
    if (!mutable) throw new Error("expected mutable test task");
    const originalSteps = mutable.steps;
    const step = originalSteps[0];
    mutable.steps = new Proxy(originalSteps, {
      get(target, property, receiver): unknown {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          counts.stepIndexReads += 1;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return { mutable, originalSteps, step };
  });
  const stepReadsBeforeClaims = counts.stepIndexReads;
  let claimCalls = 0;
  let successfulClaims = 0;
  let releasedClaims = 0;
  for (let iteration = 0; iteration < ITERATIONS_PER_BATCH; iteration += 1) {
    Game.time += 1;
    for (let actorIndex = 0; actorIndex < ACTOR_COUNT; actorIndex += 1) {
      const current = claimTasks[actorIndex];
      claimCalls += 1;
      const claim = claimCarrierTaskStepAmount(
        current.mutable,
        current.step,
        actors[actorIndex].name,
        1,
      );
      if (!claim) continue;
      successfulClaims += 1;
      claim.release();
      releasedClaims += 1;
    }
  }
  for (const current of claimTasks) current.mutable.steps = current.originalSteps;
  const claimStepIndexReads = counts.stepIndexReads - stepReadsBeforeClaims;
  expect({ claimCalls, successfulClaims, releasedClaims, claimStepIndexReads }).toEqual({
    claimCalls: ACTOR_COUNT * ITERATIONS_PER_BATCH,
    successfulClaims: ACTOR_COUNT * ITERATIONS_PER_BATCH,
    releasedClaims: ACTOR_COUNT * ITERATIONS_PER_BATCH,
    claimStepIndexReads: ACTOR_COUNT * ITERATIONS_PER_BATCH,
  });
  expect(counts.actorDescriptorReads).toBe(claimCalls);
  expect(counts.actorEnumerations).toBe(0);

  const readEntries = listCarrierEntries(fixture);
  const readTasks = readEntries.map((entry) => {
    const mutable = getMutableCarrierTaskByRefForTest(entry.ref);
    if (!mutable) throw new Error("expected mutable test task");
    const originalSteps = mutable.steps;
    mutable.steps = new Proxy(originalSteps, {
      ownKeys(target): ArrayLike<string | symbol> {
        counts.stepArrayEnumerations += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          counts.stepEntryDescriptorReads += 1;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    return { mutable, originalSteps };
  });
  const snapshot = peekCarrierTaskBoard();
  const snapshotEntries = Object.values(snapshot)
    .reduce((total, entries) => total + entries.length, 0);
  for (const current of readTasks) current.mutable.steps = current.originalSteps;
  expect(snapshotEntries).toBe(ROOM_COUNT * TASKS_PER_ROOM);
  expect(counts.stepArrayEnumerations).toBe(snapshotEntries);
  expect(counts.stepEntryDescriptorReads).toBe(snapshotEntries * 2);
  expect(counts.actorDescriptorReads).toBe(claimCalls);
  restoreActors();

  return {
    exact: { exactCalls, exactResults, refDescriptorReads: counts.refDescriptorReads },
    list: { listCalls, listResults },
    replace: {
      replaceCalls,
      replaceResults,
      draftIndexReads: counts.draftIndexReads,
      stepIndexReads: stepReadsBeforeClaims,
    },
    claim: {
      claimCalls,
      successfulClaims,
      releasedClaims,
      claimStepIndexReads,
      actorDescriptorReads: counts.actorDescriptorReads,
      actorEnumerations: counts.actorEnumerations,
    },
    readDto: {
      snapshotCalls: 1,
      snapshotEntries,
      stepArrayEnumerations: counts.stepArrayEnumerations,
      stepEntryDescriptorReads: counts.stepEntryDescriptorReads,
    },
  };
}

jest.setTimeout(120_000);

describe("local dispatch performance baseline", () => {
  it("records current timing observations and gates deterministic complexity", () => {
    delete (global as RuntimeGlobal).__runtimeServices;
    Game.time = 10_000;
    Game.rooms = {};
    const targets: Record<string, RoomObject> = {};
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = (
      (id: string) => targets[id] ?? null
    ) as Game["getObjectById"];

    const worker = installWorkerFixture(targets);
    const workerCurrent = characterizeCurrent(
      ACTOR_COUNT * ITERATIONS_PER_BATCH,
      PRE_CHANGE_OBSERVATION.workerCurrent,
      () => {
        let assigned = 0;
        for (const actor of worker.actors) {
          if (assignWorkerTask(actor)) assigned += 1;
        }
        return assigned;
      },
    );

    for (let actorIndex = 0; actorIndex < ACTOR_COUNT; actorIndex += 1) {
      expect(workerSlotClaimPort.release(
        worker.actors[actorIndex].name,
        worker.actorRefs[actorIndex],
        worker.actorTasks[actorIndex],
      )).toBe(true);
    }
    const workerRelease = characterizeCurrent(
      ACTOR_COUNT * ITERATIONS_PER_BATCH,
      PRE_CHANGE_OBSERVATION.workerRelease,
      () => {
        let released = 0;
        for (let actorIndex = 0; actorIndex < ACTOR_COUNT; actorIndex += 1) {
          const actor = worker.actors[actorIndex];
          if (!workerSlotClaimPort.acquire(
            actor.name,
            worker.actorRefs[actorIndex],
            worker.actorTasks[actorIndex],
          )) {
            continue;
          }
          releaseWorkerTask(actor);
          released += 1;
        }
        return released;
      },
    );

    const carrier = installCarrierFixture();
    const carrierTasksPerIteration = ROOM_COUNT * TASKS_PER_ROOM;
    const carrierList = characterizeCurrent(
      carrierTasksPerIteration * ITERATIONS_PER_BATCH,
      PRE_CHANGE_OBSERVATION.carrierList,
      () => carrier.roomNames.reduce(
        (total, roomName) => total + listCarrierTasksByRoom(roomName).length,
        0,
      ),
    );

    const claimEntries = listCarrierEntries(carrier).slice(0, ACTOR_COUNT);
    const carrierClaim = characterizeCurrent(
      ACTOR_COUNT * ITERATIONS_PER_BATCH,
      PRE_CHANGE_OBSERVATION.carrierClaim,
      () => {
        Game.time += 1;
        let successful = 0;
        for (let actorIndex = 0; actorIndex < ACTOR_COUNT; actorIndex += 1) {
          const entry = claimEntries[actorIndex];
          const claim = claimCarrierTaskStepAmount(
            entry.task,
            entry.task.steps[0],
            worker.actors[actorIndex].name,
            1,
          );
          if (!claim) continue;
          successful += 1;
          claim.release();
        }
        return successful;
      },
    );

    const carrierReplace = characterizeCurrent(
      carrierTasksPerIteration * ITERATIONS_PER_BATCH,
      PRE_CHANGE_OBSERVATION.carrierReplace,
      () => {
        let replaced = 0;
        for (const roomName of carrier.roomNames) {
          const drafts = carrier.draftsByRoom.get(roomName)!;
          replaceCarrierTasksForProducerRoom(
            carrier.producerByRoom.get(roomName)!,
            roomName,
            drafts,
          );
          replaced += drafts.length;
        }
        return replaced;
      },
    );

    const workerReleaseComplexity = probeWorkerReleaseComplexity(worker);
    const workerAcquireReconcileComplexity = probeWorkerAcquireReconcileComplexity(
      worker.actors,
    );
    const carrierComplexity = probeCarrierComplexity(carrier, worker.actors);

    const output = {
      schema: "local-dispatch-performance-baseline/v2",
      implementation: "full-ref-local-dispatch",
      fixture: {
        rooms: ROOM_COUNT,
        tasksPerRoom: TASKS_PER_ROOM,
        totalTasksPerDomain: ROOM_COUNT * TASKS_PER_ROOM,
        actors: ACTOR_COUNT,
      },
      protocol: {
        clock: "process.hrtime.bigint",
        timingUnit: "milliseconds",
        warmupBatches: WARMUP_BATCHES,
        measuredBatches: MEASURED_BATCHES,
        iterationsPerBatch: ITERATIONS_PER_BATCH,
        p95: "nearest-rank",
        timingPassFail: "observation-only; deployment CPU gate is the live same-shard window",
        complexityPassFail: "deterministic public-input/read-DTO counts",
      },
      preChangeEvidence: {
        source: "openspec/changes/local-dispatch-ownership/evidence/pre-change-baseline.md",
        commit: "df2e1af60a035fd99406888d69bba9903e8a7118",
        observation: PRE_CHANGE_OBSERVATION,
      },
      scenarios: {
        workerCurrent,
        workerRelease,
        carrierList,
        carrierClaim,
        carrierReplace,
      },
      complexityGates: {
        workerRelease: workerReleaseComplexity,
        workerAcquireReconcile: workerAcquireReconcileComplexity,
        carrier: carrierComplexity,
      },
      limitations: [
        "Node/Jest wall-clock is not Screeps CPU and old/current samples came from separate processes.",
        "Relative old/current wall-clock ratios are observations, never pass/fail authorization.",
        "Worker current starts bound; Carrier claim is the uncontended immediate-release path.",
        "Carrier complexity probes observe public inputs/read DTOs and never the private Map hierarchy.",
      ],
    };
    expect(Object.keys(output.scenarios)).toHaveLength(5);
    for (const scenario of Object.values(output.scenarios)) {
      expect(scenario.samples).toHaveLength(MEASURED_BATCHES);
      expect(Number.isFinite(scenario.median)).toBe(true);
      expect(Number.isFinite(scenario.p95)).toBe(true);
    }
    console.log(`LOCAL_DISPATCH_PERFORMANCE_BASELINE ${JSON.stringify(output)}`);
  });
});

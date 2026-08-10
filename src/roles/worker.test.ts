jest.mock("@/roles/energyTargets", () => ({
  pickupEnergyFromPreferredTarget: jest.fn(),
}));

jest.mock("@/roles/shared", () => ({
  moveToRemoteWorkTarget: jest.fn(),
  moveToTarget: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => ScreepsReturnCode) => fn()),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  releasePickupReservation: jest.fn(),
}));

jest.mock("@/runtime/workerTaskPool", () => ({
  assignWorkerTask: jest.fn(),
  completeWorkerTaskIfDone: jest.fn(),
  getWorkerTaskTarget: jest.fn(),
  isWorkerTaskSafeForCreep: jest.fn(),
  releaseWorkerTask: jest.fn(),
}));

import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { moveToRemoteWorkTarget, moveToTarget } from "@/roles/shared";
import { workerRole } from "@/roles/worker";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import {
  assignWorkerTask,
  completeWorkerTaskIfDone,
  getWorkerTaskTarget,
  isWorkerTaskSafeForCreep,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import type { WorkerTask, WorkerTaskType } from "@/types/system";

const mockedPickupEnergy = pickupEnergyFromPreferredTarget as jest.MockedFunction<
  typeof pickupEnergyFromPreferredTarget
>;
const mockedMoveToRemoteWorkTarget = moveToRemoteWorkTarget as jest.MockedFunction<
  typeof moveToRemoteWorkTarget
>;
const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;
const mockedReleasePickupReservation = releasePickupReservation as jest.MockedFunction<
  typeof releasePickupReservation
>;
const mockedAssignWorkerTask = assignWorkerTask as jest.MockedFunction<typeof assignWorkerTask>;
const mockedCompleteWorkerTaskIfDone = completeWorkerTaskIfDone as jest.MockedFunction<
  typeof completeWorkerTaskIfDone
>;
const mockedGetWorkerTaskTarget = getWorkerTaskTarget as jest.MockedFunction<
  typeof getWorkerTaskTarget
>;
const mockedIsWorkerTaskSafeForCreep = isWorkerTaskSafeForCreep as jest.MockedFunction<
  typeof isWorkerTaskSafeForCreep
>;
const mockedReleaseWorkerTask = releaseWorkerTask as jest.MockedFunction<
  typeof releaseWorkerTask
>;

interface MutableEnergy {
  value: number;
  capacity: number;
}

const target = {
  id: "worker-target-1",
  pos: { x: 20, y: 21, roomName: "W1N1" } as RoomPosition,
} as unknown as RoomObject;

function createTask(type: WorkerTaskType): WorkerTask {
  return {
    id: `${type}:worker-target-1`,
    type,
    targetId: "worker-target-1",
    roomName: "W1N1",
    priority: 300,
    assignedCreeps: ["worker-1"],
    maxAssignees: 1,
    status: "active",
    updatedAt: 100,
  };
}

function createCreep(initialEnergy = 50, capacity = 100): {
  creep: Creep;
  energy: MutableEnergy;
} {
  const energy = { value: initialEnergy, capacity };
  const creep = {
    name: "worker-1",
    room: { name: "W1N1" } as Room,
    memory: { role: "worker" },
    pos: { getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? energy.value : 0,
      getFreeCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY
          ? energy.capacity - energy.value
          : 0,
    },
    build: jest.fn(() => OK),
    upgradeController: jest.fn(() => OK),
    repair: jest.fn(() => OK),
    dismantle: jest.fn(() => OK),
  } as unknown as Creep;

  return { creep, energy };
}

function getActionMock(creep: Creep, type: WorkerTaskType): jest.Mock {
  if (type === "build") return creep.build as jest.Mock;
  if (type === "upgrade") return creep.upgradeController as jest.Mock;
  if (type === "repair") return creep.repair as jest.Mock;
  return creep.dismantle as jest.Mock;
}

function expectMovementFor(creep: Creep, type: WorkerTaskType): void {
  if (type === "dismantle") {
    expect(mockedMoveToTarget).toHaveBeenCalledWith(creep, target.pos, 1, {
      swampCost: 8,
      reusePath: 5,
      ignoreCreeps: true,
    });
    expect(mockedMoveToRemoteWorkTarget).not.toHaveBeenCalled();
    return;
  }

  expect(mockedMoveToRemoteWorkTarget).toHaveBeenCalledWith(creep, target);
  expect(mockedMoveToTarget).not.toHaveBeenCalled();
}

function arrangeTask(type: WorkerTaskType): WorkerTask {
  const task = createTask(type);
  mockedAssignWorkerTask.mockReturnValue(task);
  mockedGetWorkerTaskTarget.mockReturnValue(target);
  return task;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedPickupEnergy.mockReturnValue({ picked: false, outOfRange: false });
  mockedMoveToRemoteWorkTarget.mockReturnValue(OK);
  mockedMoveToTarget.mockReturnValue(OK);
  mockedAssignWorkerTask.mockReturnValue(null);
  mockedGetWorkerTaskTarget.mockReturnValue(target);
  mockedIsWorkerTaskSafeForCreep.mockReturnValue(true);
  mockedCompleteWorkerTaskIfDone.mockReturnValue(false);
});

describe("workerRole source phase", () => {
  it.each([
    ["picked energy", { picked: true, outOfRange: false }, 20, 100],
    ["became full", { picked: false, outOfRange: false }, 100, 100],
  ])("returns the mount switch signal after it %s", (_label, pickupResult, energy, capacity) => {
    const { creep } = createCreep(energy, capacity);
    mockedPickupEnergy.mockReturnValue(pickupResult);

    const shouldSwitchToTarget = workerRole().source!(creep);

    expect(shouldSwitchToTarget).toBe(true);
    expect(mockedPickupEnergy).toHaveBeenCalledWith(creep, { swampCost: 8 });
    expect(mockedReleasePickupReservation).toHaveBeenCalledWith(creep);
  });

  it.each([
    ["has no pickup target", { picked: false, outOfRange: false }],
    ["is still walking to energy", { picked: false, outOfRange: true }],
  ])("stays in source phase when it %s", (_label, pickupResult) => {
    const { creep } = createCreep(0, 100);
    mockedPickupEnergy.mockReturnValue(pickupResult);

    expect(workerRole().source!(creep)).toBe(false);
    expect(mockedReleasePickupReservation).not.toHaveBeenCalled();
  });
});

describe("workerRole target preconditions", () => {
  it.each([
    [50, false],
    [0, true],
  ])("only asks mount to return to source when no task exists and energy is %i", (energy, expected) => {
    const { creep } = createCreep(energy);

    expect(workerRole().target(creep)).toBe(expected);
    expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
  });

  it("releases an assignment whose target disappeared before issuing any intent", () => {
    const task = arrangeTask("build");
    const { creep } = createCreep(0);
    mockedGetWorkerTaskTarget.mockReturnValue(null);

    expect(workerRole().target(creep)).toBe(true);
    expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    expect(mockedIsWorkerTaskSafeForCreep).not.toHaveBeenCalled();
    expect(getActionMock(creep, task.type)).not.toHaveBeenCalled();
  });

  it("releases an unsafe assignment before issuing any intent", () => {
    const task = arrangeTask("repair");
    const { creep } = createCreep(50);
    mockedIsWorkerTaskSafeForCreep.mockReturnValue(false);

    expect(workerRole().target(creep)).toBe(false);
    expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    expect(getActionMock(creep, task.type)).not.toHaveBeenCalled();
  });
});

describe("workerRole task execution", () => {
  it.each<WorkerTaskType>(["build", "upgrade", "repair", "dismantle"])(
    "issues the %s intent and its existing movement on OK",
    (type) => {
      const task = arrangeTask(type);
      const { creep } = createCreep(50);

      expect(workerRole().target(creep)).toBe(false);
      expect(getActionMock(creep, type)).toHaveBeenCalledWith(target);
      expectMovementFor(creep, type);
      expect(mockedCompleteWorkerTaskIfDone).toHaveBeenCalledWith(task);
      expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
    },
  );

  it.each<WorkerTaskType>(["build", "upgrade", "repair", "dismantle"])(
    "releases a %s assignment after ERR_INVALID_TARGET",
    (type) => {
      arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_INVALID_TARGET);

      expect(workerRole().target(creep)).toBe(false);
      expectMovementFor(creep, type);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
      expect(mockedCompleteWorkerTaskIfDone).not.toHaveBeenCalled();
    },
  );

  it.each<WorkerTaskType>(["build", "upgrade", "repair", "dismantle"])(
    "releases a completed %s assignment after the intent",
    (type) => {
      const task = arrangeTask(type);
      const { creep } = createCreep(50);
      mockedCompleteWorkerTaskIfDone.mockReturnValue(true);

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedCompleteWorkerTaskIfDone).toHaveBeenCalledWith(task);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    },
  );

  it.each<Exclude<WorkerTaskType, "dismantle">>(["build", "upgrade", "repair"])(
    "releases %s and returns the mount switch signal when its last energy is spent",
    (type) => {
      arrangeTask(type);
      const { creep, energy } = createCreep(1);
      getActionMock(creep, type).mockImplementation(() => {
        energy.value = 0;
        return OK;
      });

      expect(workerRole().target(creep)).toBe(true);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    },
  );

  it("keeps dismantle in target phase even with an empty energy store", () => {
    arrangeTask("dismantle");
    const { creep } = createCreep(0);

    expect(workerRole().target(creep)).toBe(false);
    expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
  });
});

describe("workerRole movement failures", () => {
  it.each([
    ["build" as const, true],
    ["upgrade" as const, false],
  ])(
    "keeps a distant %s assignment when remote movement returns ERR_NO_PATH",
    (type, checksCompletion) => {
      const task = arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_NOT_IN_RANGE);
      mockedMoveToRemoteWorkTarget.mockReturnValue(ERR_NO_PATH);

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedMoveToRemoteWorkTarget).toHaveBeenCalledWith(creep, target);
      expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
      if (checksCompletion) {
        expect(mockedCompleteWorkerTaskIfDone).toHaveBeenCalledWith(task);
      } else {
        expect(mockedCompleteWorkerTaskIfDone).not.toHaveBeenCalled();
      }
    },
  );

  it.each<"repair" | "dismantle">(["repair", "dismantle"])(
    "keeps a distant %s assignment while a route still exists",
    (type) => {
      arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_NOT_IN_RANGE);

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedReleaseWorkerTask).not.toHaveBeenCalled();
      expect(mockedCompleteWorkerTaskIfDone).not.toHaveBeenCalled();
    },
  );

  it.each<"repair" | "dismantle">(["repair", "dismantle"])(
    "releases a distant %s assignment when movement returns ERR_NO_PATH",
    (type) => {
      arrangeTask(type);
      const { creep } = createCreep(50);
      getActionMock(creep, type).mockReturnValue(ERR_NOT_IN_RANGE);
      if (type === "repair") {
        mockedMoveToRemoteWorkTarget.mockReturnValue(ERR_NO_PATH);
      } else {
        mockedMoveToTarget.mockReturnValue(ERR_NO_PATH);
      }

      expect(workerRole().target(creep)).toBe(false);
      expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
      expect(mockedCompleteWorkerTaskIfDone).not.toHaveBeenCalled();
    },
  );
});

describe("workerRole unknown task fallback", () => {
  it.each([
    [50, false],
    [0, true],
  ])("releases an unknown task and bases the phase signal on %i energy", (energy, expected) => {
    const task = {
      ...createTask("build"),
      type: "unknown",
    } as unknown as WorkerTask;
    mockedAssignWorkerTask.mockReturnValue(task);
    mockedGetWorkerTaskTarget.mockReturnValue(target);
    const { creep } = createCreep(energy);

    expect(workerRole().target(creep)).toBe(expected);
    expect(mockedReleaseWorkerTask).toHaveBeenCalledWith(creep);
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.repair).not.toHaveBeenCalled();
    expect(creep.dismantle).not.toHaveBeenCalled();
    expect(mockedMoveToRemoteWorkTarget).not.toHaveBeenCalled();
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
  });
});

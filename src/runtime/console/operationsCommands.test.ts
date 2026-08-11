jest.mock("@/runtime/warControl", () => ({
  getWarStatus: jest.fn(),
  releaseWarTaskOwner: jest.fn(),
  startWarPatrol: jest.fn(),
  startWarRoom: jest.fn(),
  stopWarRoom: jest.fn(),
}));

import { stopColonization } from "@/runtime/console/operationsCommands";
import { releaseWarTaskOwner } from "@/runtime/warControl";

describe("operations War owner cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Memory.data = {
      war: {
        W2N2: {
          targetRoom: "W2N2",
          sourceRoom: "W1N1",
          status: "clearing",
          reason: "npc_reservation",
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    (releaseWarTaskOwner as jest.Mock).mockReturnValue({
      ok: true,
      targetRoom: "W2N2",
      removedTask: true,
      removedConfigs: 2,
      removedQueuedTasks: 3,
      cancelledSpawns: 1,
      suicidedCreeps: 2,
      releasedBoosts: false,
    });
  });

  it("delegates War cleanup to the exact owner gateway and preserves aggregate counts", () => {
    const result = stopColonization("W2N2");

    expect(releaseWarTaskOwner).toHaveBeenCalledWith("W2N2", { suicide: true });
    expect(result).toEqual({
      ok: true,
      scope: "room",
      targetRoom: "W2N2",
      stoppedColonizationRooms: [],
      stoppedCrossShardTasks: [],
      stoppedWarRooms: ["W2N2"],
      removedConfigs: 2,
      removedQueuedTasks: 3,
      cancelledSpawns: 1,
      suicidedCreeps: 2,
    });
  });
});

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { remoteDefenderRole } from "@/roles/remoteDefender";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";
import type { RemoteMiningTask, RemoteDefenseReason } from "@/runtime/remoteMining";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

const SOURCE_ROOM = "W1N1";
const TARGET_ROOM = "W2N1";
const CONFIG_NAME = `${SOURCE_ROOM}:remoteMine:${TARGET_ROOM}:defender:0`;

function makeCreep(overrides: {
  x?: number;
  y?: number;
  roomName?: string;
  hits?: number;
  hitsMax?: number;
  body?: Array<{ type: BodyPartConstant; hits: number }>;
  memory?: Record<string, unknown>;
} = {}) {
  const body = overrides.body ?? [
    ...Array.from({ length: 5 }, () => ({ type: RANGED_ATTACK as BodyPartConstant, hits: 100 })),
    ...Array.from({ length: 3 }, () => ({ type: HEAL as BodyPartConstant, hits: 100 })),
    ...Array.from({ length: 8 }, () => ({ type: MOVE as BodyPartConstant, hits: 100 })),
  ];
  const hitsMax = overrides.hitsMax ?? body.reduce((s, p) => s + p.hits, 0);
  return createMockPowerBankCreep("remoteDefender", {
    x: overrides.x ?? 25,
    y: overrides.y ?? 25,
    roomName: overrides.roomName ?? TARGET_ROOM,
    hits: overrides.hits ?? hitsMax,
    hitsMax,
    body,
    memory: {
      role: "remoteDefender",
      configName: CONFIG_NAME,
      ...overrides.memory,
    },
  });
}

function makeHostile(overrides: {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  username?: string;
  body?: Array<{ type: BodyPartConstant; hits: number }>;
} = {}) {
  const x = overrides.x ?? 25;
  const y = overrides.y ?? 25;
  const body = overrides.body ?? [
    { type: ATTACK as BodyPartConstant, hits: 100 },
    { type: MOVE as BodyPartConstant, hits: 100 },
  ];
  return {
    id: (overrides.id ?? overrides.name ?? "hostile-0") as Id<Creep>,
    name: overrides.name ?? "hostile-0",
    pos: new MockPos(x, y, TARGET_ROOM) as unknown as RoomPosition,
    room: { name: TARGET_ROOM } as Room,
    body,
    hits: body.reduce((s, p) => s + p.hits, 0),
    hitsMax: body.reduce((s, p) => s + p.hits, 0),
    owner: { username: overrides.username ?? "Invader" },
    my: false,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((p) => p.type === part && p.hits > 0).length),
  } as unknown as Creep;
}

function makeFriendly(overrides: {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  role?: string;
  configName?: string;
} = {}) {
  const x = overrides.x ?? 25;
  const y = overrides.y ?? 25;
  const body = [
    { type: WORK as BodyPartConstant, hits: 100 },
    { type: MOVE as BodyPartConstant, hits: 100 },
  ];
  return {
    id: (overrides.id ?? overrides.name ?? "friendly-0") as Id<Creep>,
    name: overrides.name ?? "friendly-0",
    pos: new MockPos(x, y, TARGET_ROOM) as unknown as RoomPosition,
    room: { name: TARGET_ROOM } as Room,
    body,
    hits: body.reduce((s, p) => s + p.hits, 0),
    hitsMax: body.reduce((s, p) => s + p.hits, 0),
    owner: { username: "player" },
    my: true,
    memory: {
      role: overrides.role ?? "remoteMiningCarrier",
      configName: overrides.configName ?? `${SOURCE_ROOM}:remoteMine:${TARGET_ROOM}:carrier:0`,
    },
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((p) => p.type === part && p.hits > 0).length),
  } as unknown as Creep;
}

function setupTask(defenseReason?: RemoteDefenseReason): RemoteMiningTask {
  return {
    sourceRoom: SOURCE_ROOM,
    targetRoom: TARGET_ROOM,
    status: defenseReason ? "defending" : "active",
    sourceIds: ["source-0", "source-1"],
    assignedAt: 100,
    updatedAt: 100,
    defenseReason,
  };
}

function setupMemory(task?: RemoteMiningTask) {
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.remoteMining) Memory.data.remoteMining = {};
  if (task) {
    Memory.data.remoteMining[TARGET_ROOM] = task;
  }
}

describe("remoteDefenderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.time = 100;
    (Memory as any).data = {};
    (global as any).RoomPosition = MockPos;
    setupMemory(setupTask("npc_invader"));
  });

  describe("combat actions", () => {

    it("uses rangedMassAttack when 3+ eligible hostiles in range 3", () => {
      const hostiles = [
        makeHostile({ id: "h0", username: "Invader", x: 26, y: 25 }),
        makeHostile({ id: "h1", username: "Invader", x: 24, y: 25 }),
        makeHostile({ id: "h2", username: "Invader", x: 25, y: 26 }),
      ];

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return hostiles;
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedMassAttack).toHaveBeenCalled();
    });

    it("uses rangedAttack on single target when fewer than 3 hostiles in range", () => {
      const hostile = makeHostile({
        id: "h0", username: "Invader", x: 26, y: 25,
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(hostile);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
    });
  });

  describe("flee from melee", () => {

    it("chooses an alternate safe flee direction when the preferred boundary direction leaves the room", () => {
      const invader = makeHostile({
        id: "inv-melee-bottom-edge",
        username: "Invader",
        x: 13, y: 48,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep({ x: 12, y: 49 });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(invader);
      expect(creep.move).toHaveBeenCalledWith(TOP_LEFT);
      expect(creep.move).not.toHaveBeenCalledWith(BOTTOM_LEFT);
    });

    it("clears a non-combat Invader remnant that is blocking the defender on an exit tile", () => {
      const invader = makeHostile({
        id: "inv-remnant-edge",
        username: "Invader",
        x: 13, y: 48,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 0 },
          { type: MOVE as BodyPartConstant, hits: 66 },
        ],
      });

      const creep = makeCreep({ x: 12, y: 49 });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(invader);
      expect(creep.move).toHaveBeenCalledWith(TOP_LEFT);
      expect(moveToTargetRoom).not.toHaveBeenCalledWith(creep, SOURCE_ROOM, expect.anything(), expect.anything());
    });
  });

  describe("retirement", () => {
    it("retires from source room instead of returning to a non-defending remote room", () => {
      setupMemory(setupTask(undefined));
      delete (Memory.data as any).remoteMining[TARGET_ROOM].defenseReason;

      const creep = makeCreep({ roomName: SOURCE_ROOM, x: 12, y: 0 });
      (creep.room as any).find = jest.fn((_type: number) => []);

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).not.toHaveBeenCalledWith(
        creep,
        TARGET_ROOM,
        expect.anything(),
        expect.anything(),
      );
      expect(moveToTarget).toHaveBeenCalledWith(creep, new MockPos(25, 25, SOURCE_ROOM), 3, { reusePath: 5 });
      expect(creep.suicide).toHaveBeenCalled();
    });

    it("returns home and suicides when no eligible hostiles and task not defending", () => {
      setupMemory(setupTask(undefined));
      delete (Memory.data as any).remoteMining[TARGET_ROOM].defenseReason;

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((_type: number) => []);

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        creep,
        SOURCE_ROOM,
        undefined,
        expect.objectContaining({ reusePath: 5 }),
      );
    });
  });
});

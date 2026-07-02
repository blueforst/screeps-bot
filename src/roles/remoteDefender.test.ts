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

  describe("travel", () => {
    it("travels to target room when not there", () => {
      const creep = makeCreep({ roomName: SOURCE_ROOM });
      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        creep,
        TARGET_ROOM,
        undefined,
        expect.objectContaining({ plainCost: 2, swampCost: 10 }),
      );
    });

    it("does not travel when already in target room", () => {
      const creep = makeCreep({ roomName: TARGET_ROOM });
      (creep.room as any).find = jest.fn((_type: number) => []);
      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).not.toHaveBeenCalled();
    });
  });

  describe("target selection", () => {
    it("attacks NPC Invader with combat parts", () => {
      const invader = makeHostile({
        id: "invader-0",
        username: "Invader",
        x: 26, y: 25,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(invader);
    });

    it("ignores Source Keeper creeps", () => {
      const skCreep = makeHostile({
        id: "sk-0",
        name: "sk-0",
        username: "Source Keeper",
        x: 26, y: 25,
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [skCreep];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).not.toHaveBeenCalled();
      expect(creep.attack).not.toHaveBeenCalled();
    });

    it("does NOT attack player creeps when defenseReason is npc_invader", () => {
      const playerCreep = makeHostile({
        id: "player-0",
        username: "OtherPlayer",
        x: 26, y: 25,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [playerCreep];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).not.toHaveBeenCalledWith(playerCreep);
    });

    it("attacks player creeps when defenseReason is player_aggression", () => {
      setupMemory(setupTask("player_aggression"));

      const playerCreep = makeHostile({
        id: "player-0",
        username: "OtherPlayer",
        x: 26, y: 25,
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [playerCreep];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(playerCreep);
    });

    it("does not attack player creeps merely because they are present regardless of body parts", () => {
      setupMemory(setupTask("npc_invader"));

      const playerWithAttack = makeHostile({
        id: "player-armed",
        username: "SomePlayer",
        x: 26, y: 25,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: RANGED_ATTACK as BodyPartConstant, hits: 100 },
          { type: HEAL as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [playerWithAttack];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).not.toHaveBeenCalledWith(playerWithAttack);
      expect(creep.attack).not.toHaveBeenCalledWith(playerWithAttack);
    });

    it("prioritizes target with HEAL parts over RANGED_ATTACK", () => {
      const healer = makeHostile({
        id: "invader-healer",
        username: "Invader",
        x: 26, y: 25,
        body: [
          { type: HEAL as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const ranged = makeHostile({
        id: "invader-ranged",
        username: "Invader",
        x: 27, y: 25,
        body: [
          { type: RANGED_ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [ranged, healer];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(healer);
    });

    it("attacks MOVE-only Invader so NPC blockers are fully cleared", () => {
      const harmlessInvader = makeHostile({
        id: "invader-harmless",
        username: "Invader",
        x: 26, y: 25,
        body: [
          { type: MOVE as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [harmlessInvader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(harmlessInvader);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
    });

    it("attacks TOUGH-only Invader so NPC blockers are fully cleared", () => {
      const toughInvader = makeHostile({
        id: "invader-tough",
        username: "Invader",
        x: 26, y: 25,
        body: [
          { type: TOUGH as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [toughInvader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(toughInvader);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
    });
  });

  describe("combat actions", () => {
    it("moves toward target when out of range instead of attacking", () => {
      const invader = makeHostile({
        id: "inv-far",
        username: "Invader",
        x: 10, y: 10,
      });

      const creep = makeCreep({ x: 40, y: 40 });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).not.toHaveBeenCalled();
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
      expect(moveToTarget).toHaveBeenCalledWith(creep, invader, 3, expect.objectContaining({ reusePath: 5 }));
    });

    it("avoids exit tiles when chasing a remote hostile near the room boundary", () => {
      const invader = makeHostile({
        id: "inv-edge",
        username: "Invader",
        x: 1, y: 25,
      });

      const creep = makeCreep({ x: 25, y: 25 });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTarget).toHaveBeenCalledWith(
        creep,
        invader,
        3,
        expect.objectContaining({ avoidExitTiles: true }),
      );
    });

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

  describe("healing", () => {
    it("self-heals when damaged", () => {
      const creep = makeCreep({ hits: 500, hitsMax: 1600 });
      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.heal).toHaveBeenCalledWith(creep);
    });

    it("heals friendly remote creep in range 1", () => {
      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });
      const friendly = makeFriendly({
        id: "friend-0", x: 25, y: 25, configName: `${SOURCE_ROOM}:remoteMine:${TARGET_ROOM}:carrier:0`,
      });
      (friendly as any).hits = 100;
      (friendly as any).hitsMax = 200;

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });
      (Game as any).creeps = { "friend-0": friendly };

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.heal).toHaveBeenCalledWith(friendly);
    });

    it("uses rangedHeal on friendly within range 3 but not range 1", () => {
      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });
      const friendly = makeFriendly({
        id: "friend-0", x: 28, y: 25, configName: `${SOURCE_ROOM}:remoteMine:${TARGET_ROOM}:carrier:0`,
      });
      (friendly as any).hits = 100;
      (friendly as any).hitsMax = 200;

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });
      (Game as any).creeps = { "friend-0": friendly };

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedHeal).toHaveBeenCalledWith(friendly);
    });

    it("does not heal when self at full health and no damaged friendlies", () => {
      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });

      const friendly = makeFriendly({
        id: "friend-0", x: 28, y: 25, configName: `${SOURCE_ROOM}:remoteMine:${TARGET_ROOM}:carrier:0`,
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });
      (Game as any).creeps = { "friend-0": friendly };

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.heal).not.toHaveBeenCalledWith(expect.anything());
      expect(creep.rangedHeal).not.toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("retreat", () => {
    it("retreats toward home when hits < 50% hitsMax", () => {
      const creep = makeCreep({ hits: 400, hitsMax: 1600 });
      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.heal).toHaveBeenCalledWith(creep);
      expect(moveToTargetRoom).toHaveBeenCalledWith(
        creep,
        SOURCE_ROOM,
        undefined,
        expect.objectContaining({ reusePath: 5 }),
      );
    });
  });

  describe("flee from melee", () => {
    it("flees when target has ATTACK parts and is within range 2", () => {
      const invader = makeHostile({
        id: "inv-melee",
        username: "Invader",
        x: 26, y: 25,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.move).toHaveBeenCalled();
    });

    it("does not flee onto an exit tile at the room boundary", () => {
      const invader = makeHostile({
        id: "inv-melee-edge",
        username: "Invader",
        x: 2, y: 25,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });

      const creep = makeCreep({ x: 1, y: 25 });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(invader);
      expect(creep.move).not.toHaveBeenCalledWith(LEFT);
    });

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

    it("moves inward from an exit tile even after the target ATTACK part is destroyed", () => {
      const invader = makeHostile({
        id: "inv-damaged-edge",
        username: "Invader",
        x: 13, y: 48,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 0 },
          { type: RANGED_ATTACK as BodyPartConstant, hits: 66 },
          { type: MOVE as BodyPartConstant, hits: 0 },
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

  describe("unified movement API", () => {
    it("uses moveToTarget for same-room target approach", () => {
      const invader = makeHostile({
        id: "inv-far", username: "Invader", x: 10, y: 10,
      });
      const creep = makeCreep({ x: 40, y: 40 });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTarget).toHaveBeenCalledWith(
        creep, invader, 3, expect.objectContaining({ reusePath: 5 }),
      );
    });

    it("uses moveToTargetRoom for cross-room retreat when damaged", () => {
      const creep = makeCreep({ hits: 400, hitsMax: 1600 });
      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(moveToTargetRoom).toHaveBeenCalledWith(
        creep, SOURCE_ROOM, undefined, expect.objectContaining({ reusePath: 5 }),
      );
    });

    it("preserves tactical creep.move() for flee", () => {
      const invader = makeHostile({
        id: "inv-melee", username: "Invader", x: 26, y: 25,
        body: [
          { type: ATTACK as BodyPartConstant, hits: 100 },
          { type: MOVE as BodyPartConstant, hits: 100 },
        ],
      });
      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.move).toHaveBeenCalled();
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

    it("stays and fights when task is defending with npc_invader", () => {
      setupMemory(setupTask("npc_invader"));

      const invader = makeHostile({
        id: "inv-0", username: "Invader", x: 26, y: 25,
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [invader];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(invader);
    });
  });

  describe("no task found", () => {
    it("returns home and suicides when no remote mining task exists", () => {
      setupMemory(undefined);
      delete (Memory.data as any).remoteMining[TARGET_ROOM];

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

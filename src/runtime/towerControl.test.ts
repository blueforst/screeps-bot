import { runTowerControl } from "@/runtime/towerControl";
import { writeDefenseFronts } from "@/runtime/defenseCoordination";
import type { DefenseFront } from "@/runtime/defenseFronts";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }

  public findClosestByRange<T extends { pos: { x: number; y: number } }>(targets: T[]): T | null {
    let closest: T | null = null;
    let closestRange = Number.POSITIVE_INFINITY;

    for (const target of targets) {
      const range = this.getRangeTo(target);
      if (range < closestRange) {
        closest = target;
        closestRange = range;
      }
    }

    return closest;
  }

  public lookFor(): never[] {
    return [];
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(energy: number): StoreDefinition {
  return {
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? 1000 : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY || resource === undefined ? Math.max(0, 1000 - energy) : 0,
    ),
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? energy : 0)),
  } as unknown as StoreDefinition;
}

function createBody(type: BodyPartConstant, count: number): BodyPartDefinition[] {
  return Array.from({ length: count }, () => ({ type, hits: 100 }) as BodyPartDefinition);
}

function createHostile(
  roomName: string,
  id: string,
  x: number,
  y: number,
  options: {
    hits?: number;
    body?: BodyPartDefinition[];
  } = {},
): Creep {
  const body = options.body ?? createBody(MOVE, 1);
  const hits = options.hits ?? body.length * 100;
  return {
    id: id as Id<Creep>,
    owner: {
      username: "Enemy",
    } as Owner,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    body,
    hits,
    hitsMax: hits,
  } as Creep;
}

function createTower(roomName: string, id: string, x: number, y: number, energy = 1000): StructureTower {
  return {
    id: id as Id<StructureTower>,
    structureType: STRUCTURE_TOWER,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    store: createStore(energy),
    attack: jest.fn(() => OK),
    heal: jest.fn(() => OK),
    repair: jest.fn(() => OK),
  } as unknown as StructureTower;
}

function createRoom(
  name: string,
  options: {
    towers: StructureTower[];
    hostiles?: Creep[];
    myCreeps?: Creep[];
    structures?: Structure<StructureConstant>[];
  },
): Room {
  const towers = options.towers;
  const hostiles = options.hostiles ?? [];
  const myCreeps = options.myCreeps ?? [];
  const structures = options.structures ?? towers;

  return {
    name,
    controller: {
      my: true,
    } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === FIND_MY_STRUCTURES) {
        return towers;
      }

      if (type === FIND_MY_CREEPS) {
        return myCreeps;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      return [];
    },
  } as Room;
}

describe("runTowerControl", () => {
  beforeEach(() => {
    resetRuntimeServices();
    jest.clearAllMocks();
    Game.time = 1;
    Memory.runtime = {};
  });

  it("keeps towers focused on the same target during periodic probe ticks when focus damage is still positive", () => {
    Game.time = 7;

    const roomName = "W1N1";
    const focusTarget = createHostile(roomName, "hostile-focus", 11, 10, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const otherTarget = createHostile(roomName, "hostile-other", 25, 25, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [focusTarget, otherTarget],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerB.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerA.attack).not.toHaveBeenCalledWith(otherTarget);
    expect(towerB.attack).not.toHaveBeenCalledWith(otherTarget);
  });

  it("does not waste tower energy when every hostile is immune to tower damage", () => {
    const roomName = "W1N2";
    const healerA = createHostile(roomName, "hostile-a", 30, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const healerB = createHostile(roomName, "hostile-b", 31, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [healerA, healerB],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).not.toHaveBeenCalled();
    expect(towerB.attack).not.toHaveBeenCalled();
  });

  it("does not probe-spread into an ineffective focus target while waiting for defenders", () => {
    const roomName = "W1N6";
    const ineffectiveLowHitsTarget = createHostile(roomName, "immune-low", 30, 30, {
      body: createBody(HEAL, 30),
      hits: 100,
    });
    const barelyEffectiveHighHitsTarget = createHostile(roomName, "barely-effective-high", 45, 45, {
      body: [...createBody(HEAL, 12), ...createBody(MOVE, 388)],
      hits: 40000,
    });
    const tower = createTower(roomName, "tower-a", 10, 10);
    const room = createRoom(roomName, {
      towers: [tower],
      hostiles: [ineffectiveLowHitsTarget, barelyEffectiveHighHitsTarget],
    });

    Game.rooms[room.name] = room;

    runTowerControl();

    expect(tower.attack).toHaveBeenCalledWith(barelyEffectiveHighHitsTarget);
    expect(tower.attack).not.toHaveBeenCalledWith(ineffectiveLowHitsTarget);
  });

  it("stops tower fire when no tower-only target has positive net damage", () => {
    const roomName = "W1N7";
    const healerA = createHostile(roomName, "healer-a", 30, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const healerB = createHostile(roomName, "healer-b", 31, 30, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const tower = createTower(roomName, "tower-a", 10, 10);
    const room = createRoom(roomName, {
      towers: [tower],
      hostiles: [healerA, healerB],
    });

    Memory.runtime = {
      towerCombat: {
        [roomName]: {
          focusTargetId: healerA.id,
          lastFocusHits: healerA.hits,
          stalledTicks: 3,
          spreadUntil: Game.time + 3,
        },
      },
    } as Memory["runtime"];
    Game.rooms[room.name] = room;

    runTowerControl();

    expect(tower.attack).not.toHaveBeenCalled();
    expect(Memory.runtime?.towerCombat?.[roomName]?.focusTargetId).toBeUndefined();
    expect(Memory.runtime?.towerCombat?.[roomName]?.spreadUntil).toBeUndefined();
  });

  it("spreads attacks after focus fire stalls across consecutive ticks", () => {
    const roomName = "W1N3";
    const focusTarget = createHostile(roomName, "hostile-focus", 11, 10, {
      body: createBody(MOVE, 1),
      hits: 90,
    });
    const otherTarget = createHostile(roomName, "hostile-other", 25, 25, {
      body: createBody(MOVE, 1),
      hits: 100,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [focusTarget, otherTarget],
    });

    Memory.runtime = {
      towerCombat: {
        [roomName]: {
          focusTargetId: focusTarget.id,
          lastFocusHits: 100,
          stalledTicks: 1,
        },
      },
    } as Memory["runtime"];
    Game.rooms[room.name] = room;

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(focusTarget);
    expect(towerB.attack).toHaveBeenCalledWith(otherTarget);
  });

  it("focuses tower fire on the coordinated front", () => {
    const roomName = "W9N9";
    const frontHostile = createHostile(roomName, "front-hostile", 11, 10, {
      body: createBody(ATTACK, 2),
      hits: 200,
    });
    const offFrontHostile = createHostile(roomName, "off-front-hostile", 40, 40, {
      body: createBody(ATTACK, 1),
      hits: 100,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 12, 10);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [frontHostile, offFrontHostile],
    });
    Game.rooms[room.name] = room;

    const fronts: DefenseFront[] = [
      {
        id: "front:0",
        hostiles: [frontHostile],
        hostileIds: [frontHostile.id],
        centroid: { x: frontHostile.pos.x, y: frontHostile.pos.y },
        threatScore: 10,
      },
      {
        id: "front:1",
        hostiles: [offFrontHostile],
        hostileIds: [offFrontHostile.id],
        centroid: { x: offFrontHostile.pos.x, y: offFrontHostile.pos.y },
        threatScore: 2,
      },
    ];
    writeDefenseFronts(roomName, fronts);

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(frontHostile);
    expect(towerB.attack).toHaveBeenCalledWith(frontHostile);
    expect(towerA.attack).not.toHaveBeenCalledWith(offFrontHostile);
    expect(towerB.attack).not.toHaveBeenCalledWith(offFrontHostile);
  });

  it("counts healers outside the active front before spending tower energy", () => {
    const roomName = "W9N5";
    const frontAttacker = createHostile(roomName, "front-attacker", 48, 12, {
      body: [...createBody(TOUGH, 16), ...createBody(RANGED_ATTACK, 3), ...createBody(WORK, 4), ...createBody(ATTACK, 2)],
      hits: 5000,
    });
    const adjacentHealer = createHostile(roomName, "adjacent-healer", 49, 13, {
      body: createBody(HEAL, 25),
      hits: 5000,
    });
    const towerA = createTower(roomName, "tower-a", 6, 6);
    const towerB = createTower(roomName, "tower-b", 6, 7);
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [frontAttacker, adjacentHealer],
    });
    Game.rooms[room.name] = room;

    writeDefenseFronts(roomName, [
      {
        id: "front:0",
        hostiles: [frontAttacker],
        hostileIds: [frontAttacker.id],
        centroid: { x: frontAttacker.pos.x, y: frontAttacker.pos.y },
        threatScore: 57,
      },
      {
        id: "front:1",
        hostiles: [adjacentHealer],
        hostileIds: [adjacentHealer.id],
        centroid: { x: adjacentHealer.pos.x, y: adjacentHealer.pos.y },
        threatScore: 25,
      },
    ]);

    runTowerControl();

    expect(towerA.attack).not.toHaveBeenCalled();
    expect(towerB.attack).not.toHaveBeenCalled();
  });

  it("bursts the same front-line target as a rampart defender when that burst is effective", () => {
    const roomName = "W9N8";
    const healer = createHostile(roomName, "healer", 18, 10, {
      body: createBody(HEAL, 2),
      hits: 200,
    });
    const dismantler = createHostile(roomName, "dismantler", 11, 10, {
      body: createBody(WORK, 2),
      hits: 200,
    });
    const towerA = createTower(roomName, "tower-a", 10, 10);
    const towerB = createTower(roomName, "tower-b", 13, 10);
    const defender = {
      memory: { role: "homeDefender" },
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 10 : 0)),
      pos: {
        getRangeTo: jest.fn((target: { pos?: { x: number; y: number }; x?: number; y?: number }) => {
          const targetPos = "pos" in target && target.pos ? target.pos : target;
          return Math.max(Math.abs(10 - (targetPos.x ?? 0)), Math.abs(10 - (targetPos.y ?? 0)));
        }),
        lookFor: jest.fn(() => [{ structureType: STRUCTURE_RAMPART, my: true }]),
      },
      hits: 100,
      hitsMax: 100,
    } as unknown as Creep;
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [healer, dismantler],
      myCreeps: [defender],
    });
    Game.rooms[room.name] = room;

    writeDefenseFronts(roomName, [
      {
        id: "front:0",
        hostiles: [healer, dismantler],
        hostileIds: [healer.id, dismantler.id],
        centroid: { x: 12, y: 10 },
        threatScore: 20,
      },
    ]);

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(dismantler);
    expect(towerB.attack).toHaveBeenCalledWith(dismantler);
  });

  it("avoids forcing coordinated burst onto a target when no defender is actually in position to join it", () => {
    const roomName = "W9N7";
    const protectedDismantler = createHostile(roomName, "protected-dismantler", 11, 10, {
      body: createBody(WORK, 2),
      hits: 200,
    });
    const exposedAttacker = createHostile(roomName, "exposed-attacker", 15, 10, {
      body: createBody(ATTACK, 2),
      hits: 200,
    });
    const healerA = createHostile(roomName, "healer-a", 12, 10, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const healerB = createHostile(roomName, "healer-b", 12, 11, {
      body: createBody(HEAL, 30),
      hits: 3000,
    });
    const towerA = createTower(roomName, "tower-a", 48, 48);
    const towerB = createTower(roomName, "tower-b", 47, 48);
    const defender = {
      memory: { role: "homeDefender" },
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 5 : 0)),
      pos: {
        getRangeTo: jest.fn((target: { pos?: { x: number; y: number }; x?: number; y?: number }) => {
          const targetPos = "pos" in target && target.pos ? target.pos : target;
          return Math.max(Math.abs(20 - (targetPos.x ?? 0)), Math.abs(10 - (targetPos.y ?? 0)));
        }),
        lookFor: jest.fn(() => [{ structureType: STRUCTURE_RAMPART, my: true }]),
      },
      hits: 100,
      hitsMax: 100,
    } as unknown as Creep;
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [protectedDismantler, exposedAttacker, healerA, healerB],
      myCreeps: [defender],
    });
    Game.rooms[room.name] = room;

    writeDefenseFronts(roomName, [
      {
        id: "front:0",
        hostiles: [protectedDismantler, exposedAttacker, healerA, healerB],
        hostileIds: [protectedDismantler.id, exposedAttacker.id, healerA.id, healerB.id],
        centroid: { x: 13, y: 10 },
        threatScore: 20,
      },
    ]);

    runTowerControl();

    expect(towerA.attack).not.toHaveBeenCalledWith(protectedDismantler);
    expect(towerB.attack).not.toHaveBeenCalledWith(protectedDismantler);
    expect(towerA.attack).toHaveBeenCalledWith(exposedAttacker);
    expect(towerB.attack).toHaveBeenCalledWith(exposedAttacker);
  });

  it("still performs a coordinated burst when towers alone are immune but defender burst makes it viable", () => {
    const roomName = "W9N6";
    const protectedDismantler = createHostile(roomName, "protected-dismantler", 11, 10, {
      body: createBody(WORK, 2),
      hits: 200,
    });
    const healerA = createHostile(roomName, "healer-a", 12, 10, {
      body: createBody(HEAL, 10),
      hits: 1000,
    });
    const healerB = createHostile(roomName, "healer-b", 12, 11, {
      body: createBody(HEAL, 10),
      hits: 1000,
    });
    const towerA = createTower(roomName, "tower-a", 48, 48);
    const towerB = createTower(roomName, "tower-b", 47, 48);
    const defender = {
      memory: { role: "homeDefender" },
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 10 : 0)),
      pos: {
        getRangeTo: jest.fn((target: { pos?: { x: number; y: number }; x?: number; y?: number }) => {
          const targetPos = "pos" in target && target.pos ? target.pos : target;
          return Math.max(Math.abs(10 - (targetPos.x ?? 0)), Math.abs(10 - (targetPos.y ?? 0)));
        }),
        lookFor: jest.fn(() => [{ structureType: STRUCTURE_RAMPART, my: true }]),
      },
      hits: 100,
      hitsMax: 100,
    } as unknown as Creep;
    const room = createRoom(roomName, {
      towers: [towerA, towerB],
      hostiles: [protectedDismantler, healerA, healerB],
      myCreeps: [defender],
    });
    Game.rooms[room.name] = room;

    writeDefenseFronts(roomName, [
      {
        id: "front:0",
        hostiles: [protectedDismantler, healerA, healerB],
        hostileIds: [protectedDismantler.id, healerA.id, healerB.id],
        centroid: { x: 12, y: 10 },
        threatScore: 20,
      },
    ]);

    runTowerControl();

    expect(towerA.attack).toHaveBeenCalledWith(protectedDismantler);
    expect(towerB.attack).toHaveBeenCalledWith(protectedDismantler);
  });
});

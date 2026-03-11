export interface RoomTickContext {
  room: Room;
  getStructures(): Structure<StructureConstant>[];
  getMyStructures(): Structure<StructureConstant>[];
  getConstructionSites(): ConstructionSite[];
  getHostileCreeps(): Creep[];
  getTowers(): StructureTower[];
  getDroppedEnergyResources(): Resource[];
  getEnergyTombstones(): Tombstone[];
  getEnergyRuins(): Ruin[];
}

export interface TickContextService {
  getTick(): number;
  getMyRooms(): Room[];
  getPrimarySpawnByRoom(roomName: string): StructureSpawn | undefined;
  getSpawnsByRoom(roomName: string): StructureSpawn[];
  getCreepsByConfigName(configName: string): Creep[];
  getCreepsByRole(role: string): Creep[];
  getCreepsByRoom(roomName: string): Creep[];
  getRoomContext(room: Room | string): RoomTickContext | null;
}

interface TickContextSnapshot {
  tick: number;
  myRooms?: Room[];
  spawnsByRoom?: Map<string, StructureSpawn[]>;
  primarySpawnByRoom?: Map<string, StructureSpawn>;
  creepsByConfigName?: Map<string, Creep[]>;
  creepsByRole?: Map<string, Creep[]>;
  creepsByRoom?: Map<string, Creep[]>;
  roomContexts?: Map<string, RoomTickContext>;
}

function createRoomTickContext(room: Room): RoomTickContext {
  let structures: Structure<StructureConstant>[] | undefined;
  let myStructures: Structure<StructureConstant>[] | undefined;
  let constructionSites: ConstructionSite[] | undefined;
  let hostileCreeps: Creep[] | undefined;
  let towers: StructureTower[] | undefined;
  let droppedEnergyResources: Resource[] | undefined;
  let energyTombstones: Tombstone[] | undefined;
  let energyRuins: Ruin[] | undefined;

  return {
    room,
    getStructures(): Structure<StructureConstant>[] {
      if (!structures) {
        structures = room.find(FIND_STRUCTURES);
      }
      return structures;
    },
    getMyStructures(): Structure<StructureConstant>[] {
      if (!myStructures) {
        myStructures = room.find(FIND_MY_STRUCTURES);
      }
      return myStructures;
    },
    getConstructionSites(): ConstructionSite[] {
      if (!constructionSites) {
        constructionSites = room.find(FIND_CONSTRUCTION_SITES);
      }
      return constructionSites;
    },
    getHostileCreeps(): Creep[] {
      if (!hostileCreeps) {
        hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
      }
      return hostileCreeps;
    },
    getTowers(): StructureTower[] {
      if (!towers) {
        towers = room.find(FIND_MY_STRUCTURES, {
          filter: (structure): structure is StructureTower => structure.structureType === STRUCTURE_TOWER,
        });
      }
      return towers;
    },
    getDroppedEnergyResources(): Resource[] {
      if (!droppedEnergyResources) {
        droppedEnergyResources = room.find(FIND_DROPPED_RESOURCES, {
          filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
        });
      }
      return droppedEnergyResources;
    },
    getEnergyTombstones(): Tombstone[] {
      if (!energyTombstones) {
        energyTombstones = room.find(FIND_TOMBSTONES, {
          filter: (tombstone) => tombstone.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
        });
      }
      return energyTombstones;
    },
    getEnergyRuins(): Ruin[] {
      if (!energyRuins) {
        energyRuins = room.find(FIND_RUINS, {
          filter: (ruin) => ruin.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
        });
      }
      return energyRuins;
    },
  };
}

export function createTickContextService(): TickContextService {
  let snapshot: TickContextSnapshot = {
    tick: -1,
  };

  function ensureCurrentTick(): TickContextSnapshot {
    if (snapshot.tick !== Game.time) {
      snapshot = {
        tick: Game.time,
      };
    }
    return snapshot;
  }

  function ensureMyRooms(current: TickContextSnapshot): Room[] {
    if (!current.myRooms) {
      current.myRooms = Object.values(Game.rooms).filter((room) => room.controller?.my);
    }
    return current.myRooms;
  }

  function ensureSpawnIndexes(current: TickContextSnapshot): void {
    if (current.spawnsByRoom && current.primarySpawnByRoom) {
      return;
    }

    const spawnsByRoom = new Map<string, StructureSpawn[]>();
    const primarySpawnByRoom = new Map<string, StructureSpawn>();

    for (const spawn of Object.values(Game.spawns)) {
      const roomSpawns = spawnsByRoom.get(spawn.room.name);
      if (roomSpawns) {
        roomSpawns.push(spawn);
      } else {
        spawnsByRoom.set(spawn.room.name, [spawn]);
      }

      if (!primarySpawnByRoom.has(spawn.room.name)) {
        primarySpawnByRoom.set(spawn.room.name, spawn);
      }
    }

    current.spawnsByRoom = spawnsByRoom;
    current.primarySpawnByRoom = primarySpawnByRoom;
  }

  function ensureCreepIndexes(current: TickContextSnapshot): void {
    if (current.creepsByConfigName && current.creepsByRole && current.creepsByRoom) {
      return;
    }

    const creepsByConfigName = new Map<string, Creep[]>();
    const creepsByRole = new Map<string, Creep[]>();
    const creepsByRoom = new Map<string, Creep[]>();

    for (const creep of Object.values(Game.creeps)) {
      const configName = creep.memory.configName;
      if (typeof configName === "string") {
        const byConfig = creepsByConfigName.get(configName);
        if (byConfig) {
          byConfig.push(creep);
        } else {
          creepsByConfigName.set(configName, [creep]);
        }
      }

      const byRole = creepsByRole.get(creep.memory.role);
      if (byRole) {
        byRole.push(creep);
      } else {
        creepsByRole.set(creep.memory.role, [creep]);
      }

      const byRoom = creepsByRoom.get(creep.room.name);
      if (byRoom) {
        byRoom.push(creep);
      } else {
        creepsByRoom.set(creep.room.name, [creep]);
      }
    }

    current.creepsByConfigName = creepsByConfigName;
    current.creepsByRole = creepsByRole;
    current.creepsByRoom = creepsByRoom;
  }

  return {
    getTick(): number {
      return ensureCurrentTick().tick;
    },

    getMyRooms(): Room[] {
      const current = ensureCurrentTick();
      return ensureMyRooms(current);
    },

    getPrimarySpawnByRoom(roomName: string): StructureSpawn | undefined {
      const current = ensureCurrentTick();
      ensureSpawnIndexes(current);
      return current.primarySpawnByRoom?.get(roomName);
    },

    getSpawnsByRoom(roomName: string): StructureSpawn[] {
      const current = ensureCurrentTick();
      ensureSpawnIndexes(current);
      return current.spawnsByRoom?.get(roomName) || [];
    },

    getCreepsByConfigName(configName: string): Creep[] {
      const current = ensureCurrentTick();
      ensureCreepIndexes(current);
      return current.creepsByConfigName?.get(configName) || [];
    },

    getCreepsByRole(role: string): Creep[] {
      const current = ensureCurrentTick();
      ensureCreepIndexes(current);
      return current.creepsByRole?.get(role) || [];
    },

    getCreepsByRoom(roomName: string): Creep[] {
      const current = ensureCurrentTick();
      ensureCreepIndexes(current);
      return current.creepsByRoom?.get(roomName) || [];
    },

    getRoomContext(room: Room | string): RoomTickContext | null {
      const current = ensureCurrentTick();
      const roomName = typeof room === "string" ? room : room.name;
      const resolvedRoom = typeof room === "string" ? Game.rooms[room] : room;
      if (!resolvedRoom) {
        return null;
      }

      if (!current.roomContexts) {
        current.roomContexts = new Map<string, RoomTickContext>();
      }

      const existing = current.roomContexts.get(roomName);
      if (existing) {
        return existing;
      }

      const context = createRoomTickContext(resolvedRoom);
      current.roomContexts.set(roomName, context);
      return context;
    },
  };
}

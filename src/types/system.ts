export type RoleName =
  | "harvester"
  | "mineralHarvester"
  | "miner"
  | "carrier"
  | "worker"
  | "scout"
  | "claimer"
  | "colonizerHarvester"
  | "colonizerWorker"
  | "meleeAttacker"
  | "healer"
  | "homeDefender"
  | "crossShardClaimer"
  | "crossShardColonizerHarvester"
  | "crossShardColonizerWorker"
  | "flagScout"
  | "remoteCarrier";
export type WorkerTaskType = "build" | "upgrade" | "repair" | "dismantle";
export type RoomType = "normal" | "reserved" | "industrial";

export interface CreepConfig {
  role: RoleName;
  args: string[];
  roomName?: string;
  body?: BodyPartConstant[];
  name?: string;
}

export interface RoleLifecycle {
  prepare?: (creep: Creep) => boolean;
  source?: (creep: Creep) => boolean;
  target: (creep: Creep) => boolean;
}

export interface WorkerTask {
  id: string;
  type: WorkerTaskType;
  targetId: string;
  roomName: string;
  priority: number;
  requiredWork?: number;
  repairTargetHits?: number;
  repairMode?: "emergency" | "normal";
  assignedCreeps: string[];
  maxAssignees: number;
  status: "active" | "done";
  updatedAt: number;
}

export type RoleFactory = (...args: string[]) => RoleLifecycle;

export interface CreepApi {
  add(configName: string, role: RoleName, ...args: string[]): string;
  remove(configName: string): string;
  get(configName: string): CreepConfig | undefined;
  list(prefix?: string): Record<string, CreepConfig>;
}

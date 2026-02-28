export type RoleName =
  | "harvester"
  | "miner"
  | "carrier"
  | "worker"
  | "scout"
  | "claimer"
  | "colonizerHarvester"
  | "colonizerWorker"
  | "meleeAttacker"
  | "healer"
  | "crossShardClaimer"
  | "crossShardColonizerHarvester"
  | "crossShardColonizerWorker";
export type WorkerTaskType = "build" | "upgrade" | "repair";

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

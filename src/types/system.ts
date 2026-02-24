export type RoleName = "harvester" | "carrier" | "upgrader" | "builder";

export interface CreepConfig {
  role: RoleName;
  args: string[];
  roomName?: string;
  body?: BodyPartConstant[];
}

export interface RoleLifecycle {
  prepare?: (creep: Creep) => boolean;
  source?: (creep: Creep) => boolean;
  target: (creep: Creep) => boolean;
}

export type RoleFactory = (...args: string[]) => RoleLifecycle;

export interface CreepApi {
  add(configName: string, role: RoleName, ...args: string[]): string;
  remove(configName: string): string;
  get(configName: string): CreepConfig | undefined;
  list(prefix?: string): Record<string, CreepConfig>;
}

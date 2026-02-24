import type { LoDashStatic } from "lodash";
import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

declare const _: LoDashStatic;

declare global {
  var creepApi: CreepApi;
  var __screepsMounted: boolean | undefined;

  interface Memory {
    creepConfigs?: Record<string, CreepConfig>;
  }

  interface CreepMemory {
    role?: RoleName;
    configName?: string;
    working?: boolean;
    ready?: boolean;
  }

  interface SpawnMemory {
    spawnList?: string[];
  }

  interface Creep {
    work(): void;
  }

  interface StructureSpawn {
    work(): void;
    addTask(configName: string): number;
    mainSpawn(configName: string): boolean;
  }
}

declare namespace NodeJS {
  interface Global {
    Game: Game;
    Memory: Memory;
    _: LoDashStatic;
    creepApi: CreepApi;
    __screepsMounted?: boolean;
  }
}

export {};

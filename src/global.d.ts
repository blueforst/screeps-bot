import type { LoDashStatic } from "lodash";
import type { CreepApi, CreepConfig, RoleName } from "@/types/system";

declare const _: LoDashStatic;

declare global {
  var creepApi: CreepApi;
  var __screepsMounted: boolean | undefined;
  var RP: (room: string | Room) => { [structureType: string]: { x: number; y: number }[] } | undefined;
  var runPlan: (room: string | Room) => boolean;
  var visualizePlan: (roomName: string) => boolean;
  var listPlanCache: () => void;
  var clearRoomPlanCache: (roomName: string) => void;
  var savePlanToMemory: (roomName: string) => boolean;

  interface Memory {
    creepConfigs?: Record<string, CreepConfig>;
    roomPlanner?: {
      [roomName: string]: {
        layout: { [structureType: string]: { x: number; y: number }[] };
        timestamp: string;
        savedAt: number;
      };
    };
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

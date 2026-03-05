import { getCreepConfigService } from "@/runtime/runtimeServices";
import type { RoleName } from "@/types/system";

const runtimeGlobal = global;

export function registerGlobalApi(): void {
  runtimeGlobal.creepApi = getCreepConfigService();
}

export function upsertConfig(configName: string, role: RoleName, args: string[], roomName?: string): void {
  getCreepConfigService().upsert(configName, role, args, roomName);
}

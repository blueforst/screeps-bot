import { carrierRole } from "@/roles/carrier";
import { harvesterRole } from "@/roles/harvester";
import { workerRole } from "@/roles/worker";
import type { RoleFactory, RoleName } from "@/types/system";

export const roleRegistry: Record<RoleName, RoleFactory> = {
  harvester: harvesterRole,
  carrier: carrierRole,
  worker: workerRole,
};

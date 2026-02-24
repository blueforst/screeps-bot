import { builderRole } from "@/roles/builder";
import { carrierRole } from "@/roles/carrier";
import { harvesterRole } from "@/roles/harvester";
import { upgraderRole } from "@/roles/upgrader";
import type { RoleFactory, RoleName } from "@/types/system";

export const roleRegistry: Record<RoleName, RoleFactory> = {
  harvester: harvesterRole,
  carrier: carrierRole,
  upgrader: upgraderRole,
  builder: builderRole,
};

import { carrierRole } from "@/roles/carrier";
import { claimerRole } from "@/roles/claimer";
import { colonizerHarvesterRole } from "@/roles/colonizerHarvester";
import { colonizerWorkerRole } from "@/roles/colonizerWorker";
import { harvesterRole } from "@/roles/harvester";
import { minerRole } from "@/roles/miner";
import { scoutRole } from "@/roles/scout";
import { workerRole } from "@/roles/worker";
import type { RoleFactory, RoleName } from "@/types/system";

export const roleRegistry: Record<RoleName, RoleFactory> = {
  harvester: harvesterRole,
  miner: minerRole,
  carrier: carrierRole,
  worker: workerRole,
  scout: scoutRole,
  claimer: claimerRole,
  colonizerHarvester: colonizerHarvesterRole,
  colonizerWorker: colonizerWorkerRole,
};

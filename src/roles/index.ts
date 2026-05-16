import { carrierRole } from "@/roles/carrier";
import { claimerRole } from "@/roles/claimer";
import { flagScoutRole } from "@/roles/flagScout";
import { colonizerHarvesterRole } from "@/roles/colonizerHarvester";
import { colonizerWorkerRole } from "@/roles/colonizerWorker";
import { crossShardColonizerHarvesterRole } from "@/roles/crossShardColonizerHarvester";
import { crossShardColonizerWorkerRole } from "@/roles/crossShardColonizerWorker";
import { crossShardClaimerRole } from "@/roles/crossShardClaimer";
import { harvesterRole } from "@/roles/harvester";
import { healerRole } from "@/roles/healer";
import { homeDefenderRole } from "@/roles/homeDefender";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { minerRole } from "@/roles/miner";
import { mineralHarvesterRole } from "@/roles/mineralHarvester";
import { powerBankAttackerRole } from "@/roles/powerBankAttacker";
import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { remoteCarrierRole } from "@/roles/remoteCarrier";
import { scoutRole } from "@/roles/scout";
import { workerRole } from "@/roles/worker";
import type { RoleFactory, RoleName } from "@/types/system";

const powerBankStubRole: RoleFactory = () => ({ target: () => false });

export const roleRegistry: Record<RoleName, RoleFactory> = {
  harvester: harvesterRole,
  mineralHarvester: mineralHarvesterRole,
  miner: minerRole,
  carrier: carrierRole,
  worker: workerRole,
  scout: scoutRole,
  claimer: claimerRole,
  colonizerHarvester: colonizerHarvesterRole,
  colonizerWorker: colonizerWorkerRole,
  crossShardColonizerHarvester: crossShardColonizerHarvesterRole,
  crossShardColonizerWorker: crossShardColonizerWorkerRole,
  homeDefender: homeDefenderRole,
  meleeAttacker: meleeAttackerRole,
  healer: healerRole,
  crossShardClaimer: crossShardClaimerRole,
  flagScout: flagScoutRole,
  remoteCarrier: remoteCarrierRole,
  powerBankScout: powerBankStubRole,
  powerBankAttacker: powerBankAttackerRole,
  powerBankHealer: powerBankHealerRole,
  powerBankHauler: powerBankStubRole,
};

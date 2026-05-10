/** Hub planner config schema, defaults, and runtime state. Chain planning is in future tasks. */

const DEFAULT_TARGET_COMPOUNDS: ResourceConstant[] = [
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
  RESOURCE_CATALYZED_GHODIUM_ACID, // XGH2O
  RESOURCE_CATALYZED_UTRIUM_ACID, // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE, // XUHO2
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
];

const DEFAULT_RESERVE_PER_ROOM = 1000;

export function getDefaultHubConfig(): NonNullable<Memory["cfg"]>["hub"] {
  return {
    enabled: false,
    hubRoomName: "",
    planInterval: 50,
    reservePerRoom: DEFAULT_RESERVE_PER_ROOM,
    targetCompounds: [...DEFAULT_TARGET_COMPOUNDS],
    storagePauseFreeCapacity: 100_000,
    surplusThreshold: DEFAULT_RESERVE_PER_ROOM + 500,
    internalOnly: true,
  };
}

export function getDefaultHubRuntime(): NonNullable<Memory["runtime"]>["hub"] {
  return {
    status: "idle",
    updatedAt: 0,
    activeProduct: "",
    activeStep: 0,
    missingResources: [],
    lastPlanActions: [],
    needsPlan: false,
  };
}

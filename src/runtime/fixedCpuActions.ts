export const OFFICIAL_A_MARKED_ACTIONS = {
  ConstructionSite: ["remove"],

  Flag: ["remove", "setColor", "setPosition"],

  Game_market: ["cancelOrder", "changeOrderPrice", "createOrder", "deal", "extendOrder"],

  Creep: [
    "attack",
    "attackController",
    "build",
    "claimController",
    "dismantle",
    "drop",
    "generateSafeMode",
    "harvest",
    "heal",
    "move",
    "moveByPath",
    "notifyWhenAttacked",
    "pickup",
    "rangedAttack",
    "rangedHeal",
    "rangedMassAttack",
    "repair",
    "reserveController",
    "signController",
    "suicide",
    "transfer",
    "upgradeController",
    "withdraw",
  ],

  PowerCreep: [
    "delete",
    "drop",
    "enableRoom",
    "move",
    "moveByPath",
    "notifyWhenAttacked",
    "pickup",
    "renew",
    "spawn",
    "suicide",
    "transfer",
    "upgrade",
    "usePower",
    "withdraw",
  ],

  Room: ["createConstructionSite", "createFlag"],

  RoomPosition: ["createConstructionSite", "createFlag"],

  Structure: ["destroy", "notifyWhenAttacked"],

  StructureController: ["activateSafeMode", "unclaim"],

  StructureFactory: ["produce"],

  StructureLab: ["boostCreep", "reverseReaction", "runReaction", "unboostCreep"],

  StructureLink: ["transferEnergy"],

  StructureNuker: ["launchNuke"],

  StructureObserver: ["observeRoom"],

  StructurePowerSpawn: ["processPower"],

  StructureRampart: ["setPublic"],

  StructureSpawn: ["createCreep", "spawnCreep", "recycleCreep", "renewCreep"],

  StructureTerminal: ["send"],

  StructureTower: ["attack", "heal", "repair"],
} as const;

export const EXTRA_NON_A_BUT_YOU_WANTED = {
  Creep: [
    "moveTo",
  ],
  PowerCreep: [
    "moveTo",
  ],
} as const;

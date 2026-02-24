let autoPlannerLoaded = false;

function ensureAutoPlannerLoaded(): boolean {
  if (autoPlannerLoaded) {
    return true;
  }

  if (typeof RoomVisual === "undefined") {
    return false;
  }

  require("./RoomVisual.js");
  require("./planner.js");
  autoPlannerLoaded = true;
  return true;
}

function createVisualFlag(room: Room, pos: RoomPosition): void {
  const flagName = `VP_${room.name}`;
  room.createFlag(pos, flagName);
}

export function runAutoPlannerByFlag(): void {
  if (!ensureAutoPlannerLoaded()) {
    return;
  }

  const planningFlag = Game.flags.RP;
  if (planningFlag) {
    const roomName = planningFlag.pos.roomName;
    if (runPlan(roomName)) {
      const planningRoom = Game.rooms[roomName];
      const flagPos = planningFlag.pos;
      planningFlag.remove();
      if (planningRoom) {
        createVisualFlag(planningRoom, flagPos);
      }
    }
  }

  const saveFlag = Game.flags.SP;
  if (saveFlag) {
    const roomName = saveFlag.pos.roomName;
    if (savePlanToMemory(roomName)) {
      saveFlag.remove();
    }
  }

  Object.values(Game.flags)
    .filter((flag) => flag.name === "VP" || flag.name.startsWith("VP_"))
    .forEach((flag) => {
      visualizePlan(flag.pos.roomName);
    });
}

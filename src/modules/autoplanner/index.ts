import "./RoomVisual.js";
import planner from "./planner.js";

type PlannerModule = {
  runPlan: (roomName: string) => boolean;
  visualizePlan: (roomName: string) => boolean;
  savePlanToMemory: (roomName: string) => boolean;
};

const plannerModule = planner as unknown as PlannerModule;

function canUsePlanner(roomName: string): boolean {
  if (typeof RoomVisual === "undefined") {
    return false;
  }

  return !!Game.rooms[roomName];
}

export function runPlannerForRoom(roomName: string): boolean {
  if (!canUsePlanner(roomName)) {
    return false;
  }

  return plannerModule.runPlan(roomName);
}

export function savePlannerForRoom(roomName: string): boolean {
  if (!canUsePlanner(roomName)) {
    return false;
  }

  return plannerModule.savePlanToMemory(roomName);
}

function createVisualFlag(room: Room, pos: RoomPosition): void {
  const flagName = `VP_${room.name}`;
  room.createFlag(pos, flagName);
}

export function runAutoPlannerByFlag(): void {
  if (typeof RoomVisual === "undefined") {
    return;
  }

  const planningFlag = Game.flags.RP;
  if (planningFlag) {
    const roomName = planningFlag.pos.roomName;
    if (plannerModule.runPlan(roomName)) {
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
    if (plannerModule.savePlanToMemory(roomName)) {
      saveFlag.remove();
    }
  }

  Object.values(Game.flags)
    .filter((flag) => flag.name === "VP" || flag.name.startsWith("VP_"))
    .forEach((flag) => {
      plannerModule.visualizePlan(flag.pos.roomName);
    });
}

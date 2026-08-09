export function doesCreepBodyMatch(
  creep: Creep,
  expectedBody: readonly BodyPartConstant[],
): boolean {
  return Array.isArray(creep.body) &&
    creep.body.length === expectedBody.length &&
    creep.body.every((part, index) => part.type === expectedBody[index]);
}

export function hasMatchingCreepBody(
  creeps: readonly Creep[],
  expectedBody: readonly BodyPartConstant[],
): boolean {
  return creeps.some((creep) => doesCreepBodyMatch(creep, expectedBody));
}

function isCreepInRangeTo(creep: Creep, target: RoomObject): boolean {
  return !!creep.pos && typeof creep.pos.inRangeTo === "function" && creep.pos.inRangeTo(target, 1);
}

export function retireMismatchedMinersAfterHandoff(
  creeps: readonly Creep[],
  source: Source,
  expectedBody: readonly BodyPartConstant[],
): void {
  const incumbentsAtSource = creeps.filter((creep) =>
    !doesCreepBodyMatch(creep, expectedBody) && isCreepInRangeTo(creep, source),
  );
  const replacementReady = creeps.some((creep) => {
    if (!doesCreepBodyMatch(creep, expectedBody)) {
      return false;
    }

    if (isCreepInRangeTo(creep, source)) {
      return true;
    }

    return incumbentsAtSource.some((incumbent) => isCreepInRangeTo(creep, incumbent));
  });
  if (!replacementReady) {
    return;
  }

  for (const creep of creeps) {
    if (!doesCreepBodyMatch(creep, expectedBody)) {
      creep.suicide();
    }
  }
}

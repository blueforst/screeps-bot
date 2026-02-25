const DEFAULT_WORKER_MAX = 8;
const DEFAULT_WORKER_BASE = 1;

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

export function getWorkerCap(): number {
  const configured = Memory.cfg?.worker?.maxPerRoom;
  const cap = typeof configured === "number" ? configured : DEFAULT_WORKER_MAX;
  return clamp(cap, 1, 10);
}

export function getDesiredWorkerCount(room: Room): number {
  const cap = getWorkerCap();
  const rcl = room.controller?.level ?? 1;
  let desired = rcl < 4 ? 6 - rcl : DEFAULT_WORKER_BASE;

  const constructionCount = room.find(FIND_CONSTRUCTION_SITES).length;
  if (constructionCount >= 1) {
    desired += 1;
  }
  if (constructionCount >= 6) {
    desired += 1;
  }
  if (constructionCount >= 15) {
    desired += 1;
  }

  return clamp(desired, 1, cap);
}

export function getExpectedManagedConfigNames(room: Room): string[] {
  const names: string[] = [];

  const sources = room.find(FIND_SOURCES);
  for (const source of sources) {
    names.push(`${room.name}:harvester:${source.id}`);
  }

  names.push(`${room.name}:carrier:0`);

  const workerCount = getDesiredWorkerCount(room);
  for (let i = 0; i < workerCount; i++) {
    names.push(`${room.name}:worker:${i}`);
  }

  return names;
}

export interface StoredPathStep {
  x: number;
  y: number;
}

export interface StoredRoomPosition {
  x: number;
  y: number;
  roomName: string;
}

export interface CachedTravelPath {
  key: string;
  sourceRoom: string;
  targetRoom: string;
  routeRooms: string[];
  positions: StoredRoomPosition[];
  generatedAt: number;
}

export interface MoveToTargetOptions {
  swampCost?: number;
  plainCost?: number;
  reusePath?: number;
  maxRooms?: number;
  ignoreCreeps?: boolean;
  avoidExitTiles?: boolean;
}

export interface MoveToRoomOptions extends MoveToTargetOptions {
  travelRange?: 1 | 3;
  avoidRooms?: string[];
}

export type MovementOptions = MoveToRoomOptions;

export interface TravelState {
  targetRoom: string;
  lastPosKey?: string;
  lastWasExit?: boolean;
  stuckTicks: number;
}

export interface MovePathState {
  key: string;
  path: string;
  steps: StoredPathStep[];
  targetRoom: string;
  targetX: number;
  targetY: number;
  range: 0 | 1 | 2 | 3;
  lastPosKey?: string;
  stuckTicks: number;
  expiresAt: number;
}

export interface DynamicRouteCacheEntry {
  nextRoom: string | null;
  expiresAt: number;
}

export interface RoomCostMatrixCacheEntry {
  tick: number;
  matrix: CostMatrix;
}

export interface WorkAnchor {
  x: number;
  y: number;
  roomName: string;
  range: number;
}

export type LogisticsShadowCpuSegment = "producer" | "consumer";

export interface LogisticsShadowCpuSnapshotV2 {
  readonly attributionVersion: 2;
  readonly sampleTick: number;
  readonly measurementAvailable: boolean;
  readonly producerUsed: number;
  readonly consumerUsed: number;
}

interface MutableLogisticsShadowCpuState {
  sampleTick: number;
  measurementAvailable: boolean;
  producerUsed: number;
  consumerUsed: number;
  producerSegmentCount: number;
  consumerSegmentCount: number;
  lastCpuUsed?: number;
  activeSegment?: LogisticsShadowCpuSegment;
}

export interface LogisticsShadowCpuDiagnosticsForTest {
  readonly sampleTick: number;
  readonly measurementAvailable: boolean;
  readonly producerSegmentCount: number;
  readonly consumerSegmentCount: number;
}

let currentState: MutableLogisticsShadowCpuState | undefined;

function readCurrentTick(): number | undefined {
  try {
    const tick = Game.time;
    return Number.isSafeInteger(tick) && tick >= 0 ? tick : undefined;
  } catch {
    return undefined;
  }
}

function readCpuUsed(): number | undefined {
  try {
    const used = Game.cpu?.getUsed?.();
    return typeof used === "number" && Number.isFinite(used) && used >= 0
      ? used
      : undefined;
  } catch {
    return undefined;
  }
}

function ensureState(tick: number): MutableLogisticsShadowCpuState {
  if (!currentState || currentState.sampleTick !== tick) {
    currentState = {
      sampleTick: tick,
      measurementAvailable: true,
      producerUsed: 0,
      consumerUsed: 0,
      producerSegmentCount: 0,
      consumerSegmentCount: 0,
    };
  }
  return currentState;
}

/**
 * 计量同一 tick 内离散的 Shadow-only 工作。
 *
 * 同 segment 嵌套时只由最外层区间计量，避免重复归因。不同 segment
 * 不允许重叠；若发生重叠、时钟不可用或回拨，本 tick attribution
 * 会 fail closed，但被计量的业务函数仍保持原始返回/抛错语义。
 */
export function measureLogisticsShadowCpu<T>(
  segment: LogisticsShadowCpuSegment,
  work: () => T,
): T {
  const tick = readCurrentTick();
  if (tick === undefined) {
    if (currentState) currentState.measurementAvailable = false;
    return work();
  }

  if (
    currentState?.activeSegment !== undefined &&
    currentState.sampleTick !== tick
  ) {
    currentState.measurementAvailable = false;
    return work();
  }

  const state = ensureState(tick);
  if (state.activeSegment === segment) return work();
  if (state.activeSegment !== undefined) {
    state.measurementAvailable = false;
    return work();
  }

  state.activeSegment = segment;
  if (segment === "producer") state.producerSegmentCount += 1;
  else state.consumerSegmentCount += 1;
  const startedAt = readCpuUsed();
  if (
    startedAt === undefined ||
    (state.lastCpuUsed !== undefined && startedAt < state.lastCpuUsed)
  ) {
    state.measurementAvailable = false;
  }

  try {
    return work();
  } finally {
    const finishedAt = readCpuUsed();
    const finishedTick = readCurrentTick();
    if (
      startedAt === undefined ||
      finishedAt === undefined ||
      finishedAt < startedAt ||
      finishedTick !== tick
    ) {
      state.measurementAvailable = false;
    } else if (segment === "producer") {
      state.producerUsed += finishedAt - startedAt;
    } else {
      state.consumerUsed += finishedAt - startedAt;
    }
    if (finishedAt !== undefined) state.lastCpuUsed = finishedAt;
    state.activeSegment = undefined;
  }
}

/** 返回当前 tick 的只读归因；没有任何分段时返回 undefined。 */
export function peekLogisticsShadowCpuSnapshot(
  requiredSegment?: LogisticsShadowCpuSegment,
):
  Readonly<LogisticsShadowCpuSnapshotV2> | undefined {
  const tick = readCurrentTick();
  if (!currentState || tick === undefined || currentState.sampleTick !== tick) {
    currentState = undefined;
    return undefined;
  }
  if (currentState.activeSegment !== undefined) return undefined;
  if (
    (requiredSegment === "producer" && currentState.producerSegmentCount === 0) ||
    (requiredSegment === "consumer" && currentState.consumerSegmentCount === 0)
  ) {
    return undefined;
  }
  return Object.freeze({
    attributionVersion: 2,
    sampleTick: currentState.sampleTick,
    measurementAvailable: currentState.measurementAvailable,
    producerUsed: currentState.producerUsed,
    consumerUsed: currentState.consumerUsed,
  });
}

export function getLogisticsShadowCpuDiagnosticsForTest():
  Readonly<LogisticsShadowCpuDiagnosticsForTest> | undefined {
  const tick = readCurrentTick();
  if (!currentState || tick === undefined || currentState.sampleTick !== tick) {
    return undefined;
  }
  return Object.freeze({
    sampleTick: currentState.sampleTick,
    measurementAvailable: currentState.measurementAvailable,
    producerSegmentCount: currentState.producerSegmentCount,
    consumerSegmentCount: currentState.consumerSegmentCount,
  });
}

export function resetLogisticsShadowCpuForTest(): void {
  currentState = undefined;
}

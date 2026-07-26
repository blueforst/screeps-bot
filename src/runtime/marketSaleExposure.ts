/**
 * 市场自动卖单的 Terminal 实物暴露量。
 *
 * 这里刻意只读取 Memory.data.marketSaleAutomation，不创建跨模块的长期
 * resourceReservation。卖单撤销/成交由市场生命周期先确认；确认前对应
 * 房间、对应资源必须继续留在 Terminal，确认并删除 data 记录后自动释放。
 */

export interface MarketSaleTerminalExposure {
  reservedAmount: number;
  blocked: boolean;
}

export interface TerminalAmountOutsideMarketSaleExposureClaim {
  amount: number;
  release(): void;
}

export interface TerminalSendOutsideMarketSaleExposureClaim {
  release(): void;
}

type UnknownRecord = Record<string, unknown>;

interface TerminalAmountInspection {
  availableAmount: number;
  reservationKey: string;
  requiresReservation: boolean;
}

interface TerminalAmountReservationEntry {
  key: string;
  amount: number;
}

let reservationTick: number | undefined;
let reservationGame: Game | undefined;
const inFlightTerminalAmounts = new Map<string, number>();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidExposure(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isValidRoomName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[WE]\d+[NS]\d+$/.test(value)
  );
}

function isValidResourceType(value: unknown): value is ResourceConstant {
  return (
    typeof value === "string" &&
    RESOURCES_ALL.includes(value as ResourceConstant)
  );
}

function addExposure(
  current: MarketSaleTerminalExposure,
  value: unknown,
): MarketSaleTerminalExposure {
  if (!isValidExposure(value)) {
    return {
      reservedAmount: current.reservedAmount,
      blocked: true,
    };
  }
  if (current.reservedAmount > Number.MAX_SAFE_INTEGER - value) {
    return {
      reservedAmount: Number.MAX_SAFE_INTEGER,
      blocked: true,
    };
  }
  return {
    reservedAmount: current.reservedAmount + value,
    blocked: current.blocked,
  };
}

/**
 * 汇总一个精确 room/resource 对的已确认托管订单与创建中订单暴露量。
 *
 * 其它房间、其它资源以及没有进入自动化 data 的手工订单不会被计入。
 * 只有能够精确归属到目标 room/resource 的损坏记录才会触发 fail-closed。
 */
export function summarizeMarketSaleTerminalExposure(
  automationData: unknown,
  roomName: string,
  resourceType: ResourceConstant,
): MarketSaleTerminalExposure {
  let result: MarketSaleTerminalExposure = {
    reservedAmount: 0,
    blocked: false,
  };
  if (automationData === undefined) return result;
  if (!isRecord(automationData)) {
    return { reservedAmount: 0, blocked: true };
  }

  const managedOrders = automationData.managedOrders;
  if (!isRecord(managedOrders)) {
    return { reservedAmount: 0, blocked: true };
  }
  for (const managed of Object.values(managedOrders)) {
    if (
      !isRecord(managed) ||
      !isValidRoomName(managed.roomName) ||
      !isValidResourceType(managed.resourceType)
    ) {
      return {
        reservedAmount: result.reservedAmount,
        blocked: true,
      };
    }
    if (
      managed.roomName !== roomName ||
      managed.resourceType !== resourceType
    ) {
      continue;
    }
    result = addExposure(result, managed.remainingExposure);
  }

  const pendingCreate = automationData.pendingCreate;
  if (pendingCreate !== undefined) {
    if (!isRecord(pendingCreate) || !isRecord(pendingCreate.tuple)) {
      return {
        reservedAmount: result.reservedAmount,
        blocked: true,
      };
    }
    const tuple = pendingCreate.tuple;
    if (
      !isValidRoomName(tuple.roomName) ||
      !isValidResourceType(tuple.resourceType)
    ) {
      return {
        reservedAmount: result.reservedAmount,
        blocked: true,
      };
    }
    if (
      tuple.roomName === roomName &&
      tuple.resourceType === resourceType
    ) {
      if (tuple.type !== ORDER_SELL) {
        return {
          reservedAmount: result.reservedAmount,
          blocked: true,
        };
      }
      result = addExposure(result, pendingCreate.exposure);
    }
  }

  return result;
}

export function getMarketSaleTerminalExposure(
  roomName: string,
  resourceType: ResourceConstant,
): MarketSaleTerminalExposure {
  return summarizeMarketSaleTerminalExposure(
    Memory.data?.marketSaleAutomation,
    roomName,
    resourceType,
  );
}

function syncReservationTick(): void {
  if (reservationTick === Game.time && reservationGame === Game) return;
  reservationTick = Game.time;
  reservationGame = Game;
  inFlightTerminalAmounts.clear();
}

function getTerminalReservationKey(
  terminal: StructureTerminal,
  roomName: string,
  resourceType: ResourceConstant,
): string {
  const id = (terminal as StructureTerminal & { id?: unknown }).id;
  const terminalKey = typeof id === "string" && id.length > 0
    ? `id:${id}`
    : `room:${roomName}`;
  return `${terminalKey}:${resourceType}`;
}

function inspectTerminalAmountOutsideMarketSaleExposure(
  terminal: StructureTerminal,
  resourceType: ResourceConstant,
  roomName: string | undefined,
): TerminalAmountInspection | null {
  if (!roomName) return null;
  syncReservationTick();

  const exposure = getMarketSaleTerminalExposure(roomName, resourceType);
  if (exposure.blocked) return null;

  const stored = terminal.store.getUsedCapacity(resourceType);
  if (!Number.isFinite(stored) || stored <= 0) return null;

  const reservationKey = getTerminalReservationKey(
    terminal,
    roomName,
    resourceType,
  );
  const inFlightAmount = inFlightTerminalAmounts.get(reservationKey) || 0;
  return {
    availableAmount: Math.max(
      0,
      Math.floor(stored) - exposure.reservedAmount - inFlightAmount,
    ),
    reservationKey,
    requiresReservation:
      exposure.reservedAmount > 0 || inFlightAmount > 0,
  };
}

function reserveTerminalAmounts(
  entries: TerminalAmountReservationEntry[],
): () => void {
  const reservedAtTick = Game.time;
  const reservedInGame = Game;
  for (const entry of entries) {
    inFlightTerminalAmounts.set(
      entry.key,
      (inFlightTerminalAmounts.get(entry.key) || 0) + entry.amount,
    );
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (
      reservationTick !== reservedAtTick ||
      reservationGame !== reservedInGame
    ) {
      return;
    }
    for (const entry of entries) {
      const nextAmount =
        (inFlightTerminalAmounts.get(entry.key) || 0) - entry.amount;
      if (nextAmount > 0) {
        inFlightTerminalAmounts.set(entry.key, nextAmount);
      } else {
        inFlightTerminalAmounts.delete(entry.key);
      }
    }
  };
}

/**
 * 当前 tick 可由 carrier/send 消耗的 Terminal 数量。
 * blocked 表示精确匹配的账本损坏，因此返回 0。同 tick 已接受、但尚未反映
 * 到 store 快照的 carrier/send intent 也会从可用量中扣除。
 */
export function getTerminalAmountOutsideMarketSaleExposure(
  terminal: StructureTerminal,
  resourceType: ResourceConstant,
  roomName: string | undefined = (
    terminal as StructureTerminal & { room?: Room }
  ).room?.name,
): number {
  const inspection = inspectTerminalAmountOutsideMarketSaleExposure(
    terminal,
    resourceType,
    roomName,
  );
  return inspection?.availableAmount || 0;
}

/**
 * 为 carrier 原子领取当前 tick 可安全 withdraw 的数量。
 *
 * 返回量允许按剩余安全数量缩小，以保持 carrier 既有的部分取货语义。没有
 * 市场 exposure 时不写入预留账本，正常取货行为保持不变。
 */
export function claimTerminalAmountOutsideMarketSaleExposure(
  terminal: StructureTerminal,
  resourceType: ResourceConstant,
  requestedAmount: number,
  roomName: string | undefined = (
    terminal as StructureTerminal & { room?: Room }
  ).room?.name,
): TerminalAmountOutsideMarketSaleExposureClaim | null {
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
    return null;
  }
  const inspection = inspectTerminalAmountOutsideMarketSaleExposure(
    terminal,
    resourceType,
    roomName,
  );
  if (!inspection) return null;

  const amount = Math.min(requestedAmount, inspection.availableAmount);
  if (amount <= 0) return null;
  const release = reserveTerminalAmounts(
    inspection.requiresReservation
      ? [{ key: inspection.reservationKey, amount }]
      : [],
  );
  return { amount, release };
}

/**
 * 在 terminal.send 写 intent 前，一次性领取货物与 energy fee 的安全量。
 *
 * 非 energy 发送会对两种资源进行 all-or-none 原子校验；energy 发送则合并
 * amount 与 transactionCost，避免同一维度被拆开校验。任一资源不足都不
 * 写入预留。没有对应市场 exposure 的资源只校验真实 store，不改变正常
 * 同 tick 行为。
 */
export function claimTerminalSendOutsideMarketSaleExposure(
  terminal: StructureTerminal,
  resourceType: ResourceConstant,
  amount: number,
  transactionCost: number,
): TerminalSendOutsideMarketSaleExposureClaim | null {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(transactionCost) ||
    transactionCost < 0
  ) {
    return null;
  }

  const requests = new Map<ResourceConstant, number>();
  requests.set(resourceType, amount);
  if (transactionCost > 0) {
    const currentEnergy = requests.get(RESOURCE_ENERGY) || 0;
    if (currentEnergy > Number.MAX_SAFE_INTEGER - transactionCost) {
      return null;
    }
    requests.set(RESOURCE_ENERGY, currentEnergy + transactionCost);
  }

  const entries: TerminalAmountReservationEntry[] = [];
  for (const [requestedResource, requestedAmount] of requests) {
    const inspection = inspectTerminalAmountOutsideMarketSaleExposure(
      terminal,
      requestedResource,
      terminal.room?.name,
    );
    if (
      !inspection ||
      requestedAmount > inspection.availableAmount
    ) {
      return null;
    }
    if (inspection.requiresReservation) {
      entries.push({
        key: inspection.reservationKey,
        amount: requestedAmount,
      });
    }
  }

  return {
    release: reserveTerminalAmounts(entries),
  };
}

/**
 * 在最终调用 terminal.send 前，以真实 Terminal store 与最新交易费再做一次
 * TOCTOU 检查。非 energy 发送也不能消耗被卖单锁定的 energy。
 */
export function canTerminalSendPreserveMarketSaleExposure(
  terminal: StructureTerminal,
  resourceType: ResourceConstant,
  amount: number,
  transactionCost: number,
): boolean {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(transactionCost) ||
    transactionCost < 0
  ) {
    return false;
  }

  const resourceAvailable = getTerminalAmountOutsideMarketSaleExposure(
    terminal,
    resourceType,
  );
  if (resourceType === RESOURCE_ENERGY) {
    return amount + transactionCost <= resourceAvailable;
  }

  const energyAvailable = getTerminalAmountOutsideMarketSaleExposure(
    terminal,
    RESOURCE_ENERGY,
  );
  return amount <= resourceAvailable && transactionCost <= energyAvailable;
}

export function clearMarketSaleExposureReservationsForTest(): void {
  reservationTick = undefined;
  reservationGame = undefined;
  inFlightTerminalAmounts.clear();
}

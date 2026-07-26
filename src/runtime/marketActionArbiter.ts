/**
 * 市场写操作与主动 Terminal 动作的唯一网关。
 *
 * 该模块只负责当 tick 仲裁和调用 Screeps 写 API；订单归属、费用预算、
 * pending mutation 等跨 tick 协议由上层市场自动化负责。
 */

import { claimTerminalSendOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";

export type TerminalActionKind = "market_deal" | "terminal_send";

export interface TerminalActionClaim {
  roomName: string;
  tick: number;
  actor: string;
  kind: TerminalActionKind;
}

type CreateOrderParams = Parameters<Market["createOrder"]>[0];

export interface TerminalSendRequest {
  terminal: StructureTerminal;
  resourceType: ResourceConstant;
  amount: number;
  transactionCost: number;
  destinationRoomName: string;
  actor: string;
  description?: string;
}

let claimTick: number | undefined;
let claimGame: Game | undefined;
const terminalClaims = new Map<string, TerminalActionClaim>();
const terminalActionsInFlight = new Set<string>();

function syncClaimTick(): void {
  if (claimTick === Game.time && claimGame === Game) return;
  claimTick = Game.time;
  claimGame = Game;
  terminalClaims.clear();
  terminalActionsInFlight.clear();
}

function storeTerminalClaim(
  roomName: string,
  actor: string,
  kind: TerminalActionKind,
): void {
  terminalClaims.set(roomName, {
    roomName,
    tick: Game.time,
    actor,
    kind,
  });
}

export function getTerminalActionClaim(roomName: string): TerminalActionClaim | undefined {
  syncClaimTick();
  const claim = terminalClaims.get(roomName);
  return claim ? { ...claim } : undefined;
}

export function getTerminalActionClaims(): TerminalActionClaim[] {
  syncClaimTick();
  return Array.from(terminalClaims.values(), claim => ({ ...claim }));
}

export function hasTerminalActionClaim(roomName: string): boolean {
  syncClaimTick();
  return terminalClaims.has(roomName);
}

/**
 * 将任意需要 Terminal 主动执行的动作纳入同一房间、同一 tick 的独占仲裁。
 * 只有底层动作返回 OK 时才记录 claim；失败和异常不会占用该房间。
 */
export function executeTerminalAction(
  roomName: string,
  actor: string,
  kind: TerminalActionKind,
  action: () => ScreepsReturnCode,
): ScreepsReturnCode {
  syncClaimTick();
  if (terminalClaims.has(roomName) || terminalActionsInFlight.has(roomName)) return ERR_BUSY;

  terminalActionsInFlight.add(roomName);
  try {
    const code = action();
    if (code === OK) {
      storeTerminalClaim(roomName, actor, kind);
    }
    return code;
  } finally {
    terminalActionsInFlight.delete(roomName);
  }
}

export function executeMarketDeal(
  orderId: string,
  amount: number,
  roomName: string,
  actor: string,
): ScreepsReturnCode {
  return executeTerminalAction(
    roomName,
    actor,
    "market_deal",
    () => Game.market.deal(orderId, amount, roomName),
  );
}

export function executeTerminalSend(
  request: TerminalSendRequest,
): ScreepsReturnCode {
  const exposureClaim = claimTerminalSendOutsideMarketSaleExposure(
    request.terminal,
    request.resourceType,
    request.amount,
    request.transactionCost,
  );
  if (!exposureClaim) return ERR_NOT_ENOUGH_RESOURCES;

  try {
    const code = executeTerminalAction(
      request.terminal.room.name,
      request.actor,
      "terminal_send",
      () =>
        request.terminal.send(
          request.resourceType,
          request.amount,
          request.destinationRoomName,
          request.description,
        ),
    );
    if (code !== OK) {
      exposureClaim.release();
    }
    return code;
  } catch (error) {
    exposureClaim.release();
    throw error;
  }
}

export function executeCreateOrder(params: CreateOrderParams): ScreepsReturnCode {
  return Game.market.createOrder(params);
}

export function executeExtendOrder(orderId: string, addAmount: number): ScreepsReturnCode {
  return Game.market.extendOrder(orderId, addAmount);
}

export function executeChangeOrderPrice(orderId: string, newPrice: number): ScreepsReturnCode {
  return Game.market.changeOrderPrice(orderId, newPrice);
}

export function executeCancelOrder(orderId: string): ScreepsReturnCode {
  return Game.market.cancelOrder(orderId);
}

export function clearMarketActionArbiterForTest(): void {
  claimTick = undefined;
  claimGame = undefined;
  terminalClaims.clear();
  terminalActionsInFlight.clear();
}

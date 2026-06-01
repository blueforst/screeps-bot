import {
  cancelResourceTransferTask,
  type CreateResourceTransferTaskResult,
  createResourceTransferTask,
  listResourceTransferTasks,
} from "@/runtime/logistics/resourceTransferTasks";

export type ManualResourceTransferRequest =
  | [toRoomName: string, resource: ResourceConstant, amount: number, reason?: string]
  | {
      toRoomName: string;
      resource: ResourceConstant;
      amount: number;
      reason?: string;
    };

export interface AddResourceTransferTasksResult {
  ok: true;
  fromRoomName: string;
  created: CreateResourceTransferTaskResult["task"][];
  errors: Array<{
    index: number;
    request: ManualResourceTransferRequest;
    error: string;
  }>;
}

export function addResourceTransferTaskRaw(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): ReturnType<typeof createResourceTransferTask> {
  return createResourceTransferTask(fromRoomName, toRoomName, resource, amount, reason);
}

export function addResourceTransferTaskCommand(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason?: string,
): string {
  return JSON.stringify(addResourceTransferTaskRaw(fromRoomName, toRoomName, resource, amount, reason));
}

function normalizeManualTransferRequest(
  request: ManualResourceTransferRequest,
  defaultReason?: string,
): {
  toRoomName: string;
  resource: ResourceConstant;
  amount: number;
  reason?: string;
} {
  if (Array.isArray(request)) {
    return {
      toRoomName: request[0],
      resource: request[1],
      amount: request[2],
      reason: request[3] ?? defaultReason,
    };
  }

  return {
    toRoomName: request.toRoomName,
    resource: request.resource,
    amount: request.amount,
    reason: request.reason ?? defaultReason,
  };
}

export function addResourceTransferTasksRaw(
  fromRoomName: string,
  requests: ManualResourceTransferRequest[],
  reason?: string,
): AddResourceTransferTasksResult | string {
  if (!Array.isArray(requests)) {
    return "ERR_INVALID_REQUESTS";
  }

  const result: AddResourceTransferTasksResult = {
    ok: true,
    fromRoomName,
    created: [],
    errors: [],
  };

  requests.forEach((request, index) => {
    const normalized = normalizeManualTransferRequest(request, reason);
    const taskResult = createResourceTransferTask(
      fromRoomName,
      normalized.toRoomName,
      normalized.resource,
      normalized.amount,
      normalized.reason,
    );
    if (typeof taskResult === "string") {
      result.errors.push({ index, request, error: taskResult });
      return;
    }

    result.created.push(taskResult.task);
  });

  return result;
}

export function addResourceTransferTasksCommand(
  fromRoomName: string,
  requests: ManualResourceTransferRequest[],
  reason?: string,
): string {
  return JSON.stringify(addResourceTransferTasksRaw(fromRoomName, requests, reason));
}

export function cancelResourceTransferTaskRaw(taskId: string): ReturnType<typeof cancelResourceTransferTask> {
  return cancelResourceTransferTask(taskId);
}

export function cancelResourceTransferTaskCommand(taskId: string): string {
  return JSON.stringify(cancelResourceTransferTaskRaw(taskId));
}

export function listResourceTransferTasksRaw(): ReturnType<typeof listResourceTransferTasks> {
  return listResourceTransferTasks();
}

export function listResourceTransferTasksCommand(): string {
  return JSON.stringify(listResourceTransferTasksRaw());
}

export function registerResourceTransferConsoleCommands(): void {
  global.addResourceTransferTask = addResourceTransferTaskCommand;
  global.addResourceTransferTaskRaw = addResourceTransferTaskRaw;
  global.addResourceTransferTasks = addResourceTransferTasksCommand;
  global.addResourceTransferTasksRaw = addResourceTransferTasksRaw;
  global.cancelResourceTransferTask = cancelResourceTransferTaskCommand;
  global.cancelResourceTransferTaskRaw = cancelResourceTransferTaskRaw;
  global.listResourceTransferTasks = listResourceTransferTasksCommand;
  global.listResourceTransferTasksRaw = listResourceTransferTasksRaw;
}

import {
  cancelResourceTransferTask,
  createResourceTransferTask,
  listResourceTransferTasks,
} from "@/runtime/logistics/resourceTransferTasks";

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
  global.cancelResourceTransferTask = cancelResourceTransferTaskCommand;
  global.cancelResourceTransferTaskRaw = cancelResourceTransferTaskRaw;
  global.listResourceTransferTasks = listResourceTransferTasksCommand;
  global.listResourceTransferTasksRaw = listResourceTransferTasksRaw;
}

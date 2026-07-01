import {
  addFactoryTask,
  cancelFactoryTask,
  listFactoryTasks,
  type AddFactoryTaskResult,
  type CancelFactoryTaskResult,
  type FactoryTask,
} from "@/runtime/factoryControl";

export function addFactoryTaskRaw(
  roomName: string,
  type: "decompress_battery",
  amount: number,
): AddFactoryTaskResult | string {
  return addFactoryTask(roomName, type, { amount });
}

export function addFactoryTaskCommand(
  roomName: string,
  type: "decompress_battery",
  amount: number,
): string {
  return JSON.stringify(addFactoryTaskRaw(roomName, type, amount), null, 2);
}

export function decompressBatteryRaw(roomName: string, amount: number): AddFactoryTaskResult | string {
  return addFactoryTaskRaw(roomName, "decompress_battery", amount);
}

export function decompressBatteryCommand(roomName: string, amount: number): string {
  return JSON.stringify(decompressBatteryRaw(roomName, amount), null, 2);
}

export function cancelFactoryTaskRaw(taskId: string): CancelFactoryTaskResult | string {
  return cancelFactoryTask(taskId);
}

export function cancelFactoryTaskCommand(taskId: string): string {
  return JSON.stringify(cancelFactoryTaskRaw(taskId), null, 2);
}

export function listFactoryTasksRaw(roomName?: string): FactoryTask[] {
  return listFactoryTasks(roomName);
}

export function listFactoryTasksCommand(roomName?: string): string {
  return JSON.stringify(listFactoryTasksRaw(roomName), null, 2);
}

export function registerFactoryTaskConsoleCommands(): void {
  global.addFactoryTask = addFactoryTaskCommand;
  global.addFactoryTaskRaw = addFactoryTaskRaw;
  global.decompressBattery = decompressBatteryCommand;
  global.decompressBatteryRaw = decompressBatteryRaw;
  global.cancelFactoryTask = cancelFactoryTaskCommand;
  global.cancelFactoryTaskRaw = cancelFactoryTaskRaw;
  global.listFactoryTasks = listFactoryTasksCommand;
  global.listFactoryTasksRaw = listFactoryTasksRaw;
}

import {
  cpuMonitorCommand,
  cpuMonitorRaw,
  registerCpuProfilerConsoleCommands,
  startCpuProfiler,
  startCpuProfilerCommand,
  startCpuProfilerRaw,
  statusCpuProfilerCommand,
  statusCpuProfilerRaw,
  stopCpuProfilerCommand,
  stopCpuProfilerExport,
  stopCpuProfilerRaw,
} from "@/runtime/console/cpuProfilerCommands";
import {
  registerOperationsConsoleCommands,
  spawnMaxCarrier,
  spawnMaxCarrierCommand,
  spawnMaxCarrierRaw,
  stopColonization,
  stopColonizationCommand,
  stopColonizationRaw,
} from "@/runtime/console/operationsCommands";
import {
  registerTelemetryConsoleCommands,
  startTelemetry,
  startTelemetryCommand,
  startTelemetryRaw,
  statusTelemetryCommand,
  statusTelemetryRaw,
  stopTelemetryCommand,
  stopTelemetryExport,
  stopTelemetryRaw,
} from "@/runtime/console/telemetryCommands";
import {
  addResourceTransferTaskCommand,
  addResourceTransferTaskRaw,
  cancelResourceTransferTaskCommand,
  cancelResourceTransferTaskRaw,
  listResourceTransferTasksCommand,
  listResourceTransferTasksRaw,
  registerResourceTransferConsoleCommands,
} from "@/runtime/console/resourceTransferCommands";

interface SynthesisControlStatusResult {
  ok: true;
  enabled: boolean;
  state:
    | {
        updatedAt: number;
        generatedTaskCount: number;
        failedTaskCount: number;
        successfulRunCount: number;
        lastActions: string[];
      }
    | null;
}

export function statusSynthesisControlRaw(): SynthesisControlStatusResult {
  const state = Memory.runtime?.synthesisControl;
  return {
    ok: true,
    enabled: Memory.cfg?.synthesisControl?.enabled === true,
    state: state
      ? {
          updatedAt: state.updatedAt,
          generatedTaskCount: state.generatedTaskCount,
          failedTaskCount: state.failedTaskCount,
          successfulRunCount: state.successfulRunCount,
          lastActions: state.lastActions,
        }
      : null,
  };
}

export function statusSynthesisControlCommand(): string {
  return JSON.stringify(statusSynthesisControlRaw());
}

export function registerConsoleCommands(): void {
  registerOperationsConsoleCommands();
  registerTelemetryConsoleCommands();
  registerCpuProfilerConsoleCommands();
  global.statusSynthesisControl = statusSynthesisControlCommand;
  global.statusSynthesisControlRaw = statusSynthesisControlRaw;
  registerResourceTransferConsoleCommands();
}

export {
  addResourceTransferTaskCommand,
  addResourceTransferTaskRaw,
  cpuMonitorCommand,
  cpuMonitorRaw,
  cancelResourceTransferTaskCommand,
  cancelResourceTransferTaskRaw,
  listResourceTransferTasksCommand,
  listResourceTransferTasksRaw,
  spawnMaxCarrier,
  spawnMaxCarrierCommand,
  spawnMaxCarrierRaw,
  startCpuProfiler,
  startCpuProfilerCommand,
  startCpuProfilerRaw,
  statusCpuProfilerCommand,
  statusCpuProfilerRaw,
  stopCpuProfilerCommand,
  stopCpuProfilerExport,
  stopCpuProfilerRaw,
  stopColonization,
  stopColonizationCommand,
  stopColonizationRaw,
  startTelemetry,
  startTelemetryCommand,
  startTelemetryRaw,
  statusTelemetryCommand,
  statusTelemetryRaw,
  stopTelemetryCommand,
  stopTelemetryExport,
  stopTelemetryRaw,
};

## Ambient global ABI 基线

- 基线提交：`5dce4dcc1f51fb9cb881e21740c63171a404d954`
- `src/global.d.ts`：936 行 / 29,249 bytes。
- build/workspace Program 的仓库文件分别为 179 / 316。
- Jest discovery：133 suites（本变更新增架构 suite 前；新增后为 134）。
- 生产根级 `global` 写入：100 个；其中公共安装 88 个、私有 heap 状态 12 个。
- 有效 `declare global` 变量：83 个；其中已声明公共安装 79 个、Rollup 构建常量 4 个。
- 公共写入与有效声明的差集：9 个；有效声明没有多余公共项。
- `dist/main.js`：3,854,907 bytes；规范化动态 `BUILD_TAG` 后 SHA-256 为 `a7d29dbe712f25a10e6ad19425bfd7672f95e4d58672252b020e7146dabaad7e`。
- source map：182 个运行时 source，声明/测试 source 为 0。

## 精确分类

构建常量（4）：`__BUILD_VERSION__`、`__BUILD_GIT_HASH__`、`__BUILD_TIME__`、`__BUILD_TAG__`。

私有 heap 状态（12）：`__runtimeServices`、`__cpuMonitor`、`__productionSamples`、`__creepMovementState`、`__movementAnalytics`、`__carrierTaskBoard`、`__carrierTaskClaims`、`__creepAssignmentState`、`__pickupReservations`、`__workerTaskBoard`、`colours`、`roomPlanCache`。

公共安装（88）：`RP`、`__screepsMounted`、`acceptMarketBaseResourcePermit`、`acceptMarketDirectContinuousPermit`、`addFactoryTask`、`addFactoryTaskRaw`、`addResourceTransferTask`、`addResourceTransferTaskRaw`、`addResourceTransferTasks`、`addResourceTransferTasksRaw`、`attestMarketSalePendingCreate`、`cancelFactoryTask`、`cancelFactoryTaskRaw`、`cancelResourceTransferTask`、`cancelResourceTransferTaskRaw`、`clearRoomPlanCache`、`cpuMonitor`、`cpuMonitorRaw`、`creepApi`、`decompressBattery`、`decompressBatteryRaw`、`emergencyStopMarketSaleAutomation`、`expandMarketSaleCanary`、`grantMarketSaleMutationLease`、`hubProgress`、`hubProgressRaw`、`listFactoryTasks`、`listFactoryTasksRaw`、`listPlanCache`、`listResourceTransferTasks`、`listResourceTransferTasksRaw`、`marketBaseResourceStatus`、`marketDirectContinuousStatus`、`marketSaleAutomationStatus`、`memoryAudit`、`memoryAuditRaw`、`powerBankStatus`、`powerBankStatusRaw`、`proposeMarketBaseResourcePermit`、`proposeMarketDirectContinuousPermit`、`remoteDefenseStatus`、`remoteDefenseStatusRaw`、`reportProduction`、`reportProductionGlobal`、`resolveMarketSaleDirectPending`、`resolveMarketSaleExternalOrderMutation`、`resolveMarketSaleOrderDisappearance`、`resolveMarketSalePendingCreateAbsence`、`revokeMarketSaleMutationLease`、`runPlan`、`savePlanToMemory`、`spawnMaxCarrier`、`spawnMaxCarrierRaw`、`startCpuProfiler`、`startCpuProfilerRaw`、`startTelemetry`、`startTelemetryRaw`、`startUpgrader`、`startUpgraderRaw`、`startWar`、`startWarPatrol`、`startWarPatrolRaw`、`startWarRaw`、`statusCpuProfiler`、`statusCpuProfilerRaw`、`statusHub`、`statusHubRaw`、`statusSynthesisControl`、`statusSynthesisControlRaw`、`statusTelemetry`、`statusTelemetryRaw`、`stopColonization`、`stopColonizationRaw`、`stopCpuProfiler`、`stopCpuProfilerRaw`、`stopHub`、`stopHubRaw`、`stopTelemetry`、`stopTelemetryRaw`、`stopUpgrader`、`stopUpgraderRaw`、`stopWar`、`stopWarRaw`、`upgraderStatus`、`upgraderStatusRaw`、`visualizePlan`、`warStatus`、`warStatusRaw`。

缺失声明（9）：`memoryAudit`、`memoryAuditRaw`、`grantMarketSaleMutationLease`、`revokeMarketSaleMutationLease`、`attestMarketSalePendingCreate`、`resolveMarketSalePendingCreateAbsence`、`expandMarketSaleCanary`、`emergencyStopMarketSaleAutomation`、`marketSaleAutomationStatus`。

## 扫描边界

- 市场模块通过 `operatorGlobals` alias 安装 16 个公共命令；普通文本检索 `global.foo =` 会漏掉它们。
- 其他 alias 同时承载私有状态、`__screepsMounted` 与 `creepApi`，必须按 AST 追踪到 `global` 根。
- Autoplanner 的 6 个公共入口与 2 个私有缓存写入来自 `src/modules/autoplanner/planner.js`；由于 build `allowJs=false`，它们不在 TypeScript Program 中，但会进入 Rollup 图。
- 该文件只记录本 change 的前后等价性证据，不作为运行时 manifest 或长期性能 SLA。

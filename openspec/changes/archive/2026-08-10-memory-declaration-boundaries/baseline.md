## 声明拆分基线

- 基线提交：`37fc146d015f4cbc856fb7e502ec1e238526b2d6`
- `src/global.d.ts`：2,241 行 / 71,189 bytes
- build Program 仓库 root：175；声明文件仅 `src/global.d.ts`
- workspace Program 仓库 root：311；声明文件仅 `src/global.d.ts`
- Jest discovery：132 suites
- `dist/main.js`：3,854,907 bytes
- 将 `const BUILD_TAG = "..." ;` 整行规范化为 `const BUILD_TAG = "<normalized>";` 后 SHA-256：`a7d29dbe712f25a10e6ad19425bfd7672f95e4d58672252b020e7146dabaad7e`

四根一级字段基线：

- `cfg`（17）：`rooms`、`worker`、`energyPickup`、`pixelGenerator`、`roomPlannerBuild`、`productionMonitor`、`powerSpawnControl`、`crossShard`、`telemetry`、`cpuProfiler`、`synthesisControl`、`homeDefense`、`resourceControl`、`marketSaleAutomation`、`hub`、`factoryControl`、`remoteMining`
- `runtime`（22）：`lastDeployTag`、`energyPickup`、`spawnPlanner`、`roomPlannerBuild`、`linkNetwork`、`towerEmergencyRamparts`、`towerCombat`、`illegalStructureCleanup`、`defenseCoordination`、`crossShard`、`resourceControl`、`marketSaleAutomation`、`factoryControl`、`synthesisControl`、`hub`、`nukerControl`、`resourceReservations`、`powerBankBoost`、`powerBankObserver`、`remoteMining`、`transitDangerRooms`、`powerBankPermanentDangerRooms`
- `data`（15）：`creepConfigs`、`manualUpgraders`、`marketSaleAutomation`、`resourceControl`、`factoryTasks`、`colonization`、`war`、`roomPlanner`、`rescue`、`flagHauling`、`crossShardColonization`、`interShardPortals`、`powerBankHarvest`、`powerBankHarvestHistory`、`remoteMining`
- `analytics`（5）：`production`、`war`、`moduleCpu`、`cpuMonitor`、`hub`

使用 TypeScript printer 规范化每个根的全部递归类型成员（忽略纯注释）后的 SHA-256：

- `cfg`：`c95f29353e53e022c118a57f76846f0b0c4ce51c6e289658e877fd9455bb554c`
- `runtime`：`7a09d22dbd3288886abea3cf8fd52ab20853f74f1fabf4956d39c7692f2e823d`
- `data`：`a4e8565351f062f9fdb8420adade83d33517a289a4202c72df37ba4fda72681b`
- `analytics`：`8dc56bc39214dd02906c02dba674664c2a2441d01a341a7d1a4bff1993f97245`

该文件只记录前后等价性证据，不作为运行时配置或性能 SLA。

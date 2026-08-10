## 统一任务系统基础层基线

### 仓库与活动变更

- 分支：`codex/architecture-optimization`
- 基线提交：`296c052ddcf02d95ce757984ae7252ec505ab61d`
- 基线提交主题：`docs(openspec): archive role identity catalog`
- 本变更创建前生产源码无未提交修改；当时工作树仅包含本 OpenSpec change 的未跟踪文档。
- `openspec list --json` 中活动变更为：
  - `unified-task-system-foundation`：0/40
  - `decentralized-logistics-contracts`：0/48
  - `market-base-resource-all-rooms`：43/48
  - `terminal-headroom-recovery`：37/38
  - `market-scope-core-read-cpu`：6/9
  - `market-production-donor-contract`：无 tasks
  - `market-direct-continuous`：41/45
  - `operational-area-p0`：0/60
  - `entity-streaming-hysteresis`：0/40

`decentralized-logistics-contracts` 是本变更的直接设计重叠边界：它继续独占 `TransferContract`、`CapacityLease`、`StageWorkClaim`、`RoomLogisticsAgent`、matcher 与 terminal executor；本变更只提供现有工作模型的只读分类和状态投影。

### 十三类来源与真实职责

| Canonical system | 基线事实源 | 真实职责 |
|---|---|---|
| `worker-work` | `global.__workerTaskBoard` | 每3 tick 从 Game 事实重建的房间派工视图 |
| `carrier-logistics` | `global.__carrierTaskBoard` | producer+room 整包替换的本地运输视图 |
| `power-creep-action` | `PowerCreep.memory.tasks` | 单 actor 持久优先队列 |
| `resource-transfer` | `Memory.data.resourceControl.tasks` | 可部分完成、阻塞和重试的持久定量命令 |
| `factory-command` | `Memory.data.factoryTasks` | Factory 领域命令及状态机 |
| `remote-mining-workflow` | `Memory.data.remoteMining` | 长期房间经营工作流 |
| `colonization-workflow` | `Memory.data.colonization` | 侦察、清场、占领、规划、援建与交接工作流 |
| `rescue-workflow` | `Memory.data.rescue` | Spawn 丢失房间的持续援建工作流 |
| `flag-hauling-workflow` | `Memory.data.flagHauling` | Flag 驱动的远程搬运工作流 |
| `cross-shard-colonization-workflow` | `Memory.data.crossShardColonization` | Portal、跨 shard 运输与占领工作流 |
| `war-workflow` | `Memory.data.war` | 前线、Boost、代际与巡逻编排工作流 |
| `power-bank-workflow` | `Memory.data.powerBankHarvest` | deadline 下的战斗、换代和回收工作流 |
| `spawn-production` | `Memory.data.creepConfigs`、`SpawnMemory.spawnList`、native spawning/creep | 持续 actor 期望与生产管线 |

Synthesis/Hub plan、Energy pickup/resource reservation、receiver/destination ledger、terminal action claim 与 market order/WAL/pending transaction 不属于上述 Catalog。

### 主循环与 ABI

- `src/main.ts` 基线为37个受顺序约束的 phase；关键后半段保持：`refreshWorkerTasks → bootstrapRooms → remoteMining → scheduleSpawnTasks → spawnWork → creepWork`。
- `spawnWork` 保持逐房 `measureRoomPhase` wrapper，所有 role 仍由最后的 `creepWork` 驱动。
- Memory 根保持 `cfg/runtime/data/analytics` 四根；声明文件仍为 `src/global.d.ts` 与 `src/types/memory/{cfg,runtime,data,analytics}.d.ts`。
- private global 槽位基线为12个：`__runtimeServices`、`__cpuMonitor`、`__productionSamples`、`__creepMovementState`、`__movementAnalytics`、`__carrierTaskBoard`、`__carrierTaskClaims`、`__creepAssignmentState`、`__pickupReservations`、`__workerTaskBoard`、`colours`、`roomPlanCache`。
- 本切片不得新增 Memory 根、private/public global、main phase、console ABI 或 mutation API。

### Rollup 产物

- `npm run build`：通过。
- `dist/main.js`：3,864,391 bytes。
- 将唯一动态行 `const BUILD_TAG = "..." ;` 规范化为 `const BUILD_TAG = "<normalized>";` 后 SHA-256：`76b780138cb930c1927fec83a7c89e3f99712f6870bbd053d9bfb3959379a298`。
- `dist/main.js.map.js`：184个运行时 source；`.d.ts`、测试 source 为0。

该摘要只用于本 change 的前后等价性验证，不是线上性能或文件大小 SLA。

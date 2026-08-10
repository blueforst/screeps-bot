## Context

当前仓库至少有十三套会被维护者称为“任务系统”的运行模型，但它们的真实职责不同：

| 系统 | 当前事实源 | 真实模型 | 当前完成/撤销语义 |
|---|---|---|---|
| Worker | `global.__workerTaskBoard` | 每3 tick 从 Game 事实重建的房间派工视图 | producer 下轮不再发布后消失；role 只释放 assignee |
| Carrier | `global.__carrierTaskBoard` | producer+room 整包替换的本地运输视图 | carrier 不推进 task；producer 重观测物理库存后缩量/删除 |
| PowerCreep | `PowerCreep.memory.tasks` | 单 actor 持久优先队列 | 成功、失效或过时后从 actor queue 删除 |
| ResourceTransfer | `Memory.data.resourceControl.tasks` | 可部分完成、阻塞和重试的持久定量命令 | `terminal.send(OK)` 才推进 remaining；终态按 TTL 清理 |
| Factory | `Memory.data.factoryTasks` | Factory 领域命令及状态机 | Factory manager 转换 loading/producing/unloading/terminal |
| RemoteMining | `Memory.data.remoteMining` | 长期房间经营工作流 | scouting/active/suspended/defending/abandoned 由领域条件转换 |
| Colonization | `Memory.data.colonization` | 侦察、清场、占领、规划、援建与交接工作流 | 由 controller/plan/workforce 事实决定完成 |
| Rescue | `Memory.data.rescue` | Spawn 丢失房间的持续援建工作流 | Spawn 重建且达到门槛后先停产再自然 drain |
| FlagHauling | `Memory.data.flagHauling` | Flag 驱动的远程搬运工作流 | 旗帜/资源/cargo 事实共同决定清理 |
| CrossShardColonization | `Memory.data.crossShardColonization` | Portal、跨 shard 运输与占领工作流 | 多阶段持久状态机及独立 retry |
| War | `Memory.data.war` | 前线、Boost、代际与巡逻编排工作流 | 战争领域负责生产停止、成员退役与终态 |
| PowerBank | `Memory.data.powerBankHarvest` | 绝对 deadline 下的战斗、换代和回收工作流 | 终态同 tick 释放 owner 资产、写有界历史并删除 active task |
| Spawn Production | `Memory.data.creepConfigs` + `SpawnMemory.spawnList` + native spawning/creep | 持续 actor 期望与生产管线 | spawn 成功只确认一次生产，不终结普通 config |

此外，Synthesis/Hub 的 reaction/route/allocation 是计划，Energy pickup、resource reservation、receiver ledger 与 terminal action claim 是授权或互斥机制，市场 pending/WAL/order 是金融事务。这些模型可以引用 task identity，但不是另一种通用 Task record。

现有主循环还建立了行为相关的可见性顺序：Hub 先写计划，Synthesis/Factory 发布本地物流，ResourceControl 执行跨房动作；Worker refresh 位于 bootstrap 之前，RemoteMining 位于 Spawn planning 之前；所有 role 最后执行。该37 phase 顺序已有正式规格保护，本变更不能通过新增统一 runner 改写它。

`decentralized-logistics-contracts` 已经规划 `Intent → TransferContract → CapacityLease → StageWorkClaim → RoomLogisticsAgent`，但目前仍为0/48且尚无运行时代码。本基础层必须能投影现有 ResourceTransfer v2 与未来合同状态，同时不得再设计一套竞争的 matcher、lease 或 terminal executor。

审计还发现 War owner 清理、standard 配对、oneShot generation loss、RemoteMining abandoned retry、Factory failed protection 等既有歧义。本变更只如实投影来源状态；若统一层替领域决定终态或清理策略，会把这些缺口误固化成公共合同。

## Goals / Non-Goals

**Goals:**

- 给所有运行工作模型一个无碰撞的 canonical system identity 和结构化 `WorkRef`。
- 显式描述每个系统的模型类别、durability、scope、reconcile、authority/claim 与 owner 边界。
- 提供一个确定性、无副作用、可处理 legacy/malformed/reset 状态的只读 projection 入口。
- 让后续迁移以 adapter 为界，分别演进 heap dispatch、持久命令、领域 workflow 和 production intent。
- 用架构门禁阻止统一层成为第二状态源、全局调度器或领域策略容器。
- 保持现有 phase、Memory wire、private/global ABI、console ABI、priority、producer、executor、cleanup 与 role 行为不变。

**Non-Goals:**

- 不创建一个包含所有可选字段的巨型 `Task` 联合或全局 `Task[]` store。
- 不规定统一的 `pending/assigned/running/blocked/done` 持久状态机。
- 不提供通用 `execute`、`cancel`、`complete`、`delete`、TTL 或 asset cleanup。
- 不统一 slot claim、amount claim、capacity lease、generation membership 与 queue ownership 的实现。
- 不把 `CreepConfig`、Hub/Synthesis plan、reservation、ledger、market WAL/order 改成 Task。
- 不修复审计发现的 War、RemoteMining、Factory 或 Spawn 生命周期缺口；它们需要独立规格与行为变更。
- 不实施 `decentralized-logistics-contracts`，不改变 ResourceControl、market arbiter 或 terminal action ownership。

## Decisions

### 1. Catalog 拥有“系统分类”，领域继续拥有“业务事实”

新增无 Screeps runtime 依赖的 `TASK_SYSTEM_CATALOG`，精确登记以下 canonical IDs：

```text
worker-work
carrier-logistics
power-creep-action
resource-transfer
factory-command
remote-mining-workflow
colonization-workflow
rescue-workflow
flag-hauling-workflow
cross-shard-colonization-workflow
war-workflow
power-bank-workflow
spawn-production
```

每项只声明：

- `model`: `dispatch_projection | actor_queue | durable_command | domain_workflow | production_intent`
- `durability`: `heap | actor_memory | memory`
- `scope`: `room | actor | cross_room | shard_room | object | global`
- `reconcile`: `world_projection | owner_snapshot | actor_queue | additive_command | domain_transition | desired_actor`
- `claim`: `slot | same_tick_amount | exclusive_actor | domain_owned | queue_owner | none`
- `domainOwner`: 当前写入和生命周期 owner 的稳定名称

Catalog 不包含 body、路径、优先级数值、timeout、允许转换图、Memory path resolver 或执行函数。选择 catalog 而不是把所有字段放进基础 Task，是为了让“分类元数据”成为单一来源，同时避免出现跨领域策略中心。

`TaskSystemId` 由 Catalog own keys 派生。独立架构测试保留硬编码 expected set，不能从 Catalog 自身生成 oracle。

### 2. 公共类型使用 Work 语义，避免暗示所有记录都是可领取 Task

基础层定义以下概念，但不持久化它们：

```ts
interface WorkRef {
  system: TaskSystemId;
  namespace: string;
  scope: WorkScope;
  localId: string;
}

interface WorkAuthorityRef {
  role: "producer" | "workflow_owner" | "executor" | "assignee" | "lease_owner" | "queue_owner";
  id: string;
  generation?: number;
  component?: string;
}

interface WorkStatusView {
  ref: WorkRef;
  activity: WorkActivity;
  sourceState: string;
  authorities: readonly WorkAuthorityRef[];
  createdAt?: number;
  updatedAt?: number;
  lastProgressAt?: number;
  blocker?: string;
  retryAt?: number;
  deadlineAt?: number;
  issues: readonly WorkProjectionIssue[];
}
```

`WorkScope` 使用结构化判别联合，而不是把 room、route、shard 与 object 都编码进一个不可验证字符串。`system + namespace + canonical scope + localId` 才是统一引用；namespace 由领域 owner/producer 的稳定身份提供，不能通过解析 `localId` 反推。两个领域相同 `localId` 或 Carrier 两个 producer 相同本地 ID 不得碰撞。

`WorkAuthorityRef[]` 有意允许多个 authority。物流至少区分 producer、receiver lease owner、source executor 与 carrier claimant；把它们压成一个 `ownerId` 会丢失安全边界。

未选择通用 `TaskEnvelope<TPayload>` 作为持久数据模型，因为 Worker/Carrier 是可重建 projection，Spawn 是持续 desired actor，PowerBank/War 有 generation，ResourceTransfer 有数量守恒。公共 envelope 仅用于读取状态。

### 3. `activity` 是观测分类，不是领域状态替代品

统一 activity 只允许：

```text
desired | available | claimed | running | blocked | terminal | unknown
```

每条 projection 必须同时保留 `sourceState`。例如：

- Worker `active` 可投影为 `available` 或在有 assignee 时为 `claimed`，但来源仍为 `active`。
- Carrier board 只证明 producer 当前发布了 work；若 assignment 只有 task ID、无法证明 producer，则不得伪造 claimed。
- ResourceTransfer `pending + blockedReason` 为 `blocked`，其他 pending 为 `available`，终态保留原 `done/cancelled/failed`。
- Factory `loading/producing/unloading` 可投影为 `running`，但不能把 `failed` 是否仍保留市场保护的领域歧义抹掉。
- Spawn 同一 config 可以同时存在 desired、queued/spawning 与 live materialized 事实；adapter 必须用 issues/facts 表达重叠，不能在首次 spawn 后投影为 config terminal。

通用消费者只能使用 activity 做展示、计数和告警。调度、数量承诺、清理和行为决策必须继续读取领域 source of truth。

### 4. Adapter 只有只读 snapshot 能力

公共协议为：

```ts
interface TaskSystemAdapter<TContext = unknown> {
  readonly system: TaskSystemId;
  snapshot(context: TContext): TaskSystemAdapterResult;
}

interface TaskSystemAdapterResult {
  readonly entries: readonly WorkStatusView[];
  readonly invalidCount: number;
  readonly issues: readonly WorkProjectionIssue[];
}
```

首切片不提供 mutation method。Adapter 可以读取自己的领域 store、Game 事实或 private heap selector，但必须满足：

- 不调用 `ensure*`、不创建空 store、不写 Memory/global/creep assignment；
- 不执行 Screeps intent、console action 或市场动作；
- 对缺失 store/global reset 返回空集合和明确的 system summary，而非创建默认事实；
- 对 malformed record fail-closed：保留可证明的 ref，activity 为 `unknown` 并输出 issue；无法证明 ref 时只增加 system-level invalid count；
- 单次 snapshot 对每个来源至多线性扫描一次，不做房间×任务×actor 的无界全表联接；
- 输出对象不可供调用方反向修改来源记录。

为满足只读要求，Worker/Carrier 可新增 `peek*` selector；现有 `get*`、replace、assign 和 cleanup API 不改名、不改行为。

未选择统一 repository 是因为现有写语义并不兼容：Carrier 是 replace-owned-snapshot，ResourceTransfer/Factory 重复提交会加量，Workflow 显式转换，Spawn config 是 desired state。一个通用 `upsert()` 会让调用方误以为它们具有相同幂等含义。

### 5. 聚合器静态组合 adapter，返回确定性 snapshot

高层 `collectTaskSystemSnapshot(context)` 静态组合十三个 adapter，返回：

- `observedAt` 与 source shard/tick；
- 每个 Catalog system 都存在的 summary，即使 count 为0或 store 缺失；
- 按 `system → namespace → canonical scope → localId` 稳定排序的 entries；
- activity/sourceState/issue 计数；
- adapter 读取失败或 malformed 输入的有界 diagnostics。

单个 adapter 异常必须被标为该 system 的 snapshot failure，不能用半份记录伪装成功，也不能阻止其他只读 adapter 输出。聚合器本身不缓存跨 phase 事实，防止把某个 phase 的旧 projection 重新用于后续调度。

第一切片只提供内部只读入口和测试，不新增 main phase、global console API 或 Memory store。这样可以在不改变线上行为的前提下建立后续迁移边界；将 snapshot 接入 monitor/console 必须单独评估采样 phase、CPU 和 ABI。

### 6. 依赖方向阻止 projection 反向控制领域

目录依赖固定为：

```text
taskSystem/model + taskSystem/catalog
                 ↑
taskSystem/adapters/*  ←  domain readonly selectors / Memory / Game
                 ↑
taskSystem/snapshot
                 ↑
future telemetry / console reader
```

生产者、planner、role、cleanup、spawn executor 与市场 executor 不得导入 `taskSystem/snapshot` 或 adapter。领域模块最多导入纯 `WorkRef/authority` 类型，且本切片不要求它们这样做。

这一方向让 projection 保持 observation-only。若未来某领域需要通用 owner reconciliation，必须新增独立 mutation port，并由领域规格定义其事务和 rollback，不能向当前 adapter 偷加写方法。

### 7. 明确与 Logistics、Spawn、Plan 和 Claim 的边界

- `decentralized-logistics-contracts` 仍拥有 Intent revision、TransferContract 数量守恒、CapacityLease、StageWorkClaim、Matcher 与 RoomLogisticsAgent。统一层只为这些对象提供未来 projection capability。
- Spawn adapter 只组合 config、queue、native spawning 与 live refs；`CreepConfig`/`spawnList:string[]` wire 不变，spawn success 不等于普通 config terminal。
- Synthesis/Hub plan 可作为 workflow 的 `planRef` 或 authority 事实展示，但不注册为可执行 task system。
- Energy/resource reservation、receiver ledger、terminal claim 是 authorization primitives；它们可以被 projection 统计，但不拥有独立 Task lifecycle。
- Market order/WAL/pending mutation/deal 不进入 catalog；市场需要 exact reconciliation 和账户级互斥，不能由通用 task cleanup 管理。

### 8. 先冻结现状，再让后续 change 逐类迁移

本切片只做 foundation。后续建议顺序为：

1. `local-dispatch-ownership`：在完整 characterization 后统一 Worker/Carrier 的 namespaced owner-scope identity 与只读 board API；slot claim 和 amount claim 仍分层。
2. `workflow-owned-assets`：为 Colonization/Rescue/RemoteMining/War/PowerBank 建立显式 child-config/queue/Boost/transfer owner 与幂等 release hook；先解决 War 现状歧义。
3. `decentralized-logistics-contracts`：按其独立规格实施持久 contract/lease/stage claim；adapter 由 v2 切换到 contract projection。
4. `task-system-observability`：在确定采样 phase 和 CPU 预算后接入 monitor/console，保留 projection 非状态源原则。

没有采用“一次迁完全部系统”，因为一次同时改变 store、assignment、workflow cleanup 与 terminal ownership无法建立可归因 rollback。

## Risks / Trade-offs

- **[Catalog 变成另一张易漂移清单]** → `TaskSystemId` 从 Catalog keys 派生；独立硬编码 oracle、adapter coverage 和架构扫描共同门禁，新增系统必须同时声明分类和 adapter。
- **[统一 activity 掩盖领域差异]** → `sourceState` 必填，activity 明确只用于观测；projection 不含通用 transition/cancel API。
- **[只读 getter 实际创建 store]** → adapter 禁止使用 ensure/mutate-on-read API；测试比较调用前后 Memory、private global keys 和来源对象 identity。
- **[投影被调度器反向读取]** → 静态 import-boundary 测试禁止 producer/planner/role/cleanup/executor 导入 snapshot/adapters。
- **[全量 snapshot 增加 CPU]** → 首切片不接入 tick loop；每个 adapter 线性扫描一次并输出有界 diagnostics，未来接入另设采样/CPU gate。
- **[现存 lifecycle bug 被误当标准]** → adapter 保留 raw sourceState/issues，不为 War、RemoteMining、Factory 或 Spawn 推断新的终态/重试/清理合同。
- **[与物流 change 重复建设]** → Catalog 标注 ResourceTransfer 为领域 command/contract；统一层不得定义物流 lease、matcher、容量或 terminal executor。
- **[新增抽象暂时没有生产消费者]** → 这是有意的关闭态 foundation；用完整 adapter fixture 和后续 change 的稳定依赖面换取零线上行为变化，并以 bundle 等价性验证。

## Migration Plan

1. 先增加现有十三类系统的独立分类 oracle、关键行为 characterization 和 import-boundary 失败测试。
2. 实现纯 `model` 与 `TASK_SYSTEM_CATALOG`，证明其不读取 Screeps globals、不导入领域 runtime。
3. 为 Worker/Carrier 补无副作用 peek selector；实现十三个 source adapter，保持所有原写 API 和底层 shape。
4. 实现确定性 snapshot/summary，覆盖缺失 store、global reset、malformed record、ID 碰撞、零记录和多 authority fixture。
5. 运行 adapter/来源模块聚焦测试、双 TypeScript、全量 Jest、Rollup build、OpenSpec strict 和 diff check。
6. 比较规范化 bundle；若新增 foundation 未被生产入口引用，bundle 必须保持等价且无需部署。若 Rollup 意外保留代码或发生生产字节变化，停止归档并查明入口/side effect。
7. 同步主规格并归档；后续行为迁移各自建立 OpenSpec change。

回滚只需移除新目录、测试和新增 peek selector；由于不迁移 Memory/global wire、不切换写入口、不部署运行时状态，不需要线上数据回滚。

## Open Questions

无阻塞问题。统一 snapshot 何时接入 monitor/console、各 workflow 的 owner cleanup 事务以及 Logistics contract cutover，均明确留给后续独立 change。

## Context

统一任务基础层已经把十三类工作规范化为完整 `WorkRef`，但生产派工仍保留两套较早的局部身份：

- Worker board 以 `roomName + taskId` 存储任务，creep assignment 却只保存裸 `taskId`；释放时会扫描全部房间寻找第一个同名任务。任务的 `assignedCreeps` 与 creep sidecar 又共同组成双向 slot claim。
- Carrier producer 通过 `replaceCarrierTasksForProducerRoom(producer, room, drafts)` 发布完整房间快照，但 board 实际只以 `roomName + taskId` 存储。不同 producer 的同名 task 会覆盖，creep assignment 也只保存 `synthesisCarrierTaskId`，因此既有 carrier 可能在覆盖后静默换 owner。
- Carrier 的 `CarrierTaskStepAmountClaim` 是仅当 tick 有效的执行数量切片；Worker slot 则是跨 tick sticky 的离散容量。两者具有不同的恢复、commit、release 和完成语义。

这两套来源都是 heap projection：global reset 后自然丢失，由现有 producer cadence 重建。本切片不把它们变成持久任务，也不接管领域的 priority、完成判定、Screeps intent、cargo snapshot 或清理策略。

受影响的生产链路包含 Worker refresh/role/room workforce/telemetry/MemoryCleanup，以及 Carrier 的 Synthesis、Factory、ResourceControl、Boost、Mineral、Nuker、PowerSpawn、PowerBankBoost、role、market protection 与库存 commitment reader。`refreshWorkerTasks` 内现存的非法建筑清理副作用也位于同一函数，但不属于 ownership；本切片只用 characterization 锁定它，不移动或重写它。

此外，`decentralized-logistics-contracts` 已规划持久 `CapacityLease` 和 `StageWorkClaim`。当前 same-tick slice 不能提前采用这些名称或与其并行计量，否则会对 receiver headroom、在途 cargo 和 delivery phase 双重占用。

## Goals / Non-Goals

**Goals:**

- 让 Worker 和 Carrier 的生产派工均以完整 room-scoped `WorkRef` 作为 canonical identity。
- 建立独立于 TaskSystem adapter 的 Local Dispatch Ownership 层，并让写 ownership 只有窄、领域化的入口。
- Worker slot acquire/release 使用精确 ref 和 expected-ref/CAS，原子维护正向 binding 与反向 assignee 索引。
- Carrier board 真实区分 `room + producer namespace + localId`，同房不同 producer 的相同 localId 能共存、独立刷新和独立绑定。
- 保留现有 producer、role、replace/list/assign/release gateway 的业务语义，并提供无 ensure、隔离的 owner-aware read DTO。
- 保持现有 main phase、Memory/global 名称、priority lane、sticky 行为、action、refresh cadence、cleanup cadence 和 accepted cargo 语义。
- 通过 characterization、架构门禁、扫描预算和 bundle source inventory 证明改动范围。

**Non-Goals:**

- 不给 `TaskSystemAdapter` 增加写方法，不建立通用 TaskManager 或通用 `claim(work, amount?)`。
- 不实现 TransferContract、CapacityLease、StageWorkClaim、RoomLogisticsAgent、持久 claim、global-reset cargo 恢复或 terminal/market 仲裁。
- 不统一 Worker 与 Carrier 的 priority、候选选择、完成、重试、TTL、清理或执行状态。
- 不扩大 amount slice 到当前没有数量 claim 的普通 Carrier path。
- 不迁移 Energy pickup reservation、destination capacity claim、terminal action claim、market exposure/WAL 或资源 reservation。
- 不移动 `refreshWorkerTasks` 中的非法建筑清理，也不修复 Worker capacity 缩小时的历史超配、dismantle 无 producer 等既有行为。
- 不新增 Memory schema、private/public global slot、main phase或 console API。

## Decisions

### 1. Dispatch Ownership 位于 TaskSystem 之外

新增 `src/runtime/dispatchOwnership/`，依赖方向固定为：

```text
roles / producers -> DispatchOwnership command/kernel -> domain heap stores
taskSystem adapter -> DispatchOwnership read DTO
DispatchOwnership --仅 type import--> taskSystem/model.WorkRef
```

`catalog/model/registry/snapshot` 不得反向依赖 Dispatch Ownership；adapter 只能读取 read DTO，不能导入 command、kernel 或 mutator。Dispatch 模块若需要 `WorkRef`，只能使用 `import type`，运行时自己构造结构化对象，避免把 TaskSystem runtime 拉入生产 bundle。

替代方案 A 是给 `TaskSystemAdapter` 增加 assign/claim；这会破坏只读 projection 合同并让观测层成为第二执行源，因此拒绝。替代方案 B 是只共享类型和 comparator；它不能消除裸 ID writer 与双向索引漂移，因此不足以完成本切片。

### 2. 只共享完整引用与 CAS，不共享 claim 生命周期

Local Dispatch Core以`import type { WorkRef }`为唯一TaskSystem依赖，并提供两个与`WorkRef`交叉、可赋值回`WorkRef`的窄ref：

```ts
type WorkerDispatchRef = WorkRef & {
  system: "worker-work";
  namespace: "workerTaskPool";
  scope: { kind: "room"; roomName: string };
  localId: string;
};

type CarrierDispatchRef = WorkRef & {
  system: "carrier-logistics";
  namespace: string;
  scope: { kind: "room"; roomName: string };
  localId: string;
};
```

共享能力仅包括构造、own-field guard、owned-copy clone、字段级 equality、确定性 comparator、按 actor 读取 binding，以及以 `expectedRef` 为前置条件的 bind/release。类型测试必须证明两个窄ref的system/namespace与Catalog/adapter canonical值一致且可赋值给`WorkRef`。bind必须保存经验证且scope逐层新建的owned copy，调用方之后修改原ref不得改变heap。任何实现都不得通过拼接后再 split localId、producer 或 room 来恢复 identity。

Worker 使用 `WorkerSlotClaimPort`；Carrier sticky task binding 使用 actor binding port，而 amount 由独立 `CarrierAmountSlicePort` 管理。两个端口不共享 nullable amount、TTL、commit phase 或完成状态。

### 3. 复用现有 assignment heap，并保留兼容镜像

不新增 global slot。`global.__creepAssignmentState` 中增加 canonical dispatch binding：

```ts
dispatchBindings?: {
  worker?: WorkerDispatchRef;
  carrier?: CarrierDispatchRef;
};
```

现有 `taskId` 与 `synthesisCarrierTaskId` 在本切片继续作为兼容镜像写入，以便旧 consumer、测试和代码回滚读取；它们不再是 canonical identity。command path 每次成功 bind/release 都必须在同一同步调用内更新 canonical binding、兼容镜像和领域反向索引。assignment store不改global名称，但新建store必须使用null-prototype record或等价的原型安全index；对已存在的legacy普通对象只使用own-property descriptor读写，actor名为`__proto__`、`constructor`或`toString`时也只能作为数据键。`ensureCreepAssignmentState` 仍可供 Energy/pending cargo 等无关字段使用，但生产模块不得在 ownership command 之外直接写 `dispatchBindings`、`taskId` 或 `synthesisCarrierTaskId`；同样不得在Worker ownership/producer之外直接写`assignedCreeps`。AST门禁锁定这些identity/反向索引字段的writer集合。

若只存在 legacy mirror，运行时只在当前预期房间中可以唯一证明完整 ref 时进行 heap 内提升：Worker namespace 固定；Carrier 必须恰好匹配一个 producer。零匹配或多匹配时 fail-closed 释放 legacy binding，不扫描其他房间猜 owner。只读 selector 与 adapter 不执行提升或修复。

替代方案是立即删除旧字段；这会扩大直接 consumer 与回滚风险，因此拒绝。镜像移除需要独立 change。

### 4. Worker slot port 原子维护双向证据

Worker selection、score、安全区和 sticky 判断仍留在 `workerTaskPool`。选出候选后，`WorkerSlotClaimPort` 才执行：

1. 对新 acquire 验证完整 ref 对应当前 room task、task active、actor 未绑定其他 ref、slot 尚有容量；
2. 写 actor canonical binding 与 `taskId` mirror；
3. 将 actor 加入该精确 task 的 `assignedCreeps`，保证无重复；
4. 返回绑定成功或 fail-closed 结果。

release 必须携带或先读取完整 expected ref；只有当前 binding 与 expected ref 字段级相等时才删除该 task 的 assignee 和 actor binding。旧 handle 不得释放 actor 随后获得的新任务。refresh/clamp 也按完整 ref 闭合，不再按裸 taskId 跨房扫描。

已有 canonical binding 的 reconcile 与新 acquire 分开处理：必须先验证 ref room仍等于当前 `getAssignedWorkerRoomName`；若scope漂移则释放并在当前房重选。若scope仍匹配、task active、target有效且安全，则即使 `maxAssignees` 后续缩小或当前列表已满，也必须恢复缺失的反向 assignee并保持sticky，不能借ownership重构修复历史capacity shrink超配。容量只限制未绑定actor的新acquire。

公开 `assignWorkerTask`、`releaseWorkerTask`、`getAssignedWorkerTaskId` 继续可用；前两者内部委托 ownership port，最后一个返回兼容 localId。新增精确 getter 供新 consumer 使用。`getWorkerTasksByRoom` 的mutable live-view只保留为领域内部/测试兼容面，telemetry迁到safe peek后，架构门禁禁止其它生产模块导入该mutable gateway。Worker role 的每个 release 条件、三 tick refresh、reset 空窗、normal repair sticky 和 workforce `+1` 保持不变。

### 5. Carrier board 使用 owner-scoped index 和稳定发布顺序

Carrier board 的私有store改为`Map`结构化owner index；每个index record携带不暴露给领域task的publish order，避免维护第二份membership列表并让producer/localId为`__proto__`、`constructor`、`toString`等字符串时仍保持普通数据身份。room scope仍必须先通过合法roomName guard：

```text
board Map<roomName, room store>
  byOwner Map<producer, Map<localId, { task, publishOrder }>>
  nextPublishOrder -> number
```

`replaceCarrierTasksForProducerRoom` 仍表示 producer 对该 room 的完整快照：

- publish必须逐层复制draft与steps，board拥有自己的task/step对象；producer在replace返回后修改输入不得回流；
- 刷新同一 exact ref 时保留 `createdAt` 和原 `publishOrder`；
- 新 exact ref 取得递增的 `publishOrder`，删除后重新发布视为新ref位置；
- 只删除本 producer 本次未发布的 ref；
- 其他 producer 同 localId 不受影响；
- list 仍按 priority 降序、createdAt 升序，并以 `publishOrder` 作为最终 tie-break；list从`byOwner`真实membership枚举，不依赖第二份ref数组。

内部Map index/order是private heap representation，不成为public global ABI。所有lookup、replace、prune和cleanup必须使用Map API，不得把producer/localId投回普通对象下标。生产consumer继续使用`listCarrierTasksByRoom` / `listCarrierTasksForProducer`并新增exact ref lookup，但它们只能暴露task及nested steps的deep-readonly live view；membership和字段只能由board owner修改。需要构造roomName mismatch等坏heap的测试使用明确命名、仅测试可导入的mutable helper，架构门禁禁止生产模块导入。旧的按localId返回可写room record的helper不再作为生产gateway。

替代方案是以可拆分字符串作为复合 key；它会把字段边界重新隐藏在编码中并增加特殊字符风险，因此拒绝。替代方案是只在 draft ID 前强制 producer 前缀；这不能保护自定义 producer，也会让 identity 继续依赖命名约定，因此拒绝。

### 6. Carrier sticky binding 使用完整 ref，amount slice 保持 tick-bound

Carrier 候选 lane、priority、source distance和已有 assignment 优先规则完全留在 role。选中 task 后写完整 `CarrierDispatchRef` 及 `synthesisCarrierTaskId` mirror；读取当前 task必须先验证ref room仍等于当前`getAssignedCarrierRoomName`，再exact lookup producer+room+localId，不能只查localId。config room或物理room变化导致scope漂移时，必须释放旧binding并在当前派工房间按既有lane重选。

`CarrierAmountSlicePort` 迁移现有 task/step budget 实现，但合同保持：

- runtime 仍为 `Game.time + Game identity` 限定的 heap ledger；
- claim首先验证并拷贝完整task ref/scope与step id为owned key，调用方后续修改输入不得改变budget归属；
- budget identity使用嵌套Map或与downstream相同的injective tuple codec表达完整task ref和step id，不得以NUL/冒号/箭头等delimiter concat/split；
- 一个 claimant 同 tick最多持有一个该 task slice；
- failed/throw intent 立即 release；`OK` 后 commit 到 tick结束；
- 同一exact ref的普通refresh不得释放未commit或committed slice；只有task被owner replace删除、prune或cleanup时才释放该ref的未commit slice，committed slice仍保留到tick结束；
- 仍仅由现有 terminal offload、capacity relief 和 Nuker Energy 路径调用。

accepted pickup 后的 pending/cargo snapshot、destination capacity claim、terminal exposure与 Energy reservation保持原 owner。accepted cargo provenance与所有按Carrier task/step构造的market protection、production commitment、dedupe稳定键必须使用完整Carrier ref加step id，不能继续用裸taskId或`taskId + stepId`。需要字符串stable key时统一使用结构化tuple的injective编码（例如固定字段顺序的JSON tuple或长度前缀），禁止delimiter concat/split；但其数量计算、保护策略和仲裁owner不迁入amount port。

### 7. Read port 隔离 private store，并为 projection 提供完整证据

Dispatch read port 不调用 ensure、cleanup、migration或写端口，返回逐层隔离的快照：

- Worker board 仍以 room task snapshot呈现；assignment snapshot额外保留 canonical Worker ref。
- Carrier read DTO 以 room 下的完整 `{ref, task}` entries呈现，不暴露 `byOwner/order` 私有结构。
- malformed sibling 不得阻断合法 sibling，accessor/non-plain 值不得被执行或洗成合法 plain record。

Worker adapter 只有在 `task WorkRef -> assignedCreeps` 与 `actor -> canonical WorkRef` 完全闭合时才投影 claimed；legacy-only、跨字段漂移或 scope/namespace不一致均为 unknown。Carrier adapter直接使用 read DTO中的完整 ref；两个 producer 的相同 localId输出两条 available/unknown-by-own-fields 记录，不再发布底层 collision-risk issue。

TaskSystem adapter接口仍只有 `system + snapshot`，也不得被生产调度导入。

### 8. 保持领域 policy 与 side effect ownership

本切片不得把以下行为搬入 Core：

- Worker home-room/colonizer current-room选择、priority×1000评分、assigned penalty、安全区、完成 predicate、role action与 illegal structure cleanup；
- Carrier 十二条 hard lane、sticky candidate、parallel step nearest-source选择、bounded yield、accepted cargo fallback、terminal offload full-storage重试；
- producer从世界状态重新计算 amount和完成；
- MemoryCleanup 的17 tick时序与 global-reset自然重建。

telemetry 等纯 reader可改用 safe peek，消除“读取空房顺手 ensure”的内部副作用；这只允许减少 private empty-store materialization，不得改变 telemetry数值或生产决策。

### 9. 架构和性能门禁以来源集合为准

本切片会由 Worker/Carrier production path引用，因此 bundle字节/hash不再要求与 foundation基线相等。验证必须证明：

- 新增 production source仅来自批准的 Dispatch Ownership和直接迁移 caller；
- `taskSystem/catalog/model/registry/snapshot/adapters` 的运行时代码仍不进入 bundle；
- main phase、Memory写 path、private/public global slot名称和 console API未扩大；
- Worker release不再做跨房扫描；Carrier replace/list/claim不引入 rooms×tasks×actors笛卡尔扫描；
- 关键选择路径的调用次数和CPU样本使用固定fixture记录：20 rooms×20 tasks×50 actors，基线commit、fixture分布、`process.hrtime.bigint`、nearest-rank p95、5个warmup batch和每场景30 batch×100 iterations固定在`test/localDispatchPerformanceBaseline.test.ts`，每轮Worker release先重建binding、claim逐iteration推进tick、replace刷新同exact ref。硬门禁是每项确定性scan/call-count与算法上界；新Worker acquire/reconcile、Carrier exact与read snapshot以独立确定性计数验收。Node/Jest wall-clock每次运行都向测试stdout输出30批原始样本、median/p95及与变更前聚合值的观测比值；变更前第一次运行没有把30批原始样本持久化，因此只能复核其median/p95与聚合计数，不能把它冒充为可重放的跨版本raw A/B。不得把手写缩减kernel或跨进程绝对毫秒冒充性能授权；真正的部署性能门禁是8.2/8.3在同一shard、同一可观测口径下收集的前后CPU与bucket窗口。变更前数值、限制与source inventory见`evidence/pre-change-baseline.md`。

### 10. Rollout 证据只统计可观测状态变化

部署前必须先新增并冻结一个不进入bundle的本地只读采集脚本`scripts/local-dispatch-rollout-probe.mjs`。脚本只可复用`npm run monitor:once`与`.codex/skills/screeps-game-data/console-api.mjs --probe`读取既有telemetry、`Memory.runtime.lastDeployTag`和private heap，不得ensure、修复、写Memory/global或执行领域command。每个原始JSONL样本使用`local-dispatch-rollout/v1`，至少包含`shard`、`tick`、`deployTag`、`telemetryTick`、`cpuUsed`、`bucket`，以及按canonical tuple key排序去重的`workerBindings`、`carrierBindings`、`carrierAmountSlices`、`acceptedCargo`、`carrierTasks`、`marketProtection`、`productionCommitments`和`actionArbitration`集合/数值。采集脚本与最终表达式文本、stdout/stderr和操作者的部署/reset/console mutation日志必须随8.2/8.3原始证据一起保存。

对任一集合`S_t`，相邻快照只能计算`added_t = difference(S_t, S_{t-1})`与`removed_t = difference(S_{t-1}, S_t)`；这些必须称为“可观测净状态变化”，不得称为bind/release、claim/release或pickup/delivery的完整事件计数。同一tick内建立后又释放的瞬时状态不可由该方案证明，必须标为线上未观测并依赖本地目标/领域测试，不能以零变化宣称通过。90个measured样本的median固定为排序后第45与第46项的算术平均，nearest-rank p95固定为第`ceil(0.95 * 90)`项；pre/post差值和bucket窗口只使用通过有效性检查的同一shard连续样本。

## Risks / Trade-offs

- [Carrier private board shape 改变，旧测试或 console 调试可能按 localId索引] → 生产 consumer统一走 list/exact lookup；先补 characterization，再迁移测试；不公开新的 global ABI。
- [兼容 mirror 与 canonical ref可能漂移] → 只有 ownership command可写；canonical ref优先，read adapter报告漂移，legacy提升只在唯一可证明时发生。
- [旧 release handle误删新 assignment] → 所有内部 release使用 expected-ref/CAS；专门覆盖 release后重绑与 stale handle测试。
- [完整ref身份修正改变历史错误命中] → 将Worker跨房lookup/release、scope漂移与Carrier同localId共存作为显式bug fix，覆盖producer独立刷新、assignment、claim、accepted cargo、market/commitment稳定键、projection和consumer聚合；rollout单独观察。
- [Carrier排序因 owner index改变] → 每个private owner record保留首次`publishOrder`，稳定sort继续以它作为最终决胜；黄金测试锁定刷新保序、删除重加新rank、hard lane与同分顺序。
- [global reset仍会丢失已持 cargo ownership] → 明确保留既有降级；持久恢复由 `decentralized-logistics-contracts` 的 StageWorkClaim负责，不在本切片造第二套方案。
- [read DTO复制增加 CPU] → 只允许测试/诊断/批准的只读 consumer调用；生产 role继续使用 live list/exact lookup，不每 tick构造全板快照。
- [Dispatch type import意外把TaskSystem拉入bundle] → AST依赖门禁要求 `import type`，Rollup source inventory禁止 TaskSystem runtime module。
- [既有Terminal/Market rollout归因被污染] → 允许本地完成和提交，但在`terminal-headroom-recovery`、`market-base-resource-all-rooms`、`market-direct-continuous`与`market-scope-core-read-cpu`各自剩余live/Shadow/CPU/保护账本观察完成并冻结结论前禁止部署；“重置后尚在观察”不构成通过。

## Migration Plan

1. 先锁定 Worker role、room选择、slot/release/reset/cleanup，以及 Carrier sticky选择、same-tick slice、pending cargo、producer prune与碰撞现状的 characterization。
2. 落纯 ref/equality/read DTO与架构门禁；此阶段不接生产写路径。
3. 在现有 assignment heap加入 canonical bindings与兼容镜像写法，实现 generic expected-ref bind/release。
4. 迁移 Worker slot port与直接 consumer；保留公开 gateway和所有领域策略，验证后再进入 Carrier。
5. 迁移 Carrier owner-scoped board、exact lookup、sticky binding和 amount slice；逐个验证真实 producer/consumer与 market protection。
6. 更新两个只读 adapter、registry fixtures与 projection/architecture门禁；运行聚焦、全量 Jest、build/test TypeScript、strict OpenSpec、diff-check和Rollup source inventory。
7. 代码审查与提交后保持未部署，等待`terminal-headroom-recovery`、`market-base-resource-all-rooms`、`market-direct-continuous`与`market-scope-core-read-cpu`四个窗口均完成并冻结结论；随后执行一次全量bundle切换，以明确的10 warmup + 90 measured后部署观察窗口核对task数量、identity、Carrier/Worker binding、market protection/commitment、CPU/bucket与错误日志；该切换不冒充为分组canary。

新bundle内部的legacy reader由compatibility mirrors继续获得localId。真正回滚到旧代码时，先部署并只读验证旧bundle/tag生效，再触发global reset；reset只清空canonical binding、mirror、owner index和ledger，不等于恢复完成。验收必须容忍旧producer cadence的空窗，等待Worker/Carrier board重建，并检查accepted-cargo fallback、market protection/commitment、action arbitration和CPU/bucket恢复。该回滚明确继承现有Carrier已持cargo在reset后的降级，不承诺lossless cargo ownership恢复。

## Open Questions

当前没有阻断实现的问题。`taskId`/`synthesisCarrierTaskId` compatibility mirror何时删除、Worker非法建筑清理何时从refresh中分离、以及Carrier持久cargo恢复何时交给StageWorkClaim，均明确留给后续独立 change。

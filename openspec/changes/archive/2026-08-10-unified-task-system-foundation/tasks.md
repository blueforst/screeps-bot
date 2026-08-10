## 1. 基线与失败门禁

- [x] 1.1 记录当前 branch、OpenSpec active changes、十三类系统来源、main phase、Memory/global ABI 与规范化 Rollup bundle hash基线
- [x] 1.2 为 canonical Catalog exact keys、`TaskSystemId` 派生、own-property guard和纯模块边界编写失败测试
- [x] 1.3 为 adapter registry exact coverage、只读接口形状和生产决策模块禁止反向 import 编写失败架构测试
- [x] 1.4 为 Worker/Carrier 空 heap peek、global reset不创建 private slot、现有 get/replace/assign行为不变编写 characterization测试
- [x] 1.5 将 War/RemoteMining/Factory/Spawn 已知生命周期歧义作为 projection-only fixture 固化，证明本变更不推断新终态、retry或cleanup

## 2. 纯 Task System Core

- [x] 2.1 新增结构化 `WorkScope`、含namespace的`WorkRef`、`WorkAuthorityRef`、`WorkActivity`、`WorkStatusView`、issue与summary/snapshot类型
- [x] 2.2 实现 `TASK_SYSTEM_CATALOG` 十三项能力元数据、由 own keys 派生的 `TaskSystemId` 与 fail-closed `isTaskSystemId`
- [x] 2.3 实现namespace/scope/ref canonical comparator与稳定排序，不依赖冒号、箭头或config命名字符串split
- [x] 2.4 定义只读 `TaskSystemAdapter<TContext>` 与显式entries/invalidCount/issues结果协议，确认公共类型不存在execute/assign/claim/cancel/complete/delete/transition/upsert方法
- [x] 2.5 增加Catalog/model架构门禁，禁止领域runtime import和Game/Memory/RawMemory/global/Screeps常量读取

## 3. 无副作用来源 selector

- [x] 3.1 为 WorkerTaskBoard 增加不创建store、不返回可变来源引用的全板/房间 peek selector并覆盖reset/空房测试
- [x] 3.2 为 CarrierTaskBoard 增加不创建store、不释放claim的全板/房间 peek selector并覆盖producer/room/task identity测试
- [x] 3.3 为 creep assignment 增加只读快照或精确peek能力，使Worker projection只在双向证据闭合时报告assignee
- [x] 3.4 证明新增selector不改变private global slot集合、现有Memory shape、domain writer ABI或原有测试语义

## 4. 十三类领域 Adapter

- [x] 4.1 实现 Worker adapter：room scope、active/source状态、slot claim闭合与漂移issue
- [x] 4.2 实现 Carrier adapter：producer authority、并列transport facts、现有task-id碰撞诊断且不伪造sequence/progress
- [x] 4.3 实现 PowerCreep actor-queue adapter：actor scope、priority queue状态与缺失/legacy task处理
- [x] 4.4 实现 ResourceTransfer v2 adapter：cross-room scope、origin/executor authority、pending/blocker/terminal与数量字段只读投影
- [x] 4.5 实现 Factory command adapter：room scope、pending/loading/producing/unloading/terminal映射及failed保护歧义issue
- [x] 4.6 实现 RemoteMining、Colonization、Rescue 与 FlagHauling workflow adapters，保留各自domain status、retry/flag/source-target事实
- [x] 4.7 实现 CrossShardColonization、War 与 PowerBank workflow adapters，保留shard/object/generation/component authority及active/history边界
- [x] 4.8 实现 Spawn Production adapter，组合config、queue、native spawning与live references并允许desired/queued/spawning/materialized事实重叠
- [x] 4.9 为每个adapter增加合法、空store、legacy缺字段、malformed、unknown status和global reset fixture
- [x] 4.10 对所有adapter执行前后Memory/来源对象/private global identity快照，证明无ensure/migration/sort-in-place/intent/cleanup副作用

## 5. Registry 与统一 Snapshot

- [x] 5.1 静态注册十三个adapter并以类型与运行时测试证明registry与Catalog一一对应、无遗漏/重复
- [x] 5.2 实现 `collectTaskSystemSnapshot(context)`，输出observed tick/shard、所有system summary和稳定排序entries
- [x] 5.3 从同一entries单次构建activity/sourceState/issue计数，加入来源读取计数钩子以证明每adapter只扫描一次
- [x] 5.4 实现adapter异常隔离与有界failure diagnostic，失败system不得发布半份entries且不得阻止其他system
- [x] 5.5 对snapshot、entries、authorities、issues与summaries做来源隔离，证明调用方修改结果不会反向修改task/config/workflow/queue
- [x] 5.6 增加跨system相同localId、Carrier同房producer碰撞、特殊字符scope/id和输入插入顺序变化的确定性测试

## 6. 架构兼容与回归

- [x] 6.1 锁定Synthesis/Hub plan、reservation/ledger/action claim与market WAL/order不进入Catalog或adapter registry
- [x] 6.2 锁定统一Core不定义TransferContract/CapacityLease/StageWorkClaim/RoomLogisticsAgent/matcher/terminal executor等物流领域能力
- [x] 6.3 锁定main、producer、planner、role、cleanup、Spawn/ResourceControl/market executor不import snapshot/adapters
- [x] 6.4 运行Worker/Carrier/PowerCreep/ResourceTransfer/Factory/workflow/Spawn与Memory/tick-phase聚焦回归并修复实现回归
- [x] 6.5 独立审查Catalog完整性、projection无副作用、领域边界、active OpenSpec overlap和已知风险未被误修

## 7. 完整验证与关闭态交付

- [x] 7.1 运行build与workspace双TypeScript检查、全量Jest、Rollup build、`openspec validate unified-task-system-foundation --strict`和tracked/untracked diff check
- [x] 7.2 比较实现前后规范化bundle hash/语义，证明foundation未进入生产入口且main phase、Memory写集合和global ABI不变
- [x] 7.3 若bundle等价则记录无需部署的证据；若不等价则停止归档并移除意外入口/初始化副作用或另立行为change
- [x] 7.4 同步两项新capability到主规格、完成最终review/re-review并归档`unified-task-system-foundation`
- [x] 7.5 记录后续独立change顺序：War生命周期定规约→local dispatch ownership→workflow owned assets→logistics contracts→task observability

# Task Status Projection 规格

## Purpose

定义十三类工作来源的无副作用状态投影、确定性聚合、异常隔离和关闭态运行边界，为测试与后续只读观测提供统一视图。

## Requirements

### Requirement: 每个 canonical system 提供只读状态 adapter
系统 MUST 为十三个 Catalog system 各提供一个 adapter；统一 snapshot MUST 为每个 system 输出 summary，即使其来源 store 缺失、heap 因 global reset 不存在或当前记录数为0。

#### Scenario: 空系统仍出现在 summary
- **WHEN** Factory、Colonization、Rescue、War 或其他来源当前没有记录
- **THEN** snapshot 必须包含相应 canonical system、`count=0` 和零 issue summary，不得为获得该结果创建空 Memory/global store

#### Scenario: Adapter coverage 与 Catalog 完全一致
- **WHEN** 架构测试比较 adapter registry 与 Catalog
- **THEN** 每个 canonical system 必须恰有一个 adapter，且不得存在未登记或重复 system adapter

### Requirement: Projection 保留 normalized activity 与原始领域状态
每条 `WorkStatusView` MUST 包含 `WorkRef`、`activity`、`sourceState`、authority 列表和 issue 列表；`activity` MUST 仅使用 `desired/available/claimed/running/blocked/terminal/unknown`，且 MUST NOT 替代或回写原始领域状态。

#### Scenario: ResourceTransfer blocker 被投影但不转换来源
- **WHEN** v2 ResourceTransfer 记录为 `pending` 且带 `blockedReason`
- **THEN** projection activity 必须为 `blocked`、sourceState 必须仍为 `pending`、blocker 必须保留，来源 task 不得发生状态或时间戳写入

#### Scenario: Worker claim 只在证据闭合时展示
- **WHEN** Worker task 的 assignee 与 creep assignment 双向一致
- **THEN** projection MAY 标记为 `claimed` 并列出 assignee authority；当证据缺失或漂移时必须保留 `active` sourceState并报告 issue，不得修复来源 assignment

#### Scenario: Carrier 不伪造顺序 step 或完成进度
- **WHEN** Carrier task 包含多个 transport step
- **THEN** adapter 必须把它们视为并列领域事实，不得按数组位置投影 sequential workflow 进度，也不得因 carrier delivery 推断 task terminal

### Requirement: Snapshot identity 与顺序确定性
统一 snapshot MUST 使用当前 tick/shard observation context，并按 `system → namespace → canonical scope → localId` 确定性排序；相同来源事实的重复读取 MUST 产生语义相同的 identity、activity、sourceState、authority、issue 与 summary。

#### Scenario: 输入插入顺序不同但输出稳定
- **WHEN** 两个 fixture 具有相同记录但对象/Spawn/PowerCreep 插入顺序不同
- **THEN** snapshot entries 和 summaries 必须得到相同的 canonical 顺序与计数

#### Scenario: local ID 特殊字符不破坏 identity
- **WHEN** localId、producer 或 scope 值含冒号、箭头或其他当前 config/task 命名字符
- **THEN** 结构化 WorkRef 与 canonical comparator 必须保持字段边界，不得依赖不可逆字符串 split 猜测 identity

### Requirement: Snapshot 完全无副作用
执行任意 adapter 或聚合 snapshot 前后，Memory、Game/native object、现有来源记录、private global slot 集合与 assignment/claim store MUST 保持相同内容和引用关系；adapter MUST 使用 peek/read path，禁止调用 ensure、cleanup、migration、sort-in-place 或 domain mutation API。

#### Scenario: 读取空 heap 不创建 private global
- **WHEN** Worker/Carrier/assignment private global 在 global reset 后尚不存在
- **THEN** snapshot 必须返回空来源 summary，且调用后仍不得出现对应 private global key

#### Scenario: 读取 legacy Memory 不触发 migration
- **WHEN** ResourceTransfer、Factory 或 workflow Memory 缺少可选新字段或 schema marker
- **THEN** adapter 必须按可证明字段投影或报告 issue，不得调用 ensure/migrate 写回 Memory

#### Scenario: 调用方不能反向修改来源
- **WHEN** 调用方尝试修改 snapshot entry、authority、issue 或 summary
- **THEN** 来源 task/config/workflow/queue 对象必须保持不变，后续 snapshot 不得继承调用方修改

### Requirement: Malformed 来源 fail-closed 且可观测
Adapter MUST 对非对象、缺失 identity、未知 status、无效数字、数组/记录 shape 错误和跨字段冲突 fail-closed。若可以从 store key 与 scope 证明 WorkRef，MUST 输出 `activity=unknown` 与有界 issue；若无法证明 identity，MUST 只增加 system-level invalid count且不得构造虚假 entry。

#### Scenario: 未知 status 不被当作 active 或 terminal
- **WHEN** 持久 workflow 记录具有未知或非字符串 status
- **THEN** projection 必须为 `unknown` 并报告 status issue，不得默认调度或完成该记录

#### Scenario: 无法证明 ID 的 malformed record 不泄漏到其它记录
- **WHEN** 来源数组或 map 含一个无法确定 identity 的 malformed item及其他合法 items
- **THEN** system invalid count 必须增加，合法 items 仍正常输出，malformed item 不得覆盖、阻止或借用其他 identity

### Requirement: Source adapter 保留各自完成与持久性边界
Adapter MUST 按来源事实投影，但不得为所有系统发明统一持久状态：可重建 heap projection、actor queue、持久 command、domain workflow 与 production intent 的 durability 和 completion 语义 MUST 保持可区分。

#### Scenario: Worker global reset 空窗不是持久任务丢失
- **WHEN** Worker board 因 global reset 缺失且当前 tick尚未到3 tick refresh cadence
- **THEN** snapshot 必须把 system 标记为 source unavailable/empty projection，不得创建 Memory task、伪造 terminal records或触发 refresh

#### Scenario: Spawn projection允许多层事实重叠
- **WHEN** 同一 config 同时处于 desired、queued/spawning 或 materialized 的多个层次
- **THEN** adapter 必须保留 production-intent sourceState/facts且 activity 不得因首次 materialization变成 terminal

#### Scenario: PowerBank terminal history 不是 active task
- **WHEN** active PowerBank task 已被终态事务删除但 bounded history仍保留结果
- **THEN** PowerBank adapter 必须区分 active workflow 与 history projection，不得让历史记录重新成为可执行 work

### Requirement: Projection 不得成为生产决策来源
生产者、planner、role、cleanup、spawn executor、ResourceControl、market executor 与领域 workflow manager MUST NOT 导入统一 snapshot 或领域 adapters来决定创建、分派、优先级、数量、完成、重试、删除或执行；projection 的允许消费者仅限测试、诊断和后续明确批准的只读观测层。

#### Scenario: Architecture import gate 阻止反向依赖
- **WHEN** 任一生产决策模块新增对 `taskSystem/snapshot` 或 `taskSystem/adapters` 的 import
- **THEN** 架构测试必须失败，即使运行测试中的业务结果暂时相同

#### Scenario: 观测字段缺失不影响执行
- **WHEN** projection、summary 或 adapter diagnostics 不存在、失败或被禁用
- **THEN** 现有任务生产、分派、执行、清理和 Spawn/market 行为必须继续只依赖原 source of truth

### Requirement: 聚合工作与 diagnostics 保持有界
单次 snapshot 中每个 adapter MUST 至多线性扫描自己的来源一次；聚合器 MUST 对 entries、issues 与 adapter failure diagnostics 使用确定性有界输出，不得执行跨全部房间×全部任务×全部 actor 的无界笛卡尔联接或持久化追加日志。

#### Scenario: 多来源 snapshot 不重复全表扫描
- **WHEN** fixture 同时包含多房 Worker/Carrier、PowerCreep queue、持久 commands、workflows 与 Spawn refs
- **THEN** 测试钩子必须证明每个来源只被读取一次，summary从同一 snapshot entries构建而非再次扫描来源

#### Scenario: 单 adapter 失败不污染其他系统
- **WHEN** 一个 adapter 在读取 malformed getter 时抛出异常
- **THEN** 聚合器必须为该 system输出有界 failure diagnostic并继续输出其他 system；不得发布失败 adapter 的半份 entries

### Requirement: 首切片保持关闭态运行边界
本切片 MUST NOT 把统一 snapshot 接入 main tick、Memory、RawMemory segment、global console ABI 或远程 mutation API。生产 build 中若没有现有入口引用 foundation，Rollup MUST tree-shake该实现并保持规范化 bundle 等价。

#### Scenario: 本地测试可读取而线上行为不变
- **WHEN** Jest/TypeScript 测试直接调用统一 snapshot，而生产 main未导入它
- **THEN** 测试必须验证完整 projection合同，同时 main phase、生产 bundle语义、Memory写集合和 live deploy需求保持不变

#### Scenario: 意外生产引用阻止归档
- **WHEN** build diff显示 foundation 被意外保留、产生模块初始化副作用或改变生产 bundle
- **THEN** 本变更不得直接归档或部署，必须先删除意外入口/副作用或以独立行为变更重新评估

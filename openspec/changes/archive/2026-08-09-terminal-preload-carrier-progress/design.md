## Context

Carrier 当前有两个独立优先级域：source 函数的硬编码类别顺序，以及仅在进入 CarrierTaskBoard 后生效的数值 priority。ResourceControl staging admission 已确认 source inventory、receiver reservation、Terminal action Energy ownership 与发送窗口，但普通 Energy 分支仍可在 Carrier 层永久遮蔽 accepted preload。

`resourceControl:preload` 又同时承载容量救援、显式 transfer、Hub/Synthesis、自动 Energy 与市场 readiness。仅凭 producer/type 前移全部 feed 会扩大语义，并可能反向饿死普通房内工作。因此本切片需要一个比字符串协议更窄的结构化类别。

## Goals / Non-Goals

**Goals:**

- 让已获 staging admission 的容量救援在没有即时生存 Energy 工作时取得 Carrier slice。
- 保持 Tower、active idle Spawn、PowerSpawn 与 Nuker 的既有安全边界。
- 限制同 tick 多 Carrier pickup，不超过 accepted step 和目标 Terminal 容量。
- 保证容量救援与普通 Energy/board task 双向都有进展机会。
- 清除未接受的 stale binding，同时保留 accepted pickup snapshot。

**Non-Goals:**

- 不前移所有 ResourceControl preload。
- 不改造 `terminalHeadroomRecoveryEnabled=false` 的 legacy聚合路径；该兼容模式不发布capacity dispatch class。
- 不改变跨房动作的生成水位、receiver admission、发送执行器或市场策略。
- 不把所有 Carrier 类别改造成 DAG、aging queue 或统一动态 priority。
- 不新增专用 Carrier、持久化调度状态或 Memory schema。

## Decisions

### 1. staging admission 产生结构化 dispatch class

ResourceControl 仍可在自身领域内根据自动任务所有权与 `capacity:relief:*` reason 识别容量救援，但在发布 CarrierTask 前必须转换为：

```text
task.producer == "resourceControl:preload"
task.type == "terminal_feed"
task.dispatchClass == "capacity_relief"
```

Carrier 只消费这三个结构化字段，不解析 task id、resource 或 transfer reason；manual task即使伪装同名reason也不得获得该class。分类同时应用于容量 cargo 与该 action 必需的 Energy payload/手续费 feed；Energy draft必须严格裁到 `stagingFeedRequirement.energy`，不得顺带补普通20K Terminal reserve或market readiness。capacity batch占用本轮显式Terminal窗口，market readiness在该轮标记为`terminal_claimed`，下一轮再独立规划。没有该字段的旧 task与其他ResourceControl feed保持后台顺序。该字段只存在于heap task board，refresh时按draft原子替换，不能从旧task泄漏到无分类draft。

该分类只由启用 Terminal headroom recovery 的现代 staging admission发布。关闭该开关会回到按房间/资源聚合、丢失单一action provenance的legacy路径；本切片刻意保持该兼容语义，不伪造不可信class。

### 2. 先显式保护即时安全需求

相关 source 顺序为：

```text
PowerBank Boost
Urgent Lab cleanup
Critical Tower / active idle Spawn Energy
PowerSpawn board supply
Nuker Ghodium
Direct unmanaged PowerSpawn Energy
Classified capacity-relief preload
Ordinary Energy demand
Remaining non-capacity, non-Nuker-Energy board tasks
...
Nuker Energy background
```

`getEnergyStoreTarget` 原先固定先返回 Spawn/Extension，可能隐藏同房低能 Tower或 direct PowerSpawn。若房间有 Spawn 证据但没有 active idle Spawn，reader 必须先暴露 Tower，再暴露未托管 PowerSpawn；Carrier 才能在类别边界做正确选择。

Spawn/Extension 只有在至少一个 active Spawn idle 时是 immediate critical。所有 active Spawn 都忙时，它们是下一轮预充；只有 inactive Spawn时也不得制造虚假的立即需求。测试/不完整 mock完全没有 Spawn 索引时继续使用保守 fallback。

### 3. accepted slice 同时领取任务量与目标容量

Classified preload 继续复用 `pickupSynthesisCarrierResource`、source inventory、market exposure、accepted snapshot 与 target delivery。新增两份同 tick claim：

- task-step amount claim：同一 step 的所有 Carrier accepted withdraw 总额不超过 step amount；
- local destination capacity claim：所有资源共享的 Terminal 余量扣除已携带 cargo 与本 tick先到 claim。

claim 只在 withdraw `OK` 后 commit；失败、异常或 `ERR_NOT_IN_RANGE` 路径释放。accepted cargo 即使 task 随后刷新或删除，也继续按 snapshot 投递原 Terminal。

### 4. 一个 accepted pickup 换一个低优先级 pass

每个 Carrier 在 accepted capacity-relief pickup 后设置 heap-only yield 标记。其完成该 cargo、再次到达容量救援选择点时跳过 classified relief，让旧的普通 Energy、其他 board、dead-store 或 fallback pipeline运行。较低优先级 pickup 被接受时消费标记；若选中的来源只是 `ERR_NOT_IN_RANGE`，标记继续保留，避免 Carrier 在两个来源之间振荡。若完整 pass 没有任何较低优先级候选或候选明确失败，则消费标记并在后续 source周期重新允许 relief。

该标记不越过 Tower、idle active Spawn、PowerSpawn 或 Nuker；这些分支在 yield 点之前，仍可连续处理。通用 board filter 永久排除 classified relief，避免 yield pass 又从后台分支选回同一 task。

### 5. stale assignment 只清未接受状态

容量救援候选不可运行或 withdraw失败时，若 assignment 仍指向 ResourceControl `terminal_feed`且没有 accepted `toId/resource` snapshot，也没有本 tick accepted pickup，则在普通 Energy fallback 前清除 task id。清理不能依赖当前draft仍带class：同一task id可能在下一轮原子刷新为无class后台feed。已经accepted的snapshot不可清除，避免资源被改投；其他producer assignment也不得被误清。

## Risks / Trade-offs

- [下一轮 Spawn 预充可能延后] → 仅在没有 active idle Spawn时让出一个 slice；Spawn 一旦 idle，下一次 source选择立即恢复 critical。
- [普通工作反向饥饿或路径振荡] → accepted relief后保留yield直到低优先级pickup被接受；out-of-range不消费，完整无候选pass才释放，且后台filter不再重复选择classified relief。
- [多 Carrier 过取/Terminal 溢出] → task amount 与共享目标容量两层 claim，失败路径全部释放。
- [错误提升普通跨房任务] → dispatch class由 ResourceControl admission写入；producer/type相同但无 class 的负例锁边界。
- [普通Terminal reserve或market readiness搭便车] → classified Energy draft只保留action精确缺口，capacity窗口内禁止readiness merge扩大。
- [隐藏防御目标] → reader 组合测试覆盖 busy Extension + Tower；Tower无条件优先。
- [stale Energy 误送 Terminal] → 只清未接受 classified binding，并以两周期 delivery回归验证普通 Energy仍去普通目标。

## Migration / Rollback

1. 写分类、优先级、claim、公平与 stale binding 特征测试。
2. 发布 heap-only class，接入 ResourceControl draft 与 Carrier filter。
3. 运行 Carrier、EnergyTargets、CarrierTaskBoard、ResourceControl/Capacity 及相关消费者回归，再运行 TypeScript、全量 Jest、build 与 strict OpenSpec。
4. 部署同一已验证 commit，观察 E7N58 的 L pickup、Terminal入库、跨房 send、room Energy 与 CPU。
5. 严重异常时部署父提交；无 Memory 或配置迁移。

## Open Questions

无。

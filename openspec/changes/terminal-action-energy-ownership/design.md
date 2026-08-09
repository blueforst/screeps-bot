## Context

ResourceControl 当前同时承担三种不同含义：

1. `energyFloor/energyTarget/energyExportStart` 描述房间 Energy 状态、恢复需求和无任务自动平衡策略；
2. `terminalEnergyReserve`、生产 reservation、transfer task commitment 与 market exposure 描述库存所有权；
3. Terminal store、headroom、cooldown、receiver ledger 与 action arbiter 描述动作能否物理执行。

旧实现把第一类水位混入第二类预算，形成四层重复拒绝：capacity movable、task executor、terminal staging 和 Direct readiness feed。删除单一 `fee_budget` 判断不足，因为后续 `terminal_headroom`、receiver need 与 executor 会继续阻塞。

现场边界也说明 ordinary Terminal reserve 不能被误升级成 universal post-send floor：E3N59 的非 Energy cargo 已在 Terminal，但 Terminal Energy 为 0、物理空闲约 4.3k。容量泄压需要只补完整手续费并发送；若强制发送后仍在 Terminal 留 20k，则该路径物理上不可达。

## Goals / Non-Goals

**Goals:**

- 为已经存在或已经取得 admission 的跨房动作提供唯一、可解释的 Energy 所有权预算。
- 让 manual/Hub/Synthesis/War/capacity-relief 的 executor 与 staging 使用同一口径。
- 允许受压房在不穿透显式 commitment 的前提下，用 Storage Energy 支付跨房费用或发送 Energy。
- 保留 receiver 容量账本、市场 exposure、Terminal 物理 headroom 和同 tick action 仲裁。
- 用 E3N59、E7N58 形态的多周期测试证明 staging→carrier→send 的完整链路。

**Non-Goals:**

- 不删除 room Energy policy，也不改变 survival/balanced/export 的观测状态。
- 不改变自动 Energy 恢复的 receiver target 或无任务 donor 生成策略。
- 不为普通 internal send 新增 universal post-send Terminal reserve；若未来需要，必须先设计受压 Terminal 的重排/临时 offload 路径。
- 不修改 market pricing、credits、permit/WAL、Direct effective reserve 或 legacy seller 永久闩。
- 不实施尚未落地的 decentralized logistics contracts。

## Decisions

### 1. 将“恢复水位”与“动作所有权”分开

新增纯预算函数，输入只包含非负整数事实：

```text
actionEnergyBudget = max(0,
  storageEnergy + terminalEnergy
  - ordinaryTerminalEnergyReserve
  - productionEnergyCommitment
  - otherOutgoingEnergyCommitment
  - otherOutgoingFeeCommitment
  - otherExplicitEnergyOwnership)
```

函数不得接收 `energyFloor`、`energyTarget` 或 `energyExportStart`。ResourceControl 负责从同一 tick 的 transfer context 取得 commitment，并在计算当前任务时排除该任务自己的 payload 与 fee，避免自我阻塞或重复扣减。

ordinary Terminal reserve 在这里表示房间总量中保留给后续 Terminal 动作的显式所有权，不要求每个 internal send 完成后该数量已经物理位于 Terminal。最终写前仍重验真实 payload/fee、market exposure、receiver reservation、cooldown 与 action claim。

### 2. 自动恢复策略与显式任务执行分流

无持久任务的自动 Energy 平衡仍由 `energyExportStart` 选择 donor、由 `energyTarget-storageEnergy` 计算 receiver need，避免所有低能房互相搬运。它生成动作后仍使用物理 store、exposure 和 action arbiter。

持久 transfer task 已经表达 operator/Hub/Synthesis/War/capacity-relief 的意图，executor 不得再次用 donor export state 或 receiver Energy target 否决。Energy payload 数量只受 task remaining、batch、receiver capacity、action ownership budget 与 `amount+fee` 约束。

### 3. 容量泄压中的 Energy 是普通可搬资源

Capacity pressure 的目的不是 Energy 恢复，而是释放 Storage/Terminal 容量。Energy candidate 因此不要求 receiver 低于 `energyTarget`；planner 按 movable amount、receiver safe capacity、库存、费用与稳定房间名选择路径。接收房的 capacity state、Storage/Terminal safety reserve 和 ledger commitment 继续生效。

### 4. 受压 Terminal 只允许手续费 bootstrap 例外

正常 staging 继续使用 Terminal recovery 计算出的安全 feed capacity。只有同时满足以下条件时，才允许改用物理 Terminal free capacity容纳 Energy fee：

- transfer resource 不是 Energy；
- 当前批次全部 cargo 已经在 Terminal，所需 resource feed 为零；
- 缺口仅为该批次完整 transaction fee；
- 完整 fee 一次性放得下，且 action Energy ownership budget 足够。

不得缩成部分 fee，也不得把新的 non-Energy cargo 一起塞入受压 Terminal。最终 draft 仍与 offload、Direct readiness 和同房单窗口规则合并，并使用稳定 Energy feed task ID。

### 5. Direct readiness 只删除 room floor 门禁

Direct readiness 已独立计算 current effective post-deal reserve，并在两次 full read 和 prepared deal 中保护至少 25k、pending send/fee、生产 commitment 与市场 claim。本变更只把 Storage feed admission 的 `energyFloor + production` 改为显式 ownership/production 可用量；Terminal minimum free、capacity emergency、draft 原子 replacement、permit/WAL 和 effective reserve 全部保持。

## Risks / Trade-offs

- [低能房可以履行显式跨房任务] → 这是用户明确的新合同；生产、其他 transfer、ordinary Terminal reserve 和 market exposure 仍先扣除，本地高耗能任务继续受 Energy 水位限制。
- [Energy capacity relief 可能发往已高于 target 的房间] → 该路径按容量而非 Energy 恢复选择 receiver；receiver 仍必须 normal 并保留安全 Storage/Terminal headroom。
- [受压 Terminal feed 与 offload 冲突] → 例外只容纳 cargo 已在 Terminal 的 fee，staging batch 保护 cargo，所有 drafts 最后一次整包替换。
- [当前任务排除错误导致超卖] → 用 taskId 同时排除 payload 与 fee，并测试其他 task、生产 reservation 仍被扣除。
- [Direct 市场安全回归] → 不改 planner/permit/WAL/executor，只测试 readiness feed 在低 room Energy 时仍保持 current effective reserve 和 40k Terminal headroom。

## Migration / Rollback

1. 先用旧实现运行特征测试，确认 E3/E7 fixture 分别被 `fee_budget` 阻塞。
2. 落地纯预算及 ResourceControl 调用点，运行 transfer、capacity、Hub、Synthesis、market readiness 聚焦回归。
3. 全量 TypeScript/Jest/build/OpenSpec 与独立审查通过后部署同一 commit。
4. 线上观察 staging admission、Carrier fee feed、task blocker、真实 `terminal.send(OK)` 与 capacity headroom。
5. 严重异常时部署父 commit；没有 Memory schema 迁移。

## Open Questions

无。universal post-send Terminal reserve 与自动 Energy 均衡策略重做明确留给独立变更。

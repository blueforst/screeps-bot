## ADDED Requirements

### Requirement: 跨房动作 Energy 只受物理库存与显式所有权约束

系统必须（MUST）以 Storage 与 Terminal 的 Energy 总实存计算已存在跨房动作的可用预算，并扣除 ordinary Terminal Energy reserve、生产 reservation、其他健康出站 Energy、其他出站手续费和市场 exposure。`energyFloor`、`energyTarget` 与 `energyExportStart` 不得（MUST NOT）进入该动作预算。计算某个 transfer task 时必须排除该任务自身已经登记的 payload 与 fee，且只能排除一次。

#### Scenario: 非 Energy 任务在 Storage 低于 target 时支付手续费

- **WHEN** 一个健康的非 Energy transfer task 已取得 receiver reservation，来源 Storage Energy 低于 `energyTarget`，但扣除显式所有权后总 Energy 足以支付完整手续费
- **THEN** staging 与 executor 必须允许该手续费，不得报告 `fee_budget` 或等价 room-watermark blocker

#### Scenario: 其他承诺仍然受到保护

- **WHEN** 总 Energy 看似足够，但扣除 production、其他 Energy payload、其他 fee 或 market exposure 后不足
- **THEN** 系统必须缩量或阻塞当前动作，不得借水位解耦重复消费已拥有库存

#### Scenario: 当前任务不自我阻塞

- **WHEN** 当前 task 的 remaining payload 与预计 fee 已经存在于共享 commitment index
- **THEN** 预算必须排除该 task 自身贡献后再评估本批次，既不得二次扣减也不得排除其他 task

### Requirement: 显式 Energy task 不得被恢复需求重写

Manual、Hub、Synthesis、War 和 capacity-relief 等已存在的 Energy transfer task 必须（MUST）按 task remaining、batch、receiver safe capacity、动作 Energy ownership 和 `amount+transactionFee` 执行。Executor 与 staging 不得（MUST NOT）要求 donor 达到 `energyExportStart`，也不得按 receiver 的 `energyTarget` need 截断或取消该任务。

#### Scenario: 来源低于 exportStart 且目标已达到 target

- **WHEN** manual Energy task 的 donor Storage 低于 `energyExportStart`、receiver Storage 已达到 `energyTarget`，但任务、receiver capacity 与动作预算均有效
- **THEN** 系统仍必须执行任务允许的批次

#### Scenario: 自动 Energy 恢复仍使用需求水位

- **WHEN** 系统尚无显式任务，只在判断是否创建自动 Energy 恢复动作
- **THEN** 系统可以（MAY）继续用 receiver `energyTarget-storageEnergy` 作为需求、用 donor `energyExportStart` 作为新动作生成策略；该策略不得被误用于已有任务 executor

### Requirement: 容量泄压可以移动 Energy

当容量压力是动作原因时，Energy 必须（MUST）像其他可搬资源一样参与候选与 receiver 排序，不要求 receiver 存在 Energy 恢复缺口。发送量仍必须服从 capacity recovery gap、receiver Storage/Terminal safe capacity、共享 reservation、动作 Energy ownership 和交易费。

#### Scenario: 接收房 Energy 已恢复但有容量

- **WHEN** 受压来源房的最大可搬 Storage 资源为 Energy，合格 receiver 已达到 Energy target 但具有安全容量
- **THEN** planner 必须可以创建 `capacity:relief:energy`，不得因 receiver Energy need 为零跳过

### Requirement: 受压 Terminal 允许完整手续费 bootstrap

非 Energy transfer 的完整 cargo 已位于受压 Terminal、唯一 staging 缺口是 transaction fee 时，系统必须（MUST）允许从 Storage 补入完整 fee，即使 room Storage Energy 低于 floor/target 且正常 recovery feed capacity 为零。完整 fee 必须一次性放入物理 Terminal free；不得生成部分 fee，也不得借此 staging 新的非 Energy cargo。

#### Scenario: E3N59 形态只补手续费

- **WHEN** Terminal 已有本批非 Energy cargo、Energy 为零、物理空闲足以容纳完整 fee，而 Storage 的动作预算足够但低于 `energyTarget`
- **THEN** 系统只生成完整 fee 的 Energy feed，Carrier 完成后允许原 task 发送

#### Scenario: 物理空闲小于完整手续费

- **WHEN** Terminal 物理空闲小于完整 fee
- **THEN** 整个 staging batch 必须以 `terminal_headroom` 或等价原因被拒绝，不得生成部分 Energy feed

#### Scenario: Cargo 仍在 Storage

- **WHEN** 受压 Terminal 同时缺 non-Energy cargo 与 fee
- **THEN** 系统不得使用 fee bootstrap 例外把新 cargo 塞入 Terminal，必须先由恢复/offload 获得正常 staging headroom

### Requirement: 市场 readiness 不得使用房间 Energy 恢复水位

已授权 Direct seller 的 Storage→Terminal Energy readiness feed 不得（MUST NOT）保留 room `energyFloor/energyTarget`。它必须继续保护 production commitment、current effective post-deal reserve、至少 25,000 的市场 reserve、全部 pending send/fee、Terminal headroom、WAL、market exposure 和 action claim。

#### Scenario: Storage 低于 room floor 但市场所有权充足

- **WHEN** Direct seller 已授权，Storage Energy 低于 room `energyFloor`，但扣除 production 后足以补齐 current readiness target 且 Terminal headroom 安全
- **THEN** ResourceControl 必须生成精确 readiness feed，Direct 两次 full read 仍要求成交后满足 current effective reserve

#### Scenario: 生产或市场 reserve 不足

- **WHEN** 补给会消费 production commitment、使成交后低于 effective reserve、侵占 Terminal headroom 或冲突 action claim
- **THEN** readiness 必须保持 blocked，水位解耦不得放宽这些所有权与物理门禁

### Requirement: Ordinary Terminal reserve 不是 universal internal send floor

系统必须（MUST）把 ordinary `terminalEnergyReserve` 计入房间动作所有权和正常 Energy staging target，但不得（MUST NOT）在本能力中新增“所有 internal send 后 Terminal 实存必须仍达到该值”的统一门禁。真实 payload/fee、market exposure、receiver reservation、cooldown 与 action arbiter 仍须在写前重验；Direct market 的 current effective post-deal reserve 不受此例外影响。

#### Scenario: Capacity relief 发送后 Terminal 暂低于 ordinary reserve

- **WHEN** 受压 Terminal 中 cargo 已就位且只补入精确手续费，发送后 Terminal Energy 低于 ordinary reserve
- **THEN** internal capacity-relief send 可以成功，ordinary reserve 留待后续正常 staging 恢复；Direct market 不得继承该例外

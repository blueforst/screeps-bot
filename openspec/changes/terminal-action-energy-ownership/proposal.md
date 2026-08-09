## Why

当前跨房动作把房间的 Energy 恢复水位误当成库存所有权：非 Energy 任务仅为支付手续费，也会在 Storage Energy 低于 `energyTarget=200,000` 时被 `fee_budget` 阻塞；Energy 任务还会同时受到 donor `energyExportStart` 和 receiver `energyTarget` 的执行层截断。

E3N59 与 E7N58 已经存在健康的容量泄压任务，目标房也有安全容量，但任务仍因上述复用无法 staging。这里的 200,000 本来用于房间 Energy 恢复滞回和房内高耗能任务，不应再次否决已经取得 receiver reservation 的跨房动作。

## What Changes

- 新增“跨房动作 Energy 所有权预算”：从房间 Storage+Terminal 实存中仅扣除 ordinary Terminal Energy reserve、生产承诺、其他健康出站 Energy、其他任务手续费与既有市场 exposure；不读取 `energyFloor`、`energyTarget` 或 `energyExportStart`。
- 已存在的 manual、Hub、Synthesis、War 与 capacity-relief 转运任务在 executor 和 staging 中统一使用该预算；当前任务自身的 payload/fee commitment 只排除一次。
- 显式 Energy 转运不再按 receiver `energyTarget` 截断。自动 Energy 恢复仍可用 receiver `energyTarget` 计算需求、用 `energyExportStart` 选择是否新建无任务的自动平衡动作。
- 容量泄压可以选择 Energy 作为被搬资源，而不要求接收房存在 Energy 恢复缺口；接收端仍必须取得安全容量 reservation。
- 对 cargo 已经位于受压 Terminal 的非 Energy 任务，允许仅使用物理 Terminal 空闲补入完整手续费；不得借此继续把新的非 Energy cargo 塞入受压 Terminal。
- Direct seller readiness 的 Storage→Terminal 补能不再保留 room `energyFloor`，但继续保护 production commitment、current effective post-deal reserve、至少 25,000 的市场 reserve、Terminal headroom、WAL、exposure 与 action claim。
- 保持 ordinary `terminalEnergyReserve` 为日常 staging 目标和房间总量中的显式所有权；本变更不把它新增为所有 internal `terminal.send` 的通用 post-send 硬门槛，以免 E3N59 的精确手续费泄压路径再次被阻塞。

## Capabilities

### New Capabilities

- `terminal-action-energy-ownership`: 定义跨房 send/deal 与其 Storage→Terminal staging 的 Energy 所有权、显式任务执行边界和容量泄压手续费 bootstrap。

### Modified Capabilities

- `distributed-storage-capacity-relief`: 将生存/容量转运的 donor 保护从 room Energy 恢复水位改为显式动作所有权，同时保留自动需求与本地恢复语义。

## Impact

- 主要运行时：`src/runtime/resourceControl.ts`；新增一个不依赖 Game/Memory 的纯预算模块时，调用方仍由 ResourceControl 负责采集 commitment。
- 市场：只修改 ResourceControl 生成 Direct readiness feed 的 admission；不改 Direct planner、permit、WAL、policy revision、prepared deal 或 market action arbiter。
- 本地房间逻辑：`roomEnergyPolicy`、`autoReserveFlag`、Nuker、生产与其他房内高耗能任务继续使用 `energyFloor/energyTarget`，不在本切片修改。
- 自动 Energy 恢复：保留 `energyTarget` 的 receiver need 与 `energyExportStart` 的新动作生成策略；仅已有动作的库存所有权和执行不再重复套水位。
- Memory/API：不新增持久 schema，不改变任务 ID、reason、Carrier task ABI、receiver lease 或主循环 phase 顺序。
- 回滚：部署父提交即可恢复旧 admission；没有数据迁移，但会重新出现 E3N59/E7N58 的 `fee_budget` 阻塞。

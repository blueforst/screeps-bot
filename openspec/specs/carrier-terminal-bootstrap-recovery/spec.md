# carrier-terminal-bootstrap-recovery 规范

## Purpose

定义房间级 Terminal Energy bootstrap 的显式准入、物流保护、稳定恢复退出与周期清理合同。

## Requirements

### Requirement: Terminal bootstrap 必须显式按房间准入
系统 SHALL 仅在 `terminalBootstrapRecoveryRooms[roomName]` 显式为 true 时启用该房 bootstrap。准入只可用于物理位于该房、assigned room 相同的 carrier 为本房 Spawn/Extension 取 Energy；未启用房间和其他 pickup 路径 SHALL 保持既有行为。

#### Scenario: 房间未启用 recovery flag
- **WHEN** 本房 Spawn/Extension 缺 Energy，但该房没有显式 recovery flag
- **THEN** carrier SHALL 继续使用既有 50,000 Terminal Energy pickup reserve，不得使用 bootstrap 余量

#### Scenario: 显式启用本房 recovery
- **WHEN** 房间 flag 为 true、本房 Spawn/Extension 缺 Energy 且本地 carrier 没有其他 Energy 来源
- **THEN** carrier SHALL 可将本房 Terminal 高于 recovery reserve 的 Energy 作为 pickup 候选

#### Scenario: 其他房间不得继承 flag
- **WHEN** A 房启用了 recovery flag，而 carrier 物理位于 B 房或 assigned room 为 B 房
- **THEN** 系统 MUST NOT 因 A 房 flag 降低 B 房 Terminal reserve 或从 B 房 Terminal 领取 bootstrap Energy

### Requirement: Bootstrap pickup 必须保留全部物流保护
启用 recovery 时，系统 MUST 以该房 ResourceControl `terminalEnergyReserve` 为不可领取底线，并 SHALL 继续应用 pickup reservation、market exposure 外余量和同 tick terminal action claim。Terminal 最终 withdraw amount MUST 不大于该 creep 当前实际 pickup reservation claim amount。系统 MUST NOT 通过 bootstrap 改变跨房 transfer、市场或 Terminal feed/offload 的库存所有权。

#### Scenario: Terminal 只有 reserve 加一个 carrier 批次
- **WHEN** Terminal Energy 等于 recovery reserve 加 500，而 carrier 空闲容量为 800
- **THEN** 本次可领取量 MUST 最多为 500，领取后 Terminal 不得低于 recovery reserve

#### Scenario: Energy 已被 market exposure 保护
- **WHEN** recovery reserve 之上部分 Energy 已被 market exposure 全部保护
- **THEN** carrier SHALL 不领取该部分 Energy

#### Scenario: Terminal 已有同 tick action claim
- **WHEN** 跨房发送或其他系统已持有该房本 tick Terminal action claim
- **THEN** bootstrap carrier SHALL 不提交 Terminal withdraw intent

#### Scenario: 两个 carrier 同 tick 竞争同一份 reserve 余量
- **WHEN** Terminal 有 21,000 Energy、recovery reserve 为 20,000，两个 free capacity 均为 800 的 carrier 在同 tick 依次请求，且没有 market exposure
- **THEN** pickup reservation SHALL 分配 800 与 200，两个最终 withdraw 请求总量 MUST 不超过 1,000

#### Scenario: 重取时实际 claim 缩小
- **WHEN** carrier 原 claim 为 800，但重新 reserve 时当前安全可用量只剩 500
- **THEN** reservation getter SHALL 返回 500，最终 Terminal withdraw 请求 MUST 不超过 500

### Requirement: Recovery flag 必须基于稳定证据自动退出
系统 SHALL 仅在非 spawning canonical managed carrier 与本地 managed miner 均存活、房间 Energy 达到至少 50% capacity 且不低于 300，并连续保持 25 tick、期间没有成功 bootstrap Terminal pickup 时，自动删除该房 recovery flag 与 runtime 观测。单 tick 高水位、spawning creep、manual carrier 或观测中断 MUST NOT 单独触发退出。

#### Scenario: 连续稳定恢复后退出
- **WHEN** canonical carrier 和本地 miner 已存活，房间 Energy 连续 25 tick 达到可持续门槛，且窗口内没有 bootstrap Terminal pickup
- **THEN** 系统 SHALL 自动删除该房 flag 与 runtime 状态，后续恢复既有 50,000 reserve

#### Scenario: 单 tick Energy 偶然升高
- **WHEN** 房间仅一个 tick 达到可持续门槛，随后下降或任一 managed role 缺失
- **THEN** 系统 MUST 重置稳定窗口并保留 recovery flag

#### Scenario: 稳定窗口内再次依赖 Terminal
- **WHEN** 连续恢复计时尚未完成且 carrier 成功领取 bootstrap Terminal Energy
- **THEN** 系统 MUST 重置稳定窗口，不得把该次取能造成的供能状态视为独立恢复

#### Scenario: 只有 spawning 或 manual carrier
- **WHEN** 房间只有 `spawning === true` 的 canonical carrier，或只有 manual carrier，而没有 non-spawning canonical managed carrier
- **THEN** 系统 MUST NOT 推进自动退出稳定窗口

### Requirement: Recovery runtime 必须由周期清理最终回收
系统 SHALL 在既有周期 Memory cleanup 中删除对应 room flag 不严格为 true 的 `terminalBootstrapRecovery` runtime entry。清理后若 `terminalBootstrapRecovery` 或其父 `energyPickup` 容器为空，系统 SHALL 删除空容器；仍有 true flag 的 entry MUST 保留。

#### Scenario: flag 为 false 或已经删除
- **WHEN** 周期 Memory cleanup 运行，某 recovery runtime entry 对应的 room flag 为 false 或不存在
- **THEN** 系统 SHALL 删除该 entry，并收缩由此产生的空 runtime 容器

#### Scenario: flag 仍为 true
- **WHEN** 周期 Memory cleanup 运行，某 recovery runtime entry 对应的 room flag 严格为 true
- **THEN** 系统 MUST 保留该 entry，交由正常观测与稳定退出逻辑继续管理

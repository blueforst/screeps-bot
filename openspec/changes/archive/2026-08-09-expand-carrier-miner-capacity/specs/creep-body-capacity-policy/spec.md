## ADDED Requirements

### Requirement: 通用 carrier 最大容量
系统 SHALL 为通用 1:1 carrier 生成最高 1000 携带容量的身体，并保持 `CARRY:MOVE = 1:1`，同时不得超过可用能量预算或 50 部件上限。

#### Scenario: 房间能量足以生成最大 carrier
- **WHEN** 身体生成入口获得至少 2000 能量预算
- **THEN** 系统生成 20 个 CARRY 和 20 个 MOVE，携带容量为 1000

#### Scenario: 房间能量不足以生成最大 carrier
- **WHEN** 身体生成入口获得的能量预算低于 2000 但足以生成至少一组 CARRY 与 MOVE
- **THEN** 系统仅生成预算可承担的完整 `CARRY + MOVE` 组，并保持两类部件数量相等

### Requirement: carrier 入口策略一致
系统 SHALL 让常规 `carrier`、常规 `remoteCarrier`、应急 `maxcarrier` 与 HAUL 旗帜搬运使用同一通用 carrier 身体策略。

#### Scenario: 不同入口使用相同预算
- **WHEN** 常规 profile、应急生成或 HAUL 配置以相同能量预算生成通用 carrier
- **THEN** 各入口得到相同的部件顺序、容量与上限

### Requirement: link miner 容量与移动比例
系统 SHALL 为 link miner 配置 8 个 CARRY 以提供 400 携带容量，并按每 2 个非 MOVE 部件至少配置 1 个 MOVE，同时保留按 `REGEN_SOURCE` 等级计算的 WORK 数。

#### Scenario: 没有 REGEN_SOURCE 技能
- **WHEN** 房间没有已归属且拥有 `PWR_REGEN_SOURCE` 的 Power Creep
- **THEN** 系统生成 6 个 WORK、8 个 CARRY 和 7 个 MOVE 的 miner 身体

#### Scenario: 四级 REGEN_SOURCE 技能
- **WHEN** 房间已归属的 Power Creep 拥有 4 级 `PWR_REGEN_SOURCE`
- **THEN** 系统生成 12 个 WORK、8 个 CARRY 和 10 个 MOVE 的 miner 身体

### Requirement: miner 安全换代
系统 MUST 在目标 miner 身体因容量或移动比例变化时沿用先补后退交接，不得在新体型抵达可交接位置前退役旧 miner。

#### Scenario: 旧体型 miner 仍在 Source 工作
- **WHEN** 现役 miner 与新目标身体不同且替代者尚未抵达 Source 范围或单入口交接位置
- **THEN** 系统保留旧 miner 并仅安排唯一的新体型替代者

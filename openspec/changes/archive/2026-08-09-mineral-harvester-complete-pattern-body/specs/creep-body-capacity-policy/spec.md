## ADDED Requirements

### Requirement: mineralHarvester 仅使用完整采集组合
系统 SHALL 仅以完整的 `WORK + WORK + MOVE` 组合构造自动管理的 mineralHarvester 身体，并同时受房间能量容量和 50 部件上限约束。当剩余部件槽或能量不足以容纳下一完整组合时，系统 MUST 停止增长，不得追加残缺组合。

#### Scenario: 能量刚好支持第十六组
- **WHEN** 房间能量容量为 4000
- **THEN** 系统生成 16 个完整组合，即 32 个 WORK、16 个 MOVE 和 48 个总部件

#### Scenario: 能量尚不足第十六组
- **WHEN** 房间能量容量为 3999
- **THEN** 系统只生成 15 个完整组合，即 30 个 WORK、15 个 MOVE 和 45 个总部件

#### Scenario: 能量足够第十七组但部件上限不足
- **WHEN** 房间能量容量至少为 4250
- **THEN** 系统仍生成 16 个完整组合和 48 个总部件，并保留两个未使用槽位，不得追加两个 WORK

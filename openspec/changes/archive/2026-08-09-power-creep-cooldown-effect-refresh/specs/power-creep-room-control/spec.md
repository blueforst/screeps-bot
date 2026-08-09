## MODIFIED Requirements

### Requirement: OPERATE_STORAGE 调度
系统 SHALL 将 `OPERATE_STORAGE` 作为最高优先级的普通技能，并在 cooldown 完成时立即覆盖同级或更低级的有效同类 effect；只有目标上的有效同类 effect 等级高于当前技能等级时才等待。

#### Scenario: Storage 尚无效果
- **WHEN** 已归属 PC 拥有 `PWR_OPERATE_STORAGE` 且 Storage 没有有效同类 effect
- **THEN** 系统持续保留唯一的最高普通优先级 `operate_storage` 任务，并在技能、OPS 和距离条件满足的首个 tick 执行

#### Scenario: cooldown 完成而旧效果同级或更低级
- **WHEN** `PWR_OPERATE_STORAGE` cooldown 为零且 Storage 存在等级不高于当前技能的有效同类 effect
- **THEN** 系统立即插入并执行维护任务，以新的 effect 覆盖旧 effect，不等待旧 effect 结束

#### Scenario: Storage 存在更高级效果
- **WHEN** `PWR_OPERATE_STORAGE` cooldown 为零且 Storage 存在等级高于当前技能的有效同类 effect
- **THEN** 系统保留唯一维护任务但不得对 Storage 调用 `usePower()`，直到更高级 effect 不再有效，同时不得阻断其他可执行的 effect 任务

#### Scenario: 维护任务缺少 OPS
- **WHEN** `operate_storage` 维护任务因 OPS 少于 100 暂不可执行
- **THEN** 系统允许已就绪的 `GENERATE_OPS` 及其他 runnable 任务按正常优先级越过该任务；当本 tick 选择 `GENERATE_OPS` 或没有位置型 runnable 任务时继续以 Storage 为预定位目标

#### Scenario: Storage 效果缺失且技能可用
- **WHEN** Storage 没有有效同类 effect、技能 cooldown 为零且 PC 拥有至少 100 OPS
- **THEN** 系统在第一个可执行 tick 使用 `PWR_OPERATE_STORAGE` 并完成当前维护任务

### Requirement: REGEN_SOURCE 交替调度
系统 SHALL 对归属房间两个 Source 按稳定顺序交替使用 `REGEN_SOURCE`，在 cooldown 完成时立即为下一 Source 入队；目标上没有有效同类 effect 或 effect 等级不高于当前技能时立即覆盖，只有更高级 effect 才等待，并且仅在成功施法后切换目标。

#### Scenario: cooldown 完成时下一 Source 为同级或更低级效果
- **WHEN** `PWR_REGEN_SOURCE` cooldown 为零且下一 Source 存在等级不高于当前技能的有效同类 effect
- **THEN** 系统立即插入唯一任务并调用 `usePower()` 覆盖旧 effect，不等待其结束

#### Scenario: 下一 Source 存在更高级效果
- **WHEN** 已入队目标存在等级高于当前 `PWR_REGEN_SOURCE` 技能的有效同类 effect
- **THEN** 系统保留任务且不得对该 Source 调用 `usePower()`、不得切换下一目标，直到更高级 effect 不再有效，同时允许其他 runnable 任务继续执行

#### Scenario: 下一 Source 没有有效效果
- **WHEN** 已入队目标没有有效 `PWR_REGEN_SOURCE` effect、技能 cooldown 为零且 PC 满足 OPS 和距离条件
- **THEN** 系统在首个可执行 tick 调用 `usePower()`

#### Scenario: 成功覆盖后轮换
- **WHEN** 对当前 Source 调用 `PWR_REGEN_SOURCE` 返回 `OK`
- **THEN** 系统完成当前任务并将下一目标切换到另一个 Source

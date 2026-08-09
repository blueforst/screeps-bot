## ADDED Requirements

### Requirement: Defense Mode 读取必须属于 current tick
系统 MUST 在 `isDefenseMode(roomName)` 首次读取或 `runDefenseMode()` 显式预热时，使用该时点可见的 Game 与 Memory 构建当前 Game/tick 的 Defense Mode snapshot，不得把上一 tick cache 或 global reset 后的未初始化状态作为当前结果。

#### Scenario: updater phase 之前首次读取
- **WHEN** 任一早期消费者在本 tick 的 `runDefenseMode()` 之前查询己方房间
- **THEN** 系统必须先构建 current-tick snapshot，再返回该房间的真实防御状态

#### Scenario: global reset 后首次读取
- **WHEN** global reset 发生且本 tick 尚未显式预热 Defense Mode
- **THEN** 首次查询必须按当前 Game 状态重建，不得因 heap cache 为空默认返回 `false`

### Requirement: 同一稳定输入世代必须共享完整 snapshot
系统 MUST 以当前 `Game.time` 与 Game 对象身份作为 cache epoch，并记录 snapshot 构建时每个己方房间的安全区规划 revision。snapshot 成功发布后，规划 revision 不变时所有消费者和后续 `runDefenseMode()` MUST 复用同一份完整 snapshot，正常成功路径中的每个己方房间最多计算一次。tick 或 Game identity 变化时 MUST 重新构建；构建失败后的完整重试允许重新计算失败前已处理的房间。

固定 phase 的 `runDefenseMode()` MUST 核对已发布 revision；若 Room Planner 在早期 snapshot 后同 tick 更新任一己方房间的 revision，系统 MUST 原子重建全房 snapshot 后再供晚期消费者读取。正常 tick 最多构建一次；发生规划 revision 变化的 tick 最多构建两次。

#### Scenario: 同 tick 多次查询与显式预热
- **WHEN** 多个消费者查询不同房间，随后主循环执行 `runDefenseMode()`，且安全区规划 revision 未变化
- **THEN** 系统必须只构建一次 snapshot，后续调用不得重复扫描或改变结果

#### Scenario: hostile 在相邻 tick 消失
- **WHEN** 房间在 tick N 有危险 hostile、tick N+1 已无危险 hostile
- **THEN** tick N 的所有读取保持 `true`，tick N+1 首次读取重建并返回 `false`

#### Scenario: Room Planner 在 snapshot 发布后生成安全区
- **WHEN** 本 tick snapshot 已因房间无规划安全区而发布为 `false`，Room Planner 随后在同一 tick 生成安全区
- **THEN** 生成前的早期消费者保持既有结果，固定 phase 的 `runDefenseMode()` 必须检出 revision 变化并原子重建，使晚期消费者在本 tick 读取结合新安全区的状态

#### Scenario: 相同 tick 替换 Game 对象
- **WHEN** 测试或运行容器在相同 `Game.time` 下替换 Game 对象，并同时提供该 Game 对应的 current TickContext
- **THEN** Defense snapshot 必须把它视为新 epoch并重新请求 TickContext，不得复用自身旧 snapshot

### Requirement: 现有 Defense 判定必须保持兼容
系统 MUST 只为可见己方房间计算 Defense Mode；无规划安全区、未知房间或非己方房间 MUST 返回 `false`。Source Keeper MUST 排除；Invader 只有存在有效 WORK 或 HEAL 时才纳入；其他玩家 creep 只有存在有效 ATTACK、RANGED_ATTACK、WORK 或 HEAL 时才纳入。

#### Scenario: 两个己方房间状态不同
- **WHEN** 一个有安全区的己方房间存在危险玩家 creep，另一个己方房间无安全区或无危险 hostile
- **THEN** 同一 snapshot 必须分别返回 `true` 与 `false`

#### Scenario: 不触发 Defense 的 NPC
- **WHEN** 房内只有 Source Keeper，或只有不带 WORK/HEAL 的 Invader
- **THEN** Defense Mode 必须保持 `false`

### Requirement: Snapshot 发布必须原子化
系统 MUST 先在局部状态中完成全部己方房间计算，再发布 snapshot 与 epoch；初次构建、revision 核对或 revision 重建失败时 MUST 继续沿现有调用栈抛出异常，不得发布半份 current-tick snapshot，也不得把失败默认为安全。若失败发生在同 epoch 的第二代重建，系统 MUST 使旧 generation 失效，使下一次普通读取完整重试而非返回旧状态。

#### Scenario: 中途计算失败
- **WHEN** 多房 snapshot 在某个房间计算时抛出异常
- **THEN** 新 epoch 不得提交，异常必须传播，下一次调用必须重新尝试完整构建

#### Scenario: 规划 revision 重建中途失败
- **WHEN** 固定 updater 检出规划 revision 变化，但第二代多房 snapshot 在某个房间计算时抛出异常
- **THEN** 异常必须传播且旧 generation 必须失效，下一次普通 `isDefenseMode()` 必须重新尝试完整构建

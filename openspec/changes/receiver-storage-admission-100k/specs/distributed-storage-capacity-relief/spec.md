## MODIFIED Requirements

### Requirement: 容量压力独立判断并使用滞回

系统 SHALL 将每个同时拥有 Storage 与 Terminal 的己方房间独立于能量状态分类为 `normal`、`pressure` 或 `emergency`。任一结构剩余容量为零时 SHALL 进入 emergency；previous normal/缺失时仅在剩余容量严格低于配置 pressure threshold 时进入 pressure，exact threshold 为 normal 但零安全容量的饱和边界；previous pressure/emergency 时只有 Storage 与 Terminal 都达到配置恢复水位后才返回 normal。

#### Scenario: 任一结构满仓即为 emergency

- **WHEN** 己方房间的 Storage 或 Terminal 任一剩余容量为零
- **THEN** 无论 Storage Energy 为多少，该房间容量状态均为 `emergency`

#### Scenario: Fresh exact threshold 保持 normal

- **WHEN** previous state 为 normal，Storage/Terminal free 恰好等于对应 pressure threshold且另一结构安全
- **THEN** 房间保持 normal但安全可接收量为零

#### Scenario: 滞回区间内继续保持 pressure

- **WHEN** 使用默认值时，已受压房间不再满仓，但 Storage 剩余容量低于 200,000 或 Terminal 剩余容量低于 80,000
- **THEN** 房间继续保持 `pressure`

#### Scenario: 两个结构均恢复

- **WHEN** 使用默认值时，受压房间的 Storage 剩余容量至少为 200,000 且 Terminal 剩余容量至少为 80,000
- **THEN** 房间返回 `normal`

### Requirement: 缓解接收房必须保留安全容量

系统 SHALL 仅向同时拥有 Storage 与 Terminal、状态为 normal 且达到配置接收准入水位的己方房间创建新缓解路径。默认 receiver Storage minimum为100,000、Terminal minimum为50,000，Storage receiver minimum与200,000恢复水位相互独立。每次发送 SHALL 精确保留100,000 Storage与40,000 Terminal pressure安全缓冲；pressure或emergency房间 SHALL NOT 接收容量缓解库存。

#### Scenario: 接收房通过准入

- **WHEN** 使用默认值时，normal房间至少有100,000 Storage剩余容量和50,000 Terminal剩余容量
- **THEN** 该房间可作为新容量缓解路径的接收房；若safe capacity为零则不得创建任务

#### Scenario: Free150k接收50k

- **WHEN** normal receiver有150,000 Storage剩余容量、足够Terminal容量且没有其他commitment
- **THEN** 最多可以接收50,000并恰好保留100,000 Storage空闲

#### Scenario: 发送量受接收端缓冲限制

- **WHEN** pending缓解任务会使接收房Storage剩余容量低于100,000或Terminal剩余容量低于40,000
- **THEN** 发送量限制为两个安全容量中的较小值，且不得越过任一缓冲

#### Scenario: 没有安全接收房

- **WHEN** 所有其他己方房间均处于压力状态、低于接收准入水位或安全可接收量为零
- **THEN** 系统不得创建不安全的缓解转运，来源房继续以可观测方式保持受压

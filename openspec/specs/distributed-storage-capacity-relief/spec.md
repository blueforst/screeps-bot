# distributed-storage-capacity-relief 规范

## Purpose

定义己方房间 Storage/Terminal 容量压力的独立滞回、受保护的跨房缓解路径及禁止市场变现的安全合同。
## Requirements
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

### Requirement: 缓解规划有界且确定
系统 SHALL 通过 reason 为 `capacity:relief:<resource>` 的资源转运任务执行容量缓解。每个来源房最多保留一个健康的 pending 缓解任务；每轮规划中每个来源房最多创建或替换一个、全局最多五个此类任务；默认单任务上限为 50,000 单位。

#### Scenario: 每个受压来源房只有一条路径
- **WHEN** 受压来源房已经存在健康的 pending capacity-relief 任务
- **THEN** 规划器不得为该来源房创建重复缓解任务

#### Scenario: 接收房排序稳定
- **WHEN** 同一资源存在多个合格接收房
- **THEN** 规划器依次按更大安全容量、更低接收房库存、更低交易成本和房间名排序

#### Scenario: 替换不安全的既有接收房
- **WHEN** 既有自动缓解任务因 receiver capacity 阻塞，且存在另一个合格接收房
- **THEN** 系统取消旧任务并创建一个替代任务，且不得重复预留数量

### Requirement: 缓解优先移动最有效的安全余量
系统 SHALL 优先移动受压 Terminal 中已经存在的可搬运非 Energy 库存，在 Terminal 恢复后再移动 Storage 的可搬运余量。可搬运库存 SHALL 扣除所有配置底仓、T3 reserve、活动生产预留、有效出站承诺和 Energy 发送费用。

#### Scenario: Terminal 库存形成即时通道
- **WHEN** Terminal 低于恢复水位且包含可搬运非 Energy 资源
- **THEN** 系统先选择数量最大的可搬运 Terminal 资源，再考虑仅存在于 Storage 的资源

#### Scenario: Storage 余量通过 staging 搬运
- **WHEN** Terminal 已满足恢复水位、Storage 仍受压且存在可搬运 Storage 余量
- **THEN** 系统创建缓解任务，并由既有 carrier task 机制把所选资源搬入 Terminal

#### Scenario: Terminal 压力覆盖既有 Storage 路径
- **WHEN** 自动 Storage-only 缓解路径仍 pending 时，Terminal 剩余容量降至恢复水位以下
- **THEN** Storage staging 停止，并把路径替换为可搬运的 Terminal 现存资源；没有安全资源时取消路径

#### Scenario: 生产预留受到保护
- **WHEN** 某资源的一部分由活动 synthesis、boost、factory 或其他生产预留覆盖
- **THEN** 只有高于该预留和其他安全底线的库存可用于缓解

#### Scenario: T3 reserve 受到保护
- **WHEN** 房间包含 T3 boost 化合物
- **THEN** 使用默认值时，每种化合物至少在该房间保留 5,000 单位

### Requirement: 生存 Energy 使用受保护的总库存

系统 SHALL 从 Storage 与 Terminal 的 Energy 总量计算已存在跨房动作的 donor 可用量，同时保留 ordinary Terminal Energy reserve、有效生产预留、其他出站承诺、其他交易费用和市场 exposure。Donor `energyFloor`、`energyTarget` 与 `energyExportStart` 只可用于房间状态、本地高耗能任务、接收恢复需求或无任务自动平衡策略，不得再次否决 manual、Hub、Synthesis、War 或 capacity-relief 的已有任务。生存 Energy 支援 SHALL 先于自动容量缓解运行。

#### Scenario: Terminal-heavy donor 可以履行任务

- **WHEN** donor 的 Energy 总量高于全部显式所有权，即使 Storage Energy 单独低于 floor/target/exportStart
- **THEN** 超出显式所有权的部分可用于已存在的跨房任务

#### Scenario: 显式所有权优先

- **WHEN** 拟发送 Energy 或对应费用会穿透 ordinary Terminal reserve、production、其他 task/fee commitment 或 market exposure
- **THEN** 系统减少发送量或跳过发送

#### Scenario: Receiver target 只定义自动恢复需求

- **WHEN** 系统计算无任务自动 Energy 恢复需求
- **THEN** 可以继续使用 `energyTarget-storageEnergy`；已有显式 task 不得因该需求为零而被取消或截断

### Requirement: 容量缓解不得通过市场变现
容量压力 SHALL 只生成己方房间之间的转运任务。系统 SHALL NOT 创建市场订单、执行 market deal、扩大配置的可售资源范围或放宽配置售价。

#### Scenario: 满仓房间没有接收方
- **WHEN** 房间已满且没有合格的己方接收房
- **THEN** 容量缓解子系统等待并报告 blocker，不得出售该资源

## ADDED Requirements

### Requirement: 只有健康且近期可执行的任务可以占用 staging

系统必须（MUST）按现有任务优先级和创建时间为每个 source room 选择有界发送窗口。只有 pending、来源与目标有效、来源总库存可用、receiver 已取得安全 reservation，且能在当前或下一个本房 terminal 发送机会执行的任务，才可以生成或保留 terminal feed。

#### Scenario: receiver capacity 阻塞任务不再预装载

- **WHEN** 一个 pending 非 energy 任务被 `receiver_capacity` 阻塞
- **THEN** 系统不得为该任务生成 terminal feed，且下一次同步必须移除仅由该任务产生的旧 feed

#### Scenario: source depleted 任务不占用 staging

- **WHEN** 任务标记为 `source_depleted`，或来源 storage 与 terminal 的安全可用总量为零
- **THEN** 系统不得为该任务保留 staging，即使任务记录尚未被 TTL 清理

#### Scenario: 下一发送窗口的任务可以装载

- **WHEN** source terminal 正在 cooldown，但最高优先级任务的 receiver reservation、来源库存和 fee 均有效，且任务将在 cooldown 结束后的下一个发送机会执行
- **THEN** 系统可以为该任务装载一个安全批次，但不得同时为更后面的任务耗尽保留 headroom

### Requirement: staging 数量必须受完整安全上限约束

terminal feed 数量必须（MUST）不大于任务剩余量、房间 transfer batch、receiver reservation、terminal 安全可用空闲、来源安全可用库存五者的最小值。非 energy 发送还必须预留足够的 terminal energy reserve 与预计交易费；系统不得（MUST NOT）通过 staging 绕过现有矿物、T3、生产或 energy 保护规则。

#### Scenario: 小尾数只装载实际剩余量

- **WHEN** 一个已获 admission 的任务只剩 25 单位，而 transfer batch 为 10,000
- **THEN** feed 数量最多为 25，且不得因批次取整额外占用 terminal

#### Scenario: fee 不足时不错误装载资源

- **WHEN** storage 中有发送资源，但 terminal 与安全可用 energy 无法支付预计交易费
- **THEN** 系统不得生成该资源的 feed，并必须报告 fee 不足而不是笼统地将其视为可 staging

#### Scenario: receiver reservation 限制 staging

- **WHEN** 任务剩余 10,000，但本轮 receiver reservation 只有 3,000
- **THEN** feed 数量不得超过 3,000

### Requirement: blocker 变化必须及时释放或恢复 staging

系统必须（MUST）在每次 terminal logistics 同步时重新验证 admission。条件失效时必须移除旧 feed；条件恢复且任务重新进入本房发送窗口时必须自动恢复 feed，无需重建持久跨房任务。

#### Scenario: admission 失效后释放空间

- **WHEN** 已生成 feed 的任务在下一轮因 receiver 进入 pressure 而失去 admission
- **THEN** 对应 feed 必须被移除，且其已在 terminal 的非受保护资源可以成为 offload 候选

#### Scenario: receiver 恢复后重新装载

- **WHEN** 原任务仍为 pending，receiver 后续恢复并重新取得 reservation
- **THEN** 系统必须按当前发送窗口重新生成 feed，而不得要求 producer 重发相同任务

### Requirement: feed 与 offload 不得产生冲突工作

对于同一房间、同一资源和同一轮同步，系统不得（MUST NOT）同时生成方向相反且相互抵消的 terminal feed 与 offload。只有当前获 admission 的 staging 才能作为受保护 terminal 库存；已阻塞或被抑制任务的目标量不得阻止恢复性 offload。

#### Scenario: 被抑制 staging 可以排空

- **WHEN** terminal 中的某非 energy 资源只对应一个已被 `receiver_capacity` 抑制的任务，且房间需要恢复 headroom
- **THEN** 系统可以生成该资源的 offload，并不得在同轮重新生成对应 feed

#### Scenario: 已获 admission staging 不被排空

- **WHEN** 某资源已为当前发送窗口的健康任务取得 admission 并完成 staging
- **THEN** 系统不得为该批资源生成冲突 offload

### Requirement: staging admission 必须可观测且计算有界

系统必须（MUST）报告每房 admitted staging 的资源、数量、关联任务数，以及按 blocker 分类的 suppressed staging 数量。一次 ResourceControl 运行必须（MUST）复用同一任务/容量索引，不得为 planner、executor 和 feed sync 分别重建全量索引。

#### Scenario: 观测区分装载与抑制

- **WHEN** 同一 source room 有一个已获 admission 的任务和两个分别因 receiver capacity、fee 不足而被抑制的任务
- **THEN** runtime 必须分别报告 admitted 数量与两类 suppressed 原因

#### Scenario: 多阶段复用索引

- **WHEN** 一次 ResourceControl 周期依次执行 capacity planning、task execution 和 terminal feed sync
- **THEN** 三个阶段必须读取同一轮构建的 commitment/reservation index，且测试应能证明不会重复计算已登记容量

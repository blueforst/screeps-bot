# War Workflow Lifecycle Ownership 规格

## Purpose

定义 War owner 对生产、Spawn、成员与 Boost 资产的精确所有权，以及终态、换代、配对、外部 purge 和 GC 的领域生命周期合同。

## Requirements

### Requirement: War owner 精确拥有其生产与执行资产
系统 MUST 以 exact War store entry、source/target scope及可选 generation/component 证明 owner；owner 资产 MUST 包含其 creep configs、所有 Spawn queue引用、native spawning/CreepMemory owner引用、live成员与 Boost reservation。系统 MUST NOT 仅凭裸 role、成员索引或跨owner字符串替换借用资产。

#### Scenario: 同目标 owner 的资产集合可完整枚举
- **WHEN** 一个 War task 同时具有 standard或generation config、多个Spawn queue副本、正在出生成员、存活成员与Boost授权
- **THEN** 领域释放必须从该exact owner得到完整资产集合，且不得触碰其它source/target/generation的同角色资产

#### Scenario: Patrol generation 保留旧 configName
- **WHEN** patrol owner 已原子切换到下一target，而active generation configName仍含初始target
- **THEN** owner解析必须使用task记录的generation config identity释放这些资产，不得只扫描当前target前缀后漏掉它们

### Requirement: Terminal transition 同 tick 停止生产并释放授权
War task进入`done`或`failed`时 MUST 在同一领域事务写入terminal status与`completedAt`、移除全部queue引用、删除所有production config、断开spawning/live成员的owner引用并释放Boost；资产收敛完成后 MUST 写`assetsReleasedAt`作为只读闭合证据。该事务 MUST 幂等。默认策略 MUST NOT 强制已出生成员suicide，但必须使其成为detached executor，未来不得因其死亡重新生产。

#### Scenario: Done时仍有存活成员
- **WHEN** target完成且owner仍有live attacker/healer及普通非spawnOnce config
- **THEN** task必须成为`done`并保留可观测owner记录，config与queue必须立即消失，成员保持存活但不再携带owner config引用，后续SpawnPlanner不得重建该编队

#### Scenario: Failed时仍有正在出生成员
- **WHEN** staging timeout或Boost failure发生且owner config正被Spawn执行
- **THEN** 系统必须尝试取消native spawning，并无论cancel结果如何都断开对应CreepMemory owner引用、删除config/queue、释放Boost且写`failed/completedAt`

#### Scenario: Terminal事务重复执行
- **WHEN** 同一terminal task在后续tick再次经过release或GC前置清理
- **THEN** status、completedAt与其它owner资产不得被重复创建或转移，释放计数除仍存在的残余外必须为0

#### Scenario: Legacy terminal缺少释放证据
- **WHEN** WarControl首次观察到`done/failed`但没有合法`assetsReleasedAt`的legacy owner
- **THEN** War领域必须幂等补做资产释放并写入当前tick证据；只读projection在收敛前必须保留非致命unconfirmed诊断

### Requirement: one-shot generation耗尽具有显式终态
已部署的t3Duo generation成员少于完整二人组且task为one-shot时，War领域 MUST 将task转为`failed`、写机器可读`failReason=generation_exhausted`与`completedAt`，释放production/Boost，并按既有策略detach survivor；不得只返回并让task永久停在非终态。

#### Scenario: one-shot只剩一名survivor
- **WHEN** deployed one-shot generation下一tick只观察到attacker或healer之一
- **THEN** survivor必须保持存活但detached，owner必须进入`failed:generation_exhausted`，且后续tick不得创建下一代或再次生产原generation

#### Scenario: 非one-shot仍可换代
- **WHEN** deployed非one-shot generation少于二人
- **THEN** 系统必须保持现有replacement generation语义，清理旧generation后创建单调递增的新generation，而不得误转terminal

### Requirement: Squad pairing由producer显式声明
每个需要formation协调的War config MUST 在role args中携带exact partner config identity；明确无partner的成员 MUST 携带空配对事实。Melee与Healer MUST 只使用自身显式exact partner；会同时驱动双方移动的Traffic换位 MUST 验证reciprocal exact partner。任何formation消费者都不得从自身configName做角色名/索引替换推断；detached成员不得恢复运行时配对标记。

#### Scenario: Standard 2攻1疗配对
- **WHEN** standard producer创建attacker0、attacker1与healer0
- **THEN** attacker0与healer0必须互相声明exact partner，attacker1必须声明无partner并可独立向target推进

#### Scenario: T3 duo代际配对
- **WHEN** t3Duo generation创建attacker与healer config
- **THEN** 两者必须按同一generation exact config identity互相配对，Boost task/compound参数位置与内容保持既有语义

#### Scenario: Legacy member缺少显式partner
- **WHEN** owner/config已不存在且survivor仅能从旧CreepMemory roleArgs恢复、其中没有partner字段
- **THEN** role必须按unpaired执行且不得永久hold，也不得借用同房其他War owner的成员

### Requirement: Owner purge只能经过领域释放命令
Colonization handoff/source变更/defense暂停/abandon、MemoryCleanup、console stop、patrol collision与owner restart MUST 通过War领域exact release/purge命令；生产代码中War领域外不得直接删除`Memory.data.war` entry。Purge MUST 先释放owner资产再删除record，且不得影响其它owner。

#### Scenario: Colonization完成NPC清理
- **WHEN** Colonization观察到War task为done并继续claiming
- **THEN** 它必须调用War领域命令释放并删除exact owner，不得只删除Memory record或留下config/queue/Boost

#### Scenario: Source room改变或进入defense mode
- **WHEN** Colonization在War仍active时更换source或暂停任务
- **THEN** 旧War owner必须停止生产、detach成员、释放Boost并被exact purge，新source不得继承旧owner资产

#### Scenario: Colonization在clearing期间abandon
- **WHEN** flag被删除或其它abandon原因发生且Colonization task仍拥有War clearing workflow
- **THEN** abandon路径必须调用War领域purge gateway，不能只删除Colonization记录后留下孤立War owner

#### Scenario: Restart覆盖terminal或异源owner
- **WHEN** `requestWarRoomClear`准备覆盖terminal task或同target不同source task
- **THEN** 系统必须先释放旧owner资产，再写新attempt；复用的standard configName不得把旧detached survivor计入新owner

#### Scenario: Console默认停止与强制停止
- **WHEN** 调用`stopWarRoom`且`suicide`分别为false或true
- **THEN** 两种路径都必须释放production/Boost并删除owner；false必须detach且保留成员生命，true必须按既有console语义尝试suicide

### Requirement: Terminal owner按稳定终态时间回收
Terminal owner的GC年龄 MUST 使用`completedAt`，legacy缺失时依次回退`statusSince`与`createdAt`；不得使用每tick观测可能刷新的`updatedAt`作为唯一年龄。到期GC MUST 调用exact owner purge命令。

#### Scenario: War telemetry持续刷新updatedAt
- **WHEN** done/failed owner已超过200 tick且WarControl仍每tick刷新updatedAt
- **THEN** MemoryCleanup必须依据terminal anchor回收它并再次幂等确认资产释放，不得永久保留record

#### Scenario: Legacy terminal没有completedAt
- **WHEN** legacy done/failed记录只有statusSince或createdAt
- **THEN** GC必须使用可证明的最早稳定terminal anchor完成有界回收，不得因缺字段跳过或基于当前tick伪造新年龄

### Requirement: War生命周期修复不扩大统一执行边界
本 capability MUST 保持main phase顺序、War console入口、configName形式、Spawn queue wire、role topology/数量/身体/priority、路线与战斗目标选择不变。TaskSystem War adapter MUST 继续只读来源；当四项历史歧义已由War领域闭合后，它 MUST 不再无条件报告对应ambiguity issue，但仍须对真实malformed来源fail-closed。

#### Scenario: Projection读取已闭合terminal记录
- **WHEN** War terminal record由新领域事务产生
- **THEN** adapter必须按来源status与`assetsReleasedAt`投影terminal且不再报告raw-delete、standard-pairing、one-shot-loss或terminal-config-retention固定历史issue，不得读取或修改config/queue/Boost来二次执行清理

#### Scenario: Malformed generation仍fail-closed
- **WHEN** War记录的scope、status或generation component identity无效
- **THEN** adapter必须继续输出unknown或system invalid issue，领域生命周期修复不得把无效来源洗成健康状态

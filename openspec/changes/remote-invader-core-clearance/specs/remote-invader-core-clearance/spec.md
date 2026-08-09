## ADDED Requirements

### Requirement: 清理范围必须限定为有效外矿任务
系统 SHALL 仅为已存在、来源房仍满足外矿条件、未 abandoned 且未被人工战争暂停的外矿任务目标房管理 Invader Core 清理。

#### Scenario: 有效外矿发现可清理 Core
- **WHEN** 有效外矿目标房可见且存在敌对 level 0 `STRUCTURE_INVADER_CORE`
- **THEN** 系统将该外矿任务进入 `defending` 并记录 Core 专用防御原因

#### Scenario: 非外矿或已取消任务不生成清理单位
- **WHEN** Core 所在房间没有有效外矿任务，或任务已 abandoned、人工暂停、来源房失效
- **THEN** 系统不得为该房间创建 Core 清理 config 或 spawn queue 项

### Requirement: 清理出生必须最小且足够
系统 SHALL 复用单个现有 `remoteDefender` config 清理可支持的 level 0 Core，并 SHALL 在无法保证安全完成时禁止重复或无效出生。

#### Scenario: 可攻击 Core 只生成一个 defender config
- **WHEN** level 0 Core 可见、无活动无敌效果、来源房不处于 defense mode 且能量容量达到清理门槛
- **THEN** 系统仅 upsert 一个确定名称的 `remoteDefender` config 并由现有队列机制保证单实例出生

#### Scenario: Core 无敌时等待
- **WHEN** 可见 level 0 Core 仍有活动中的 `EFFECT_INVULNERABILITY`
- **THEN** 系统维持侦察与未完成状态，但不得保留 defender 出生资格

#### Scenario: 危险 Stronghold 不自动派兵
- **WHEN** 可见 Core 等级高于 0 或来源房能量容量不足以保证单兵完成清理
- **THEN** 系统暂停该外矿并清理 defender 的 config 与队列项

### Requirement: 无视野不得误判完成
系统 MUST 只依据可见房间中的当前结构状态判断 Core 是否消失。

#### Scenario: Core 清理期间失去视野
- **WHEN** Core 清理任务处于 `defending` 但目标房不可见
- **THEN** 系统保持任务未完成、维持 scout config，且不得仅因查不到对象而恢复外矿

#### Scenario: 重新获得视野后继续清理
- **WHEN** scout 恢复目标房视野且 Core 仍存在并可攻击
- **THEN** 系统恢复同一个 defender config，而不是创建新的清理任务身份

### Requirement: 清理单位不得攻击玩家结构
Core 清理模式下的 `remoteDefender` SHALL 仅攻击合法 hostile creep 与 `STRUCTURE_INVADER_CORE`，不得把其他玩家或遗留结构作为结构目标。

#### Scenario: Core 与玩家结构同时存在
- **WHEN** Core 清理单位所在房间同时包含 Invader Core 和玩家 spawn、tower、rampart 或其他结构
- **THEN** 单位仅选择 Invader Core 作为结构攻击目标并使用单体远程攻击

#### Scenario: Core 已消失但玩家结构仍在
- **WHEN** 房间可见、Invader Core 已不存在但玩家结构仍存在
- **THEN** Core 清理单位不得攻击这些结构，并进入任务恢复或安全退役流程

### Requirement: 完成与取消必须幂等清理
系统 SHALL 在 Core 可见且消失、任务取消、目标房失效、来源房进入 defense mode 或外矿不再有效时清理 defender config 与所有对应 spawn queue 项，现存清理单位 SHALL 安全返回来源房并退役。

#### Scenario: 可见 Core 已消失
- **WHEN** Core 防御任务目标房可见且 Core 已不存在，也没有其他合法主动防御原因
- **THEN** 系统立即恢复外矿任务、移除 defender/scout 出生资格，并使现存 defender 走既有退役路径

#### Scenario: 其他合法威胁仍存在
- **WHEN** Core 已消失但可见房间仍存在 NPC Invader creep 或已确认的玩家攻击
- **THEN** 系统切换到对应既有防御原因而不是错误恢复外矿

#### Scenario: 重复执行清理
- **WHEN** 生命周期连续多 tick 对同一已结束或已取消任务执行清理
- **THEN** config 与队列保持无重复、无残留且不会抛出错误

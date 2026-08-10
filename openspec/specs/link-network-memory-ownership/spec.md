# LinkNetwork Memory Ownership Specification

## Purpose

规定 `Memory.runtime.linkNetwork` 的唯一路径结构 owner、无副作用读取、精确写入、失房裁剪，以及 LinkControl/MemoryCleanup 的兼容行为。

## Requirements

### Requirement: LinkNetwork runtime cache 具有唯一路径结构 owner
系统 MUST 让 LinkNetwork Memory gateway 成为生产代码 lookup、room-entry replace 和 delete `Memory.runtime.linkNetwork` 的唯一边界。其他生产模块 MUST 通过该 gateway 或 LinkControl 的领域 API 使用缓存，不得直接解释或修改该 Memory 路径结构。gateway 返回的 view MUST 在 TypeScript 中为 deep-readonly；调用方把 snapshot 交给 write 后 MUST 将其视为 immutable。

#### Scenario: 生产模块访问 LinkNetwork cache
- **WHEN** LinkControl 需要读取或更新某房间的分类缓存，或 MemoryCleanup 需要裁剪失房缓存
- **THEN** 它们通过 LinkNetwork Memory gateway 完成路径结构操作，生产代码中不存在第二个静态 slot owner

### Requirement: 无副作用读取与精确写入
gateway 的读取操作 MUST 在分支不存在时返回 `undefined` 且不得创建 `Memory.runtime` 或 `linkNetwork`。写入操作 MUST 按需创建根与容器，并在原路径保存调用方提供的 `{ updatedAt, senderIds, receiverIds }` snapshot，不得排序、clone 或规范化字段。

#### Scenario: 空 Memory 上执行读取
- **WHEN** `Memory.runtime` 或 `Memory.runtime.linkNetwork` 不存在且调用方读取任意房间
- **THEN** gateway 返回 `undefined`，调用前后的 Memory 结构完全相同

#### Scenario: 写入房间分类 snapshot
- **WHEN** 调用方写入包含 tick、sender ID 顺序与 receiver ID 顺序的 snapshot
- **THEN** gateway 在 `Memory.runtime.linkNetwork[roomName]` 保存同一个 snapshot 引用和原始数组顺序，不注册新的 RuntimeServices singleton，调用方随后以 immutable 方式使用该引用

### Requirement: 失房缓存裁剪保持现有 wire 语义
gateway MUST 只删除不在调用方己方房间集合中的 LinkNetwork 房间项，并返回准确删除数量。没有缓存时 MUST 返回零；删除最后一项后 MUST 保留空的 `linkNetwork` 容器。

#### Scenario: 混合己方与失房缓存
- **WHEN** cache 同时包含己方房间、失去所有权房间和不可见房间，且调用方只把己方房间列入保留集合
- **THEN** gateway 保留己方项、删除其余项、保持保留项内容不变，并返回实际删除项数量

#### Scenario: 删除最后一个失房项
- **WHEN** cache 只含一个非己方房间且执行裁剪
- **THEN** 该房间项被删除，`Memory.runtime.linkNetwork` 仍存在且等于空对象

### Requirement: Link 分类缓存刷新行为保持兼容
LinkControl MUST 继续以 11 tick 为分类缓存周期：未达到周期时复用持久化 snapshot，达到或超过周期时重新分类并通过 gateway 原子替换该房间 snapshot。缓存不存在时 MUST 立即分类；公开 receiver 判断在无缓存时 MUST 保留现有位置 fallback。

#### Scenario: 分类缓存尚未过期
- **WHEN** 当前 tick 与 `updatedAt` 的差小于 11
- **THEN** LinkControl 复用现有 sender/receiver ID，不重新扫描并不改写 snapshot

#### Scenario: 分类缓存恰好到期
- **WHEN** 当前 tick 与 `updatedAt` 的差等于 11
- **THEN** LinkControl 重新分类该房间并以当前 tick 的新 snapshot 替换旧值

#### Scenario: receiver 查询没有缓存
- **WHEN** 角色对未缓存房间的 Link 调用 receiver 或 storage-receiver 判断
- **THEN** LinkControl 仅根据现有位置规则返回结果，且该查询不创建 LinkNetwork Memory

### Requirement: 清理和执行 phase 语义保持兼容
系统 MUST 保持 MemoryCleanup 每 17 tick 在 LinkControl 之前运行，并使用当 tick 的己方房间集合裁剪缓存。Link 分类、Source container 清理、receiver 选择、transfer intent 和成功 CPU action 记录 MUST NOT 因持久化边界抽取而改变。

#### Scenario: 非清理 tick
- **WHEN** 当前 tick 不是 17 的倍数
- **THEN** MemoryCleanup 不裁剪 LinkNetwork cache，随后 LinkControl 按原逻辑执行

#### Scenario: 清理 tick
- **WHEN** 当前 tick 是 17 的倍数且 cache 含失去所有权房间
- **THEN** MemoryCleanup 在 LinkControl 之前通过 gateway 删除失房项，并保留己方房间供当 tick LinkControl 使用

#### Scenario: sender 可以向 receiver 传能
- **WHEN** 持久化分类指向仍存在、冷却完成、持有 Energy 的 sender 与未满 receiver
- **THEN** LinkControl 仍选择相同 receiver、发送相同 transfer intent，并仅在成功时记录固定 CPU action

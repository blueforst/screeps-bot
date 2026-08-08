## ADDED Requirements

### Requirement: Invocation 内静态认证与动态双读必须分层
系统 MUST 在一次 V3 outer automation invocation 内至多执行一次 normalized config mismatch、operator authorization fingerprint 与 current pricing-ratchet canonical 认证，并把结果绑定到 exact frozen runtime session。系统仍 MUST 对 trusted floors、room observations、production protection、orders、terminal、quota、arbiter 与 outgoing window 执行原有 fresh read 和双读一致性门禁；静态认证结果不得持久化或成为新的写授权。

#### Scenario: 稳定 outer session 复用静态认证
- **WHEN** 同一次 invocation 的 state、permit chain、current ratchet 与 normalized config 在两次 planning read 间保持 exact 不变
- **THEN** config/operator/current-ratchet canonical 认证只执行一次，而两次 live room、protection、book、terminal 与 write-context read 均独立发生

#### Scenario: Session source 被替换
- **WHEN** callback 或 outer root replacement 在 planning 完成前替换 state scope、permit chain、ledger 或 current ratchet
- **THEN** exact runtime mismatch 必须使本轮 fail-closed，且不得产生 pending、canonical commit、claim 或 deal

#### Scenario: 第二读动态保护变化
- **WHEN** 第二读仅改变任一 lane 的 protection contribution 或其他动态事实，而静态配置与 permit 保持不变
- **THEN** 系统必须拒绝两读 evidence，清空最终 selection，并保持零 pending、零 commit、零 claim、零 deal

### Requirement: 已认证稳定 Scope 快路不得跳过 live room 事实
系统 SHALL 仅在 opaque runtime session 绑定的 exact frozen scope 已更新到当前 tick，且本次独立采集的全部 admitted room observation 与 frozen seller-room basis 精确一致时复用该 scope。任一 owner、terminal、Hub 分类、房间增删、observation shape 或唯一性变化 MUST 回到完整 reconcile 或 fail-closed；第一读 observation MUST NOT 供第二读复用。

#### Scenario: 当前 tick 房间 basis 完全稳定
- **WHEN** 当前读独立采集的 room name、controller owner、terminal identity、ownership 与 room class 全部匹配已认证 frozen scope
- **THEN** 系统可跳过重复 checkpoint/tombstone/lane 静态重验并复用 exact scope，后续动态市场事实仍按本读重新收集

#### Scenario: 同 tick Terminal 或 Hub 分类变化
- **WHEN** 任一可见房间在 outer reconcile 后改变 terminal identity、controller owner 或 Hub 分类
- **THEN** 稳定快路必须失配，系统执行完整 reconcile 或以 scope blocker 结束，且不得提交 planning 正向进度

#### Scenario: 第二读新增或移除房间
- **WHEN** 两次 planning read 之间 admitted room 集合发生增删
- **THEN** 第二读不得复用第一读 scope，最终计划必须 incomplete 且零市场写

### Requirement: Continuous Quota 状态必须批量验证与投影
系统 SHALL 为 bounded、resource 唯一的 quota request 集合对同一 Continuous ledger 执行一次完整验证和一次 rolling receipt 聚合，再生成逐资源 snapshot。批量结果 MUST 与相同输入下的单资源 quota 字段逐项一致；invalid ledger、非法 limit、重复/空 resource 或越界 batch MUST 整批返回 unavailable。

#### Scenario: 三资源 Runtime 状态投影
- **WHEN** runtime status 为冻结 execution table 的三个资源请求同一 tick quota
- **THEN** 系统只完整验证一次 ledger，并返回与逐资源单读相同的 confirmed、pending、remaining、cooldown 与 retry 字段

#### Scenario: Pending 仅归属一个资源
- **WHEN** ledger 存在未匹配 pending，且其 resource 只命中 batch 中一个 request
- **THEN** global unmatched planned 必须出现在全部 snapshot，而 resource unmatched planned 只出现在匹配资源

#### Scenario: 任一 Batch 输入非法
- **WHEN** quota batch 包含重复 resource、空 resource、负 limit、无效 tick 或超过固定上界
- **THEN** 整批必须 fail-closed 为 unavailable，不得返回部分 quota 或改变 ledger

### Requirement: 市场 CPU 优化不得放宽写安全门禁
系统 MUST 保持 market-base outer 25 CPU ceiling、CPU raw high-water、canonical malformed-input、双读、WAL 与 `commit → claim → deal` 门禁不变。性能验收 MUST 同时证明本地 canonical 工作减少和 shard1 Shadow 多 tick CPU 改善；单个低 CPU tick不得自动满足 Canary/Continuous 启用条件。

#### Scenario: 优化后 CPU Cut
- **WHEN** 任一阶段的真实 CPU 高水位仍越过 25、读数回拨或读数无效
- **THEN** 系统必须按原 cut phase fail-closed，并保持原 reset-only/pending 语义以及零未授权 claim/deal

#### Scenario: Shadow 线上验收
- **WHEN** 新 bundle 部署到 shard1 并采集性能样本
- **THEN** 全部 lane/grant 必须继续为 `shadow+suspended`，managed order、pending mutation、terminal claim 与 deal 均为零，并至少用多个完整 planning tick及完整 120 样本窗口比较前后 CPU

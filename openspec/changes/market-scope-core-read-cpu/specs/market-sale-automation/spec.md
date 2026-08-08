## ADDED Requirements

### Requirement: V3 scope read 不得重复物化仅供判错的 canonical config
系统 SHALL 对当前 V3 config 执行与公开 raw validator 相同的资源集合、字段类型和阈值精确检查，但 scope read 为取得 mismatch reasons 时 MUST NOT 在成功路径再次物化未被消费的 raw-config canonical fingerprint。只有 resolver 自己构造、完成全部精确校验、递归冻结并登记到模块私有 provenance 的 canonical config，系统才可复用模块级纯函数 operator-authorization fingerprint；任何 clone、自建对象、accessor、未登记 identity 或值偏差 MUST 保留非 canonical 完整计算或 fail-closed，且不得依赖 Memory 自证字段或可变对象 identity。

#### Scenario: canonical config 命中无重复 hash 路径
- **WHEN** resolver 从 raw config 构造的 detached V3 config，其 revision、资源顺序、三组阈值和全部安全标量均精确匹配代码冻结合同
- **THEN** resolver 必须在登记私有 provenance 前完成全部精确检查并递归冻结该对象；scope read 不得再重算 raw-config canonical fingerprint 与 canonical operator fingerprint

#### Scenario: config 偏差不能继承 canonical operator 证明
- **WHEN** config 是 clone、自建对象、含 accessor/可覆写集合行为、未登记 identity，或其资源顺序、资源集合、revision、任一阈值、安全标量或 nested source 在验证前后发生偏差
- **THEN** 模块级 fingerprint 快路不得命中，fallback 字符串不得与 canonical fingerprint 碰撞，规划 MUST fail-closed 或执行完整非快路校验，并保持零 pending、commit、claim 与 deal

### Requirement: Scope-core CPU 优化保持原安全预算与可归因验收
系统 MUST 保留从 outer 起点计算的 25 CPU ceiling、不可回拨 raw high-water、双读、每读 pricing-ratchet successor builder、post-plan canonical 验证、最终 exact-root CAS 与原有 primary CPU trace。系统 MUST NOT 以 ratchet source identity、相同 projection、对象冻结或 snapshot 为由省略任一 ratchet build/hash；same-projection identity replacement 不构成本 change 的授权。性能验收 SHALL 使用 `cpuAfterScopeCore - cpuAfterOuterSession`、确定性 config/operator hash 调用次数、相同 fixture profile 和多个线上完整 planning tick；完整滚动窗口只能作为相关性证据，必须同时报告房间、creep 与世界负载漂移。

#### Scenario: 本地确定性验收
- **WHEN** canonical config 的 production-size fixture 连续运行
- **THEN** config mismatch 与 operator canonical hash 的调用次数必须符合有界预期，ratchet builder/hash 次数不得因本 change 减少，且所有既有 TOCTOU、CPU rollback 和零写测试继续通过

#### Scenario: Shadow 线上验收
- **WHEN** 优化版本在 shard1 以全部 lane Shadow/suspended 部署并积累多个完整 planning tick 与完整 CPU 窗口
- **THEN** 报告 primary phase delta 与聚合 CPU 的绝对值/变化，且 managed order、pending mutation/create、terminal claim、staging、reservation、exposure、rolling fee 和 safety violation 必须持续为零；不得据此启用 Canary/Continuous

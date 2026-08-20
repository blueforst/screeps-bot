# Shadow v2 CPU 结构削减与 r5 重开窗口

- 日期：2026-08-20
- 部署：`2026.8.20-4+9e39bb0@2026-08-20T08:19:00.659Z`（commit `6635241` perf(logistics): cut shadow v2 epoch CPU via unchanged-wire fast path）
- 前置：r3/r4 窗口结论（`shadow-v2-regate-r3.md`、`shadow-v2-regate-r4` 数据）——配对维度已由 decisionOrder 仲裁修复（3175a2a）全绿，唯一剩余 gate 阻断为 CPU 维度（r4 gateUsed p95 7.867 vs cap 3.988）。

## 本轮授权

用户常设授权（见 `shadow-arbitration-order-fix.md`）：自行重开 Shadow 无需逐次授权；仅允许 shadow 或安全回退 disabled，严禁 canary/enabled；execution authority 始终为 legacy。

## 热点定位（本地 8 房间 benchmark + live cpuprofile 复核）

- producer CPU 的 ~95% 集中在 store 写入管线 `replaceLatestLogisticsDemandsForProducer`（每 epoch 2 次全量 decode、2 次全量语义校验、2 次大 stringify、1 次全图 freeze）。
- 151 次/epoch 的小 JSON.stringify（key/签名编码）经实测仅 0.116ms——**非热点**，推翻了首先优化 stringify 的直觉。
- consumer（1.505 live）分解：buildShadow ~72%（matcher 0.354 为单段最大）、finalize ~21%。

## 落地改动（6635241）

1. **跨 epoch wire 等值缓存**：`readLogisticsControlStoreExact` strict_compact 分支先与最近一次 attach 的完整 serialized token 全串比对，等值即复用冻结 store，跳过 decode+逐记录校验。防篡改强度与 same-tick artifact 的字节级比对一致（原位篡改必然改变 serialize 结果而回落完整 strict）。
2. **prepare 校验 trusted 化**：attach 侧 `hasValidBoundedStoreEntriesSemantic` 跳过逐条 isXxxRecord 复核（输入全部来自已校验路径），跨记录不变量仍全量复核；**repair 分支补非 trusted 拦截**（subagent 审查发现：损坏记录可借 trusted 通道提交并被等值缓存长期遮蔽——已修复）。
3. **语义签名改逐字段比较**：删除 demand/roomFact 的 JSON.stringify 签名串，等价字段集逐字段比较；`fixedSourceRoomNames` 空数组与省略等价归一（审查修复）。
4. **epoch fingerprint `mixNumber` 整数位混合**：消除逐数字符串化分配。哈希输出值改变，但 fingerprint 仅做同 epoch 一致性标识（无历史对照），测试无字面断言。

### 评估后放弃的方案

- same-tick artifact 引用短路：会削弱既有安全注释明确要求的字节级防篡改（logisticsControl.ts:1481 注释）。
- prepare 跳过 decode 往返：破坏 artifact store 的 canonical 字段序（decode 侧字段序），exact-byte 比较测试立即暴露；monitor replay 依赖 canonical 形态。

## 验证

- `npx tsc --noEmit` ✓（两次，含修复后）；Jest **167 suites / 500 cases 全绿**（预算不变，仅扩展既有 case：readSource 期望更新 + 新增清缓存走 strict_compact 的回归覆盖）。
- `npm run build` ✓；`npx openspec validate decentralized-logistics-contracts --strict` ✓；5,043-byte exact-byte fixture 不变 ✓。
- 本地 benchmark（8 房间、4 demands、JIT 预热后 100 epoch）：producer 每 epoch **3.5ms → 1.24ms（-65%）**，其中 store 写入管线 4.59 → 1.04ms、buildRoomFacts 0.72 → 0.27ms。
- subagent 影响范围审查（A–E）：A-2 repair 路径与 B fixedSourceRoomNames 两个 CONCERN 已按最小修复落地并复验；其余 PASS。

## 基线5（disabled，部署 2026.8.20-4 后冻结）

- 窗口 tick 73131990–73132120，14 样本，cadence 全对齐。
- **p95 = 2.8126308 → cap110 = 3.0938939**（monitor-data/shadow-v2-baseline5.jsonl）。
- 对比基线4（p95 3.625/cap 3.988）：disabled 路径同样受益于等值缓存（RC finalize 的 store 读），cap 收紧约 22%。

## r5 窗口结果（正式 10 warmup + 100 measured）

- 窗口 tick 73132150–73133240，windowComplete=true（125 个 distinct epoch，16 个无效为轮询重复/未对齐被有效替换）。
- **配对维度全绿**：181 个有效 epoch 全部 `{equal: 861, expected_policy_difference: 499}`、causal `{matched: 861, source_protection: 499}`、unresolved=0、effectiveAuthority 全部 legacy、Memory 全部 withinLimit、安全九项零。decisionOrder 仲裁修复（3175a2a）在正式窗口稳定复现。
- **CPU 维度失败**：measured gateUsed p95 = **7.406058** vs cap 3.0938939（**98/100 超限**）；median 5.652、min 4.438、max 18.332。
- 对照 r4（p95 7.867 vs cap 3.988）：绝对 p95 降 5.8%，但本轮优化同时降低了 disabled 基线（cap 收紧 22%），相对差距未收敛。
- 复盘：本地 benchmark producer -65% 未同比例映射到 live gateUsed——live 尖峰（max 18.3）与中位压力（5.65）来自共享 tick 的 GC/其他模块波动（含 market 复杂体 ~42 CPU/tick 的干扰），shadow 增量本身（producer 2.682→2.316、consumer 1.505→1.345）只占其中一部分。
- 已按规程回退 disabled（op `6a86cec1fd36790013671341`，读回 cfg disabled / authority legacy）。

### 结论与下一步提案（需用户决策）

配对维度已具备连续通过能力；CPU 维度在现口径（gateUsed=RC 段全部 CPU+producer、按 epoch 计量、cap=disabled p95×1.10）下，即便 shadow 增量降到零，tick 级波动（GC/邻近模块）也使 p95 不稳定收敛。可选口径变更提案：
1. gateUsed 只计 shadow 增量（producer+consumer 计量值，不含 legacy RC 本体）；
2. 按 intents 数归一化（CPU/intent/epoch）；
3. 维持现口径，接受 CPU 维度长期失败记录。
口径变更需用户批准后另开窗口验证。

## 同轮交付：W1N57 spawn 冻结根因修复（commit d2e7020/aa0690b）

现场证据：W1N57 Spawn6 孵化冻结 2.4 天（carrier-73057335 卡 remainingTime=0，creep.spawning=true 站 spawn 格）。三处叠加根因：
1. 出生位 fallback 用 spawn 自身格（spawn 格不能落地 creep），让位逻辑盯错格子；
2. 让位直接 move 被 spawn.work 之后的 creep 自身移动逻辑覆盖；
3. **PowerCreep 占据出生格（28,33 operator）——LOOK_CREEPS 看不见 PowerCreep**，且其任务逻辑会把它移回。

一锤定音验证：手动移开 PowerCreep 后下一 tick carrier-73057335 立即出生。修复：出生位集合改 8 邻格；让位指令经 `CreepMemory/PowerCreepMemory._spawnYield` 传递并在 creep work / powerCreepControl 入口优先消费；出生位与让位目标格检测均覆盖 PowerCreep。部署 2026.8.20-5/6 验证：carrier 存活工作、三 spawn 队列可用。

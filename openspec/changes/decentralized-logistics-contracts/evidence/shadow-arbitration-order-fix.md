# Shadow v2 稀缺源仲裁序修复（2026-08-20，bundle 2026.8.20-3）

## 授权背景

用户于 2026-08-20 授予**常设授权**：此后重开 Shadow 不再需要逐次申请（r3 记录中"重开 Shadow 仍需用户新的明确授权"条款自此被取代）。`canary/enabled` 仍未授权，execution authority 保持 legacy。另按用户全局流程制度（`~/.zcode/AGENTS.md`），每个功能完成后须 subagent 审查影响范围。

## 根因（live 实证）

r3 窗口与诊断 probe（激活 op `6a86a0d7516631001378f391`）抓到同一资源（LHO2）上两个竞争需求的完整分歧对：

- **legacy_unpaired 样本**（E1N57 需求）：legacy `no_donor` 未行动，Shadow 从 E6N59 发出 4 单位（`shadow_only_route`）；
- **legacy_only_route 样本**（E5N59 需求）：legacy 从 E6N59 发出同一批 4 单位，Shadow `source_protection` 未行动。

两侧 matcher 的保护口径一致（都按 source_protection 拒绝），分歧不在策略而在**仲裁顺序**：

1. legacy 在 `synthesisControl` 规划循环内按房间迭代顺序**顺序消耗** donor 库存——先规划的房间拿走稀缺源，后规划的只能 `no_donor`；
2. 输入管线（`resourceControl.ts`）已按 observation 的 `decisionOrder`（producer batch 内追加序 = legacy 实际规划序）排序输入，但 matcher 的 `comparePreparedDemands` 随后用 `firstObservedAt`（需求年龄）+ `comparisonKey` 字典序**重排**，破坏了该顺序；
3. live compact store 解码实证（epoch 73130300）：`decisionOrder` 序为 E6N59(0,1) → **E5N59(2,3)** → E7N58(4,5) → **E1N57(6,7)**，即 legacy 先规划 E5N59；而 E1N57 需求更老（firstObservedAt 更小），Shadow 旧排序把 E1N57 排前——两侧把同一份 4 单位库存分给不同接收方，各自产生一个假差异。
4. intentId 尾号（671/673 等）是需求 generation 生命周期计数，不是规划序——`decisionOrder` 才是。

## 修复（Shadow 侧，legacy 与 gate 口径零改动）

1. `SynthesisShadowDemandObservation` 新增 `decisionOrder` 字段（producer batch 内 legacy 规划序）；
2. `buildSynthesisShadowDemand` 从 store observation 透传该字段（缺失时 `Number.MAX_SAFE_INTEGER` 排最后，与输入收集侧兜底一致）；
3. `comparePreparedDemands` 仲裁改为 `priorityClass → deadlineAt → decisionOrder → comparisonKey`，`firstObservedAt` 退出仲裁（legacy 无此概念）。

效果：同优先级稀缺源按 legacy 实际规划序分配，`legacy_unpaired + no_donor`（shadow 拿走 legacy 已分配的源）与 `legacy_only_route + source_protection`（legacy 拿走 shadow 已分配的源）两类假差异同时消除；两侧退化为 `expected_policy_difference`（合法类别）或 `equal`。

## 验证

- 既有 case 扩展（`resourceControl.capacityRegression.test.ts` "admits exactly 50000..."）：新增稀缺源仲裁场景——单源 60 单位、两个同优先级需求，`decisionOrder` 让 D-beta 先规划、`firstObservedAt` 故意反向让 D-alpha 更老，断言 Shadow 服务 D-beta 且 D-alpha `source_protection`（旧行为会服务 D-alpha，测试钉死新行为）；
- 双 tsc（build + test config）、Jest 167 suites / 500 cases（预算精确保持，无新增文件/case 数）、`npm run build` + `node --check dist/main.js` 全部通过；
- compact wire codec 未改动，5,043-byte exact fixture 保持不变（`resourceTransferTasks.test.ts` 通过即含该断言）。

## 部署与验证窗口

- bundle `2026.8.20-3`，部署后按常设授权自主重开 Shadow 采集验证窗口（目标：`legacy_unpaired/no_donor` 类别消失、`expected_policy_difference/equal` 结构健康、CPU 三分量水位复测），完成后回退 disabled。结果见本文件追加段。

## 残留风险

- 跨 producer（未来 hub 需求接入）的 `decisionOrder` 各自独立计数，同优先级跨 producer 仲裁仍退化为 comparisonKey 字典序——确定性但与 legacy 无对应关系；hub 接入时需定义跨 producer 仲裁序。
- CPU 维度未在本轮处理：gate 结构性超限（r3 记录的三分量叠加）依旧存在，producer capture 共享、consumer 跨 epoch 复用与门槛经济学重估仍待后续工单。

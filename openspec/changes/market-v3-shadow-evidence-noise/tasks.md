## 1. 语义收紧

- [x] 1.1 修改 `applyMarketBaseResourceShadowObservations`：incomplete 分支与同 tick 冲突分支改为 no-op（保留 lane 原样），tick rollback 清零保持
- [x] 1.2 复核 `emptyResult` CPU 超限观察过滤与新语义的兼容（超限轮观察进入 apply 后为 no-op）
  - 证据：`emptyResult`、`boundedCpuFallbackIncompleteObservations`、`applyDeterminedLocalShadowResets` 的观察最终都汇入同一 apply 入口，no-op 化后无需改动构造侧；`marketBaseResourceCpuFallbackRequiresCanonicalCommit` 的 incomplete>0 分支保持要求 canonical commit（保守无害）。

## 2. 测试

- [x] 2.1 调整既有"incomplete 清零"断言为"incomplete 保持"，覆盖 cycles/lastCompleteTick/digest 三字段
- [x] 2.2 断言 conflicting_same_tick 为 no-op、tick rollback 仍清零、wait 类结果仍照常累计、qualified 门槛（100）不变
  - 证据：新增用例 "incomplete 与同 tick 冲突观察保持周期证据，tick 回滚仍清零"；既有用例改名为 "Shadow batch 内 CPU cut 携带 incomplete fallback 但不再销毁已积累周期"（99-cycle 保持 99）。

## 3. 验证与审查

- [x] 3.1 运行 market 定向测试、全量 `npm run test`、`npx tsc --noEmit`、`npm run build`、`npx openspec validate market-v3-shadow-evidence-noise --strict`
  - 证据：定向 3/3、全量 167 suites / 510 tests 全绿；tsc 零输出；build 成功；openspec strict valid。预算门禁 exit 0（manifest 漂移为既有状态：powerBankHarvest/spawnPlanner 等已超预算，本变更 +1 与之同类）。
- [x] 3.2 subagent 影响范围审查（晋级安全、观测通道、v2 兼容、内存/CPU）
  - 结论：A 晋级安全 / B 消费方清点 / C CPU fallback / D 观测通道 / E v2 兼容与写面 / F 内存 CPU 全部 PASS，零 P0/P1；6 个 P2（三重冲突复活、appliedResetCount 语义注释、3 处陈旧注释、测试缺口）已全部修复并复测通过（含 [A,B,A] 冲突 no-op、wait 累计、100 门槛驱动 qualified、qualified+incomplete 冻结、rollback 清零断言）。
- [x] 3.3 部署后只读验收：live cycles 不再整体回退、shadowBlockers 诊断仍可见 incomplete 频次、qualified 后续推进记录回 evidence
  - 证据：版本 `2026.8.21-2` 部署（`c3026ad`）后 tick 73153412 读数 cycles `{"39":8,"40":40,"41":8}`，跨部署无清零（部署前 36–38）；snapshot 正常更新、shadowBlockers=null（当轮无 incomplete）、bucket=10000。qualified/canary/成交的后续推进由一次性定时验收任务回写 `decentralized-logistics-contracts/evidence/market-automation-unlock.md`（预计部署后 ~2 小时）。

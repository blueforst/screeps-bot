## 1. 失败测试与基线

- [x] 1.1 为 automatic/manual `receiver_capacity` coverage grace、source-depleted grace、reconciliation 前 merge 与终态审计编写失败测试
- [x] 1.2 为 amount index、Synthesis incoming/pending coverage 和 Hub import/route 去重共用同一判定编写失败测试
- [x] 1.3 为链步骤多于房间、重复 assignment 防御校验和 allocation/route 不提交编写失败测试
- [x] 1.4 为 Hub plannerOwnership 原子写入、旧 owner 清理、ownerless/foreign 保留和 busy 延迟回收编写失败测试
- [x] 1.5 锁定 canonical main phase、Terminal/Market action 调用数和 legacy task executionAuthority 不变

## 2. Demand coverage 生命周期

- [x] 2.1 增加 `receiverCapacityDemandCoverageGraceTicks` owner-local 配置 adapter 类型、默认值与归一化边界；保持 canonical Memory 声明 fingerprint 不变
- [x] 2.2 实现唯一 `countsResourceTransferTaskTowardDemand` 判定，并接入 incoming amount index、public helper 与 Synthesis demand-covering pending 计数
- [x] 2.3 让 automatic merge 跳过 coverage-expired task，并在 reconciliation 中以机器可读 reason 取消过期 receiver-capacity task
- [x] 2.4 在 ResourceControl 单轮 task contribution/summary 中累计 raw、demand-covering 与 coverage-expired 统计，避免新增逐房全表扫描
- [x] 2.5 修复 distributed route progress/stale 语义：增量合并保留已交付量与 `lastProgressAt`，零增量健康 commitment 不取消，direct consumer 以已知产品/已知清空/未知三态处理，旧 Hub route/surplus 与 distributed-storage non-T3 surplus 回收，coverage-expired 原因留给 canonical reconciliation

## 3. Distributed synthesis 单一 assignment 与配置 ownership

- [x] 3.1 将 `usedRooms` 改为 assignment 硬约束，增加稳定重复 validator，并让异常计划在 config/route/protection 写入前 fail closed
- [x] 3.2 保留真实 blocked/未覆盖目标，不因存在部分 assignment 清空全部 `missingResources`
- [x] 3.3 为 Hub-managed synthesis config 写入 `plannerOwnership`，传递 planning attempt revision 并只 reconcile 同 owner 旧配置
- [x] 3.4 投影有界 assignment violation 与 config reconcile 摘要，兼容旧 Memory/global reset

## 4. Monitor、验证与审查

- [x] 4.1 扩展 Monitor/fixtures，展示 coverage-expired、blockedTargets、invariant violation 与 config reconcile，旧快照字段缺失时不伪造成功
- [x] 4.2 运行 resourceTransferTasks、Synthesis、Hub、ResourceControl、Market protection 与 main 聚焦回归
- [x] 4.3 运行 `npx tsc --noEmit`、`npm run test`、`npm run build`、`git diff --check` 与 `npx openspec validate production-logistics-liveness --strict`
- [x] 4.4 完成至少两路独立代码审查并关闭 P0/P1/P2；记录未部署的 live 验收与明确回滚 commit

## 5. Live 门槛

- [x] 5.1 部署前记录 blocked incoming、assignment/config ownership、Hub protection、ResourceControl/Hub CPU 和回滚 tag；未经明确 deploy gate 不执行上传
- [x] 5.2 部署后观察至少两个 Hub planInterval，确认 coverage 超时无重复 active demand、跨 revision 同 route 的 delivered/`lastProgressAt` 不倒退且无误取消重建、assignment room 唯一、protection consistent、无额外 Terminal/Market side effect且 CPU 无显著回退；若窗口内没有同 ID route witness，明确记录未自然触发而不伪造通过

## 1. V3 静态认证与稳定 Scope

- [x] 1.1 记录 shard1 与本地 profile 基线，锁定 25 CPU、Shadow 与零写验收边界
- [x] 1.2 实现 invocation-local 静态认证上下文，一次认证 config、operator、permit 与 current ratchet并建立逐资源索引
- [x] 1.3 实现 exact frozen scope + fresh room observations 的 authenticated stable-scope 快路，失配时回完整 reconcile/fail-closed
- [x] 1.4 将两次 `liveScopeForRead` 接入静态认证上下文，保留 trusted floors、protection、book、terminal、quota、arbiter 与 outgoing window 的独立 fresh read

## 2. Continuous Quota 批量只读投影

- [x] 2.1 实现 bounded unique-resource quota batch helper，一次 ledger 验证与 receipt 聚合生成全部 snapshot
- [x] 2.2 让单资源 quota API 委托 batch helper，并将 opportunity admission 与 runtime status 改为批量调用
- [x] 2.3 验证 batch 与单资源 confirmed/pending/remaining/cooldown/retry 语义逐项一致且非法 batch 整体 fail-closed

## 3. 安全与性能回归

- [x] 3.1 增加静态认证一次性、两次动态 read、scope owner/terminal/hub/room 增删失配回归
- [x] 3.2 增加第二读 protection-only 变化与 canonical malformed-input 回归，显式断言零 pending/commit/claim/deal
- [x] 3.3 增加 quota batch 调用次数/边界测试并复跑 cold 512-receipt benchmark 与定向 profile

## 4. 验证、部署与观察

- [x] 4.1 运行定向 Jest、完整 Jest、`npx tsc --noEmit`、`npm run build`、`git diff --check` 与 OpenSpec strict validation
- [x] 4.2 从基于 HEAD 的干净临时 worktree 构建并部署，避免夹带现有 upgrader/hub/colonizer dirty 改动
- [x] 4.3 通过多轮 monitor 核对 shard1 最终 bundle `2026.8.8-3+47cc10a@2026-08-08T08:06:32.418Z`：纯新窗口内在 ticks 72857590、72857870、72858590 形成完整 `batch_zero_candidate` Shadow planning，CPU 分别为 20.5012、20.3504、21.2328，blocker 均为预期的 `market_base_no_writable_lane`；抽样 runtime trace 在 ticks 72857680、72857900、72858130、72858350 仍于 `scope_core_read1` 截止（scope 累计 27.3224–28.9836 CPU），最终 tick 72858640 才完成 inner apply 并在 outer precommit 门禁截止（24.4061 CPU），故不声称所有 planning tick 均完成或 scope 热点已消失。各轮采样的 56/56 lane/grant 均为 Shadow/suspended，managed order、pending create/mutation、terminal claim、staging、reservation、exposure、fee 与 safety violation 均为 0。
- [x] 4.4 等待得到 tick 72857450–72858640 的纯新完整 120 样本窗口（interval 10、history 120）：相对部署前完整窗口，总 CPU 均值 97.4166→98.2284（+0.83%）、EMA 97.8689→92.9536（-5.02%）、max 142.4000→166.7643（+17.11%），bucket avg/min 均为 10,000；market automation 35.9009→37.3936（+4.16%）、preflight 7.8334→7.5479（-3.64%），合计 43.7343→44.9416（+2.76%）；creepWork 27.3979→30.1432（+10.02%），其子项 pathing 13.5003→16.4221（+21.64%）。该窗口证明安全和 bucket 稳定，但在 8 房、2 worker、9 carrier 及世界负载漂移下没有可归因的线上整体 CPU 降幅；保留本地 profile 的定向热点收益结论，不将本次聚合波动宣称为因果改善。Canary/Continuous 继续关闭。

验证记录：两次完整 Jest 均为 115/116 suite、3292/3293 case；唯一未绿是未改动 ledger 的 wall-clock median 在全套负载下约 11.3 ms 超过 10 ms，隔离复跑为 8.80 ms 并通过原门槛，未放宽阈值。其余定向测试、TypeScript、build、diff check 与 strict validation 全部通过。

初始部署记录：从 detached clean worktree 上传 `2026.8.8-1+2fcf643@2026-08-08T06:20:51.240Z` 后只有 9 个样本，当时不足以完成 4.3/4.4；该 CPU 实现随后随完整 bundle `2026.8.8-3+47cc10a` 取得纯新 120 样本，最终结果与剩余 scope 热点见 4.3/4.4。两阶段各轮采样的 56/56 grant 均为 `shadow+suspended`，managed/pending/terminal claim/exposure 等写面均为零。

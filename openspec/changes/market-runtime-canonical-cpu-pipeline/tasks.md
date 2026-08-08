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
- [ ] 4.3 通过 monitor 核对 shard1 deployTag、多个完整 Shadow tick、CPU trace 与零 managed/pending/claim/deal
- [ ] 4.4 等待至少 1200 tick 后比较完整 120 样本窗口并记录长期 CPU 结果；未完成前保持 Canary/Continuous 关闭

验证记录：两次完整 Jest 均为 115/116 suite、3292/3293 case；唯一未绿是未改动 ledger 的 wall-clock median 在全套负载下约 11.3 ms 超过 10 ms，隔离复跑为 8.80 ms 并通过原门槛，未放宽阈值。其余定向测试、TypeScript、build、diff check 与 strict validation 全部通过。

部署记录：已从 detached clean worktree 上传 `2026.8.8-1+2fcf643@2026-08-08T06:20:51.240Z`。部署后 9 个样本尚未形成稳态窗口，最近 trace 仍在 `outer_precommit` 或 `scope_core_read1` 截止，故 4.3/4.4 保持未完成；56/56 grant 均为 `shadow+suspended`，managed/pending/terminal claim/exposure 等写面均为零。

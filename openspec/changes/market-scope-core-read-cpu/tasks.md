## 1. Config canonical 工作去重

- [x] 1.1 抽取 raw V3 config 的共享精确解析器，使公开 validator 保留 canonical fingerprint，而 mismatch-only 路径不生成未消费的 hash
- [x] 1.2 建立 resolver 私有 frozen provenance 的 canonical V3 direct/operator fingerprint 快路，并让所有 clone、自建或非 exact 输入走不可碰撞的 fallback/fail-closed
- [x] 1.3 补齐 canonical golden、递归冻结、clone、accessor/hostile getter、资源重排、阈值/revision/shape 偏差与 mutation 的定向测试

## 2. 验证与性能证据

- [x] 2.1 运行 config/policy、base-resource、market-sale 定向测试以及 TypeScript、build、diff check 和 OpenSpec strict
  - 证据：最终 config-only 版本运行全部 25 个 `market*.test.ts` suites，695/695 通过；`npx tsc --noEmit`、`npm run build`、OpenSpec strict 与 `git diff --check` 全部通过。
- [x] 2.2 用相同 production-size fixture 复跑本地 profile，记录 config/operator hash 调用与 hot automation 前后差异；确认 ratchet builder/hash 次数保持基线，并注明 Node/Screeps 口径限制
  - 证据：8 rooms / 56 lanes / 512 receipts 的正反交错 A/B 各 3 进程、21 样本，hot automation baseline p50/p95/mean 为 2.577/4.517/2.843 ms，current 为 2.126/4.393/2.618 ms，分别变化 -17.5%/-2.8%/-7.9%，21/21 低于 20 ms 门槛；10µs profile 中 ratchet builder 为 0.211→0.212 ms/tick、builder hash 为 0.204→0.204 ms/tick，属于采样噪声。Node/JIT 与宿主负载不等同 Screeps CPU，线上仅作为待验证相关性假设。
- [x] 2.3 审查最终 diff，确认未修改 ratchet builder/终验且未新增 ratchet source capture/projection/`toJSON` 合同，同时确认 trace wire shape、25 CPU、双读、root CAS、市场生命周期和排除域不变
  - 证据：独立安全终审 P0/P1/P2 均为 0；automation 的 ratchet diff 相对基线为零，旧 unchanged-ratchet 方案因安全与 root 重签 CPU 回归已完整撤回；最终仅保留 config parser/provenance/operator 去重及其 fail-closed 回归。

## 3. 部署与只读观察

- [ ] 3.1 原子提交代码与 change 工件，发布新版本且不改变线上市场配置、permit 或 lane stage
- [ ] 3.2 只读确认 shard1/tag、新部署多个完整 planning tick、`cpuAfterScopeCore-cpuAfterOuterSession` 与所有 56 lane Shadow/suspended、零市场写面
- [ ] 3.3 累积完整 120 样本窗口，与本 change 部署前窗口比较 total/market/preflight/creep/pathing/bucket，并记录负载漂移后再结束观察

## 本地实现完成证据

验证基线为`df2e1af60a035fd99406888d69bba9903e8a7118`，日期为2026-08-10。本文件只证明本地代码、规格和bundle边界完成；未执行部署、console mutation、global reset或线上状态写入。

### 行为与测试

- 最终全量Jest：164 suites / 1371 tests通过，0 snapshot失败。
- Worker/Core最终复审矩阵：7 suites / 135 tests通过；Carrier/downstream最终复审矩阵：23 suites / 244 tests通过。
- TaskSystem、Local Dispatch目标、Worker/Carrier role、board、assignment、amount、MemoryCleanup、main、telemetry、market protection、ResourceControl、Market Direct、Nuker及架构门禁均包含在最终全量运行中。
- `npm run typecheck`：`tsconfig.build.json`与`tsconfig.json`双配置通过。
- `openspec validate local-dispatch-ownership --strict`：通过。
- `git diff --check`：通过。

规范授权的行为变化只有完整ref身份修正：Worker跨房同localId与派工房scope漂移按精确ref隔离；Carrier同房不同producer的同localId共存；accepted cargo、market protection与production commitment继续携带同一完整owner provenance。其它priority、action、refresh/cleanup cadence、main phase、Memory/global/console ABI保持既有合同。

### 复杂度与性能观察

独立聚焦运行使用20 rooms × 20 tasks/domain × 50 actors、5轮warmup、30批 × 100 iterations。median/p95毫秒观察值为：

- Worker current：100.996708 / 103.607083；
- Worker release：77.872375 / 78.492833；
- Carrier list：18.548625 / 19.132291；
- Carrier claim：16.963125 / 17.275375；
- Carrier replace：39.331563 / 40.365500。

这些Node/Jest wall-clock值与变更前聚合值来自不同进程，只用于风险观察，不构成本地通过或部署授权。变更前首次运行的30批原始样本没有持久化，无法重放raw A/B；该限制已同步写入design、tasks与pre-change evidence。每次当前测试仍会向stdout输出完整30批样本。

可复现的硬门禁全部通过：Worker release为5000次精确room读取、5000次精确task读取、0次board枚举；50次acquire与50次reconcile只读取150次assignee descriptor；Carrier exact 400次返回400项、list 20次返回400项、replace 2000次线性读取40000个draft/step、claim 5000次且0次actor枚举、read DTO一次线性输出400项。

### Rollup与生产图

- `npm run build`：通过，仅构建，未部署。
- `dist/main.js`：3,910,819 bytes；相对基线增加46,428 bytes。
- `dist/main.js.map.js`：7,482,992 bytes；相对基线增加104,278 bytes。
- 规范化bundle SHA-256：`169e8cd1ea9d72bff638603508a34d93f241889b982bcf0ce38fd6d10c410e07`；与变更前证据使用同一规则，将整个tag行替换为`const BUILD_TAG = "<normalized>";`后计算。
- source inventory：188项；项目源码176项（173 TS + 3 JS），node_modules 12项；inventory SHA-256：`c0b41a82b284e2394c6c51ce9f37d1db55d2c99a2a8280153b2b695a8b855331`。
- 相对基线只新增4个生产source：`dispatchOwnership/ref.ts`、`actorBinding.ts`、`workerSlot.ts`、`carrierAmountSlice.ts`。
- TaskSystem runtime source为空；TaskSystem只读adapter/snapshot未进入生产图。main phase、Memory/global槽位与console API边界测试通过。

### 独立审查

- Worker/Core独立最终复审：P0=0、P1=0、P2=0。最后关闭项为canonical promotion对正确mirror的零写fast-path与冻结descriptor兼容。
- Carrier/downstream独立最终复审：P0=0、P1=0、P2=0。确认Map hostile sibling隔离、长canonical commitment key和current-only确定性复杂度门禁闭合。
- OpenSpec artifact独立复审最初为P0=0、P1=0、P2=2；两项分别通过诚实记录旧raw样本缺失、定义`local-dispatch-rollout/v1`证据schema与相邻集合净变化公式收口。部署前仍必须实现并冻结本地只读probe脚本，不能把同tick瞬时转换声称为线上已计数事件。

### Rollout状态

本change保持未部署、未归档。以下四个active change的归因窗口尚未全部完成：

- `terminal-headroom-recovery`：37/38；
- `market-base-resource-all-rooms`：43/48；
- `market-direct-continuous`：41/45；
- `market-scope-core-read-cpu`：6/9。

因此8.1至8.4保持未完成。代码可以本地提交，但在四个窗口全部完成并冻结结论前不得执行`npm run push`；后续部署必须先实现只读rollout probe，按design固定的100 tick前后窗口、集合净变化、CPU/bucket公式和回滚顺序保存原始证据。

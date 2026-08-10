## 统一任务系统基础层验证记录

验证日期：2026-08-10（Asia/Shanghai）

### 结论

- 本变更只新增十三类既有工作模型的 canonical Catalog、只读 adapter、统一 snapshot 与无副作用 selector。
- 未把统一层接入 `main`、producer、planner、role、cleanup、Spawn/ResourceControl/market executor 或 console/global API。
- 独立复审结论为本 change 范围 P0=0、P1=0、P2=0。
- 实现后 Rollup 产物与基线规范化字节完全相同，因此无需且未执行部署。

### 聚焦与完整回归

| 检查 | 结果 |
|---|---|
| Worker、Carrier、PowerCreep、ResourceTransfer、Factory、workflow、Spawn、Memory、tick-phase 聚焦 Jest | 34 suites / 430 tests 通过 |
| workspace 全量 Jest | 155 suites / 1229 tests 通过 |
| `npm run typecheck:build` | 通过 |
| `npm run typecheck:test` | 通过 |
| `npm run build` | 通过 |
| `openspec validate unified-task-system-foundation --strict` | 通过 |
| `git diff --check` | 通过 |
| changed/untracked 文本尾随空白与文件末尾换行检查 | 通过 |

### 生产产物等价性

| 项目 | 实现前 | 实现后 |
|---|---:|---:|
| `dist/main.js` bytes | 3,864,391 | 3,864,391 |
| source map runtime sources | 184 | 184 |
| taskSystem sources | 0 | 0 |
| `.d.ts` / test sources | 0 | 0 |
| 规范化 SHA-256 | `76b780138cb930c1927fec83a7c89e3f99712f6870bbd053d9bfb3959379a298` | `76b780138cb930c1927fec83a7c89e3f99712f6870bbd053d9bfb3959379a298` |

规范化只替换唯一动态 `BUILD_TAG` 行；其余 bundle 字节参与完整 SHA-256。hash、字节数和 source map inventory 全部一致，证明新基础层未进入生产入口，37 个 main phase、Memory 写集合与 global ABI 没有因本变更改变。

### 独立审查与范围边界

- Catalog 精确覆盖十三类来源；plan、reservation、ledger、market order/WAL 与 action claim 继续排除。
- adapters 对可证明 identity 的坏记录输出 `unknown`，对无法证明 identity 的坏项只计 system invalid；合法 sibling 保持可见。
- 所有来源读取保持无 ensure、无 migration、无 getter 写入、无 sort-in-place、无 assignment/claim/cleanup 副作用。
- Spawn Production 保留 desired、queued、spawning、materialized 可重叠语义；普通 config 不因 materialized 被误判 terminal。
- `decentralized-logistics-contracts` 继续独占 `TransferContract`、`CapacityLease`、`StageWorkClaim`、`RoomLogisticsAgent`、matcher 与 terminal executor。

### 既有债务与后续顺序

独立审查确认一个非本变更引入、且不阻断本 foundation 的既有 P2：`src/types/memory/data.d.ts` 的 Colonization 声明缺少运行时自 2026-04-05 已使用的 `planRetryAt?: number`。本变更不修改 Memory wire/ambient ABI，adapter 以 `unknown` 只读解析该字段；该声明漂移应作为后续独立小变更修复。

后续行为迁移保持以下顺序，避免统一观测层越权成为调度事实：

1. War 生命周期定规约：停止生产、成员退役、generation exhausted 与 owner-scoped release。
2. Worker/Carrier local dispatch ownership：只迁移派工/claim owner，不改变领域 producer 与优先级。
3. Workflow owned assets：统一 terminal/cancel 的 owner-scoped release hook，禁止 raw store delete 代替完成。
4. `decentralized-logistics-contracts`：按其独立 OpenSpec 建立持久物流合同与 global-reset 恢复。
5. Task observability：在单独评估采样 phase、CPU 与 console ABI 后接入统一 snapshot。

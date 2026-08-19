# Synthesis-only Shadow 本地验证

## 验证范围

- 日期：`2026-08-18`；版本：`2026.8.18-3`。
- 首片只覆盖 typed `synthesisControl` 的 `synthesis_room` latest-state intent、写前事实冻结、legacy decision 配对、纯 matcher/comparator、ResourceControl runtime 投影与 Monitor 防御投影。
- `executionAuthority` 始终为 legacy；本片不创建或执行 TransferContract、CapacityLease、StageWorkClaim，不接管 terminal/market/carrier side effect。
- `distributed` direct/hub-route/resupply、surplus、`auto:synthesis` compatibility 和所有 authority 模式仍不在首片执行范围。

## 关键实现证据

- raw `Memory.data.resourceControl.logistics` 使用 `schemaVersion:1`、`wireFormat:"compact-v1"` 的 canonical tuple wire；公开 decoded DTO 不变。
- 固定 8 房、16 intents、16 observations、每房 8 个 resource facts 的 fixture 为 `5,043` UTF-8 bytes，`emitted=16`、`dropped=0`、`truncated=false`。
- writer 在 attach 前执行 string/tuple/deep/canonical round-trip 与 16 KiB 真实 UTF-8 预检；失败不覆盖旧 store。所有合法 known expanded-v1 在 `ensure` 时原子迁移到 compact-v1。
- capture 只遍历本轮 normalized reaction reagent union，并额外冻结 Energy action facts；task store、production reservations 与 market exposure 均按 epoch 单次建索引/编译。
- 真实 `runSynthesisControl -> runResourceControl` disabled/shadow twin 在同一既有 Jest case 内比较剔除两个 logistics owner 后的 Memory、legacy tasks、Synthesis 状态、CarrierTaskBoard、arbiter、reservation、structures 与 terminal.send/Game.market.deal；结果相同且 Shadow 没有新增调用。
- matcher 是不读取 `Game/Memory` 的纯 helper；budget 256 与分页 1/2/3/5 结果一致，checkpoint 篡改、上限、Energy/non-Energy commitment/action 拆账、legacy merge 边际 action/fee 和 21 条 comparison 聚合均有回归。

## 完整门禁

以下命令在最终候选工作树通过：

```text
npm run typecheck
  typecheck:build PASS
  typecheck:test  PASS

npm run test:budget
  Test Suites: 167 passed, 167 total
  Tests:       500 passed, 500 total
  JEST_TEST_BUDGET=PASSED

npm run build
  dist/main.js 4,228,118 bytes
  SHA-256 066a3cc879ae9e81f50fc808a0d7a602c3f96e43bd23ba751a7c125da7373c11

npx openspec validate decentralized-logistics-contracts --strict
  Change 'decentralized-logistics-contracts' is valid

node --check scripts/monitor-service.mjs
git diff --check
  PASS
```

`npm run test:budget` 调用同一 Jest 配置执行全库 `--runInBand`，并额外验证固定 167 suites/500 cases、测试发现集合、禁止 modifier 与 protected-full 文件，因此覆盖并强于普通 `npm run test` 的本项门槛。

四个 canonical Memory 根声明及 `test/memoryDeclarationBoundaries.test.ts` 均无 diff；主循环顺序、console API、Hub compiler 与 market pricing 路径未修改。market exposure 只新增显式 compiled/batch 只读接口，原单 tuple 热路径保持，且 parity/畸形输入测试通过。

## 独立终审与保留门槛

两路独立只读终审结论均为代码 `P0=0`、`P1=0`，可部署默认 disabled、零 authority 的首片。

以下项目仍明确未完成：

- ResourceControl 没有跨 tick 持久化 matcher continuation；3.4 不完成。
- writer/codec 的精确 16,384/16,385 全矩阵与部分 reader 负例仍不足；8.4a 不完成。
- 本地候选验收当时尚未启用线上 Shadow；后续 live 已取得 10 warmup + 100 measured，但 CPU 与因果/coherent-read 门槛失败，详见 `shadow-live-100-sample-failure.md`。8.5a、9.1a、9.4 仍不完成。
- `terminal-headroom-recovery` 6.4 未完成，任何 contract/lease/claim/Agent authority canary 必须 fail closed。
- 本地 safety 证据证明相同 fixture 的可观察最终状态与 send/deal mock 无新增调用；它不声称捕捉未 instrument、随后回滚/释放/失败的瞬时 attempt。

部署前 ResourceControl pre-p95 已另行冻结在 `pre-shadow-baseline.md`。部署本 bundle 本身没有修改 live config；用户后续另行授权了 Shadow 激活，失败后已于 tick `73089100` 回退为 disabled。

## Shadow v2 修复候选（2026-08-19）

- 候选版本：`2026.8.19-1`。
- live 配置继续保持 `mode="disabled"`；本候选只修复观测、归因与 fail-closed 边界，不授权重新启用 Shadow。
- cfg/data 继续使用 schema v1（data wire 为 `compact-v1`）；runtime projection 升为 schema v2，runtime v1 仅兼容展示且不得进入新的 10 warmup + 100 measured gate。
- CPU v2 要求 exact 五字段 `{attributionVersion,sampleTick,measurementAvailable,producerUsed,consumerUsed}`，并要求同 tick producer seal 与 `measurementAvailable=true`；正式 gate 只使用 CPU Monitor history 中同 tick 的 outer ResourceControl 加 `producerUsed`。
- coherent Memory 读取固定使用 `R1 -> D -> R2`，仅允许一次完整 bounded retry；同 epoch byte mismatch 始终 fail closed。
- bounded causal trace 现在保留 outcome、receiver 与 candidate 证据；所有 material different/unresolved 必须进入样本，否则 projection 不完整且 fail closed。
- exact-store 同 tick cache 只暴露独立冻结的已验证语义图；缺 producer meter、重复/NaN task、异常 quote、非法 reservation 与 malformed Carrier 均 fail closed。

冻结工作树的提交前门禁：

```text
npx tsc -p tsconfig.build.json --noEmit
npx tsc --noEmit
  PASS

npm run test:budget
  Test Suites: 167 passed, 167 total
  Tests:       500 passed, 500 total
  JEST_TEST_BUDGET=PASSED

npm run build
npx openspec validate decentralized-logistics-contracts --strict
node --check scripts/monitor-service.mjs
git diff --check
  PASS
```

两路最终独立审查在固定 hash 上均结论为 `P0=0`、`P1=0`。本候选部署后仍保持 disabled；实际 deploy tag、bundle hash 与 disabled live 核验另记部署证据。任何再次启用 Shadow 都需要新的明确授权，并从新 bundle 重新执行完整 10 + 100 tick 窗口，旧失败窗口不得沿用。

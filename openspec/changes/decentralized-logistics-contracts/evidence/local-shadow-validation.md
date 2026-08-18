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
- 尚未启用线上 Shadow，也未完成剔除 10 warmup 后 100 measured tick；8.5a、9.1a、9.4 不完成。
- `terminal-headroom-recovery` 6.4 未完成，任何 contract/lease/claim/Agent authority canary 必须 fail closed。
- 本地 safety 证据证明相同 fixture 的可观察最终状态与 send/deal mock 无新增调用；它不声称捕捉未 instrument、随后回滚/释放/失败的瞬时 attempt。

部署前 ResourceControl pre-p95 已另行冻结在 `pre-shadow-baseline.md`。部署本 bundle 不等于修改 live config；只有用户另行明确授权后，才可把 live logistics mode 从默认 disabled 改为 shadow 并开始 10+100 tick 验收。

# Luna FC1 交付独立审查：入口结果契约阻塞

审查日期：2026-09-24。
仓库：`ceyirelehe47/screeps-bot`
审查提交：`11b818fb250900273ee485cc60766c10a493b375`
分支：`codex/fc1-final-executor-admission`

## 结论

原 `profileFor()` 10/25 与 `time-budget.plan()` 2/5 的冲突已在生成适配器和最终组装产物中修正。但最终 `observe` 仍不接受新测试入口生成的结果，不能把此次交付视为“只差授权即可上线”。

新的确定性阻塞是 `OFFLINE_GATES_MISSING`：

| 检查 | 实际新输出 | observe 仍要求 |
|---|---|---|
| `tests.status` | `FC1_FINAL_EXECUTOR_VERIFIED` | `READ_XV_RETRY_PACKAGE_TESTS_VERIFIED` |
| 测试总数 | `tests.passed=135`；contract 无 `count` | `tests.passed === contract.count` |
| 失败计数 | 两个分组各有 `failed=0`；顶层无 `failed` | `tests.failed === 0` |

需要在正常生成入口统一测试结果生产与消费规则。不能篡改旧归档结果、删掉整个门禁、只换一个状态字符串，或恢复全部历史测试来掩盖不匹配。

## 复现方式

在本目录用 Node 22 运行：

```sh
node reproduce.cjs
```

脚本使用三份从审查提交读取的原始文件，并在运行前逐一确认 Git blob SHA。
`observe.cjs` 是完整、未经修改的实际模块；`test-result.json` 和 `test-contract.json` 是该提交实际归档的结果及契约。

为隔离结果验收门，本地 VM 中的授权、Git 基线检查、离线 build 结果与 package fingerprint 前提使用成功 fixture；这些不是实际线上授权，也不修改任何仓库。所有文件系统写入由 barrier 拦截，HTTP 模块不可达，不读取凭据。

五个场景确认：

1. 未授权仍停在 `NEW_ROUND_AUTHORIZATION_REQUIRED`。
2. 授权及其他前提成功时，真实新结果被 `OFFLINE_GATES_MISSING` 拒绝。
3. 只修改 fixture 的状态字符串仍失败。
4. 再补 fixture 的 contract.count 仍失败。
5. 三处旧格式要求都满足的诊断对照才通过结果门，并在首次目录创建前被 `SIDE_EFFECT_BARRIER` 截停。

后三个场景仅用于诊断不匹配项，不是建议的修复，不可作为部署证据。
实际复现结果保存在 `reproduction-result.json`。

## 对 Luna 的修复要求

在本轮新修订中统一 `run-tests` 输出与 `observe` 验收。验收应验证必要测试分组确实运行、无失败/skip/todo/cancelled、结果与最终包身份匹配，不能依赖已废弃的历史字段。

保留已有未授权拒绝用例；另补一个有合法合成授权、真实生成测试结果输入的入口用例，让实际 `observe` 跨过离线结果门到受控的网络 fixture。现有新增组合用例主要直接调用 plan/bind/loadSession/uploadOnce/restoreOnce，未授权入口用例又在结果门前结束，所以没有覆盖这次缺口。无需因此恢复全量旧套件。

## 新实验绑定尚需完成的准备

归档 final-executor policy 仍使用旧 `refactorBase=7d3dbeed9a1c24729529cbec8a75d0cb8ae9454d`、旧 FC1 evidencePath 和旧授权/run ID；其说明也标记 online-disabled。
实际 refactor 远端读取值为 `b17979591d8308088c774fbb92a43f4cf5a80df7`。
因此获得明确新授权后，需要一次性核对并重新绑定当前分支身份、新实验 ID、新归档目录、上一轮失败/恢复的准确证据和最终包指纹，再做对应入口检查；不能删除旧 marker、回退分支或复用旧 evidence 目录来让旧检查通过。

## 业务功能范围

审查提交相对 compat 基线 `0cdbd061...` 的 root tree 仅 openspec 改变，src/scripts/test/依赖/构建配置对象一致。本次没有交付 Power Bank 动态采集范围或 Observer/scout 按目标补盲的游戏源码改造，也没有新线上成本样本。

这份复现不是新的实验授权，没有修复源码或推送提交。其范围是上述入口阻塞的独立离线复现；未独立重跑整个仓库或完整部署/采集/恢复流程。

## 对应 GitHub 源位置

全部位于该提交以下前缀：
`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-fc1-executor-admission-repair-i/`

- `task-package/final-executor/tools/observe.cjs`
- `task-package/final-executor/tools/run-tests.cjs`
- `task-package/final-executor/references/test-contract.json`
- `task-package/final-executor-verification/result.json`
- `task-package/fc1-delivery/tools/adapt-executor.cjs`
- `task-package/fc1-delivery/tests/full-cost-admission.spec.cjs`
- `task-package/final-executor/policy.json`

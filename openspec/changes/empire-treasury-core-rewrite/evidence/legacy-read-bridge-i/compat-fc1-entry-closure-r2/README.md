# FC1 Entry Closure r2 离线交付

本修订在独立分支 `codex/fc1-entry-closure-r2` 上基于已核验的 `11b818fb250900273ee485cc60766c10a493b375`。候选的 Treasury 源码仍严格复用冻结提交 `0cdbd061c2645366bd409dbdbd262881d277cb35`，父级、提交标题、改动路径与源对象均经构建器校验；G2 Power Bank 改动未进入此候选。

## 完成项

- 在临时目录复现旧 `observe` 对其真实 `FC1_FINAL_EXECUTOR_VERIFIED` 结果的 `OFFLINE_GATES_MISSING` 阻塞。独立复现脚本与输入保存在 [reproduction/independent-inputs](reproduction/independent-inputs/)，Git blob/场景结果保存在 [prior-entry-closure-result.json](reproduction/prior-entry-closure-result.json)。
- 统一测试结果 producer/consumer。必要分组、文件集合、正数执行、失败/跳过/todo/cancelled、汇总和最终包指纹全部参与门禁；旧的 status/count/top-level failed 检查已移除。
- 入口集成使用最终 run-tests 实际生成的分组结果，在合成授权和 Git 前置下通过最终 observe 结果门，并于首次工作目录写入前停止。五种无效结果均在该边界前被拒绝。
- 将固定源码 emitter 与新授权/run 分离。构建器从已提交 runtime literal 读取 emitter，四个固定 runtime/preview/Core/CPU 工件由 TypeScript 5.9.3 生成并写入含源 blob/hash 的 `runtime-source-manifest.json`。最终 collector 已用真实合成 runtime/preview 的四份报告及四份成本回执验证新外部 run 身份。
- 绑定当前 refactor baseline `b17979591d8308088c774fbb92a43f4cf5a80df7`、R1 独立恢复证据、FC1 `TIMING_PROFILE_INVALID` prior attempt 和全新证据目录。历史证据未改动。

## 本地证据

- 组装执行器：[executor](executor/)
- 最终分组测试：[result.json](validation/final-executor-tests-r6/result.json)；145/145、零失败/跳过。
- Entry closure：[entry-closure.integration-r3.tap](validation/entry-closure.integration-r3.tap)；完整 TAP 保存于 validation。
- Maker suite：[result.json](validation/maker-tests/result.json)；131/131，27 个 CommonJS 文件语法检查通过。
- 旧入口问题复现：[prior-entry-closure-result.json](reproduction/prior-entry-closure-result.json)。
- 可机读总表：[offline-validation.json](validation/offline-validation.json)。
- 汇总矩阵：[MAKER-VALIDATION.json](MAKER-VALIDATION.json)。

## 实机状态

FC1 实机门禁**未授权**：附件中的启动文本不是本轮实际用户消息。最终包保持 pending，未访问服务器，无 candidate/restore POST、marker、上传或线上恢复。完整业务样本数和线上成本回执数均为 0，不能据此声称实测目标达成。可续接位置是本目录的 executor 与 `policy.json`；须在新授权后重新完成线上身份、canonical 旧生产与独占写入权检查。一次线上运行失败后不得自动开新窗口。

## 复现

按 [maintenance/README.md](maintenance/README.md) 提供的命令，用 Node 22.23.3、固定 runtime ref 和 TypeScript 5.9.3 路径重新组装。所有报告都明确区分离线入口/收集器验证与实际部署/实机测量。

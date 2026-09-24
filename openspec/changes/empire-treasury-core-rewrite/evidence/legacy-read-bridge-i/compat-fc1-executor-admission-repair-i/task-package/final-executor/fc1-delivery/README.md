# FC1 最终执行器准入修复

本目录保留 FC1 执行器的正常生成入口。`tools/adapt-executor.cjs` 从固定 XV baseline 组装 FC1 模块，包含 `runtime/time-budget.cjs` 的双边界生成修复和在线授权闩；不手改生成后的 Core 或 executor 文件。

实际组装输出由上层 `build-offline-executor.cjs` 生成。最终 executor 的 `tools/run-tests.cjs` 会执行 contract 指定的旧协议风险回归，并在真实组装目录中运行 FC1 profile、admission、binding、session、上传前检查、关闭与恢复测试。报告和成本回执用例也会从最终 runtime 模块加载。

没有有效的新一轮授权时，输出包只可离线验证。两条在线入口在任何网络/marker副作用之前拒绝 pending 授权。历史 FC1 的 0/4、`TIMING_PROFILE_INVALID` 和 0 次 candidate/restore 写入结论保持不变。

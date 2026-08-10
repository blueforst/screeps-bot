## 变更前证据

基线 commit：`df2e1af60a035fd99406888d69bba9903e8a7118`。

### 行为与构建

- Worker/Carrier 核心、projection、ABI 与直接 producer/consumer：27 suites / 308 tests 通过。
- `npm run typecheck`：build/test 双配置通过。
- `npm run build`：通过；未部署。
- `dist/main.js`：3,864,391 bytes；source map：7,378,714 bytes。
- 规范化 bundle SHA-256：`76b780138cb930c1927fec83a7c89e3f99712f6870bbd053d9bfb3959379a298`。
- source inventory：184 项，其中项目源码 172 项（169 TS + 3 JS）、node_modules 12 项；inventory SHA-256：`f3f31cc45aaa3e68648c1370ecd491dce86628163b21131f096fe2bee7e5504e`。
- TaskSystem runtime source：空集合。

### 性能 characterization

可复现 fixture 位于 `test/localDispatchPerformanceBaseline.test.ts`。协议固定为 20 rooms × 20 tasks/domain × 50 actors，`process.hrtime.bigint`，5 个 warmup batch，随后每个场景 30 batch × 100 iterations；每项原始样本、median/p95 与确定性调用计数均由测试输出为 `LOCAL_DISPATCH_PERFORMANCE_BASELINE` JSON。

第一次完整基线运行的 batch median/p95（毫秒）为：Worker current 12.083/12.378、Worker release 39.879/40.633、Carrier list 13.476/14.086、Carrier claim 12.937/13.586、Carrier replace 61.892/66.713。该次stdout中的30批原始wall-clock样本没有另行持久化，当前树只能复核这些聚合值与下述确定性计数，不能把它们重放为跨版本raw A/B。Node/Jest wall-clock 只作为跨进程观测，不构成通过门槛。

每 batch 的确定性旧实现证据：Worker current 5,000 次 API、5,000 次 room/task/target 读取；Worker release 5,000 次 API、100,000 次 room 读取、5,000 次 board 枚举、52,500 次 task-key 读取；Carrier list 2,000 次 API、40,000 次 task 读取；Carrier claim 5,000 次成功并 release、10,000 次 step-index 读取；Carrier replace 2,000 次 API、120,000 次 task 读取、40,000 次写入。

局限：Node/Jest 不是 Screeps CPU；fixture 使用单 step Carrier task、已绑定 Worker current，以及立即 release 的无争用 amount claim。新增 acquire/read-snapshot 路径必须另以确定性扫描门禁验收。

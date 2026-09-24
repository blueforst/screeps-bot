# Changelog

## 2026-09-24 — FC1 Entry Closure r2

- 修复最终执行器测试结果的实际生产/消费契约，增加 producer 自校验和入口负例。
- 将固定运行时 emitter 从新外部授权/run 中分离，并绑定至冻结 Git 源码。
- 组装器以固定 TypeScript 5.9.3 转译并记录 runtime、preview、Core 和 CPU helper 的源/产物指纹。
- 增加真实 runtime/preview → 最终 collector 的合成四点测试，以及 observe 首写屏障集成验证。
- 当前 policy 仍等待显式授权；本修订未部署、未调用实机 API、未生成线上成本样本。

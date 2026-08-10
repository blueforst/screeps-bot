## Context

当前 `src/global.d.ts` 共约 2,241 行，其中 `Memory` 的四个匿名根对象位于约 621–1,896 行，占整个文件约 57%。四根表达的是不同生命周期平面，而不是四个功能模块：

| 根 | 目的 | 当前一级字段数 |
| --- | --- | ---: |
| `cfg` | 操作者配置与策略 | 17 |
| `runtime` | 跨 tick 执行状态、退避与观测 | 22 |
| `data` | 持久任务、计划、配置与账本事实 | 15 |
| `analytics` | 观测和报告投影 | 5 |

同一领域可以同时占用多个根，例如 ResourceControl 与 Market。拆分边界因此必须按这四个生命周期平面建立，不能把同一领域强行归到单一文件，也不能改变已有 Memory 路径。

当前 `MemoryService` 通过 `NonNullable<Memory["cfg" | "runtime" | "data" | "analytics"]>` 懒初始化四根；根缺失是 global reset、旧 Memory 与测试夹具中的真实状态，因此四根必须继续可选。历史上已经从序列化 Memory 移出的 heap-only 状态也不能借声明整理重新放回 `Memory.runtime`。

TypeScript interface merging 只在成员层面合并，不会深合并同名成员背后的匿名对象。两个文件分别声明 `cfg?: { a?: ... }` 与 `cfg?: { b?: ... }` 会产生 TS2717，而共同扩展一个命名全局接口可以安全合并。

## Goals / Non-Goals

**Goals:**

- 为 `cfg/runtime/data/analytics` 建立明确、命名且可扩展的声明边界。
- 保持四根的全部字段、嵌套类型、可选性、运行时访问路径和初始化语义等价。
- 让生产 build 与完整 workspace typecheck 都显式覆盖所有新声明文件。
- 用编译器 AST 和 bundle 等价性门禁防止漏字段、重复所有权或声明产生运行时代码。

**Non-Goals:**

- 不修改 Memory schema、默认值、迁移、清理、monitor 投影或 shard 数据。
- 不按领域继续拆分 ResourceControl、Market、Logistics 等二级对象。
- 不删除或激活历史 `NodeJS.Global` 块，不整理 console/global ABI，不引入 global manifest。
- 不修改 `global`/`globalThis` 访问方式、prototype augmentation、主循环阶段或任何运行时 `.ts/.js`。
- 不借本切片修正已有声明与局部 runtime cast 之间的类型漂移；真实 schema 修正须另立行为/类型契约。

## Decisions

### 1. 保留一个中央 Memory 根清单

`src/global.d.ts` 继续拥有仓库内唯一的 `interface Memory` 声明，其中仅保留：

```ts
interface Memory {
  cfg?: ScreepsMemoryConfig;
  runtime?: ScreepsMemoryRuntime;
  data?: ScreepsMemoryData;
  analytics?: ScreepsMemoryAnalytics;
}
```

这样读者能在一个稳定入口看见完整根 schema，现有构建门禁和外部文档也无需失去锚点。备选方案是让四个文件分别 augmentation `Memory` 的一个属性；它能编译，但会把根清单分散到多个文件，降低审查时发现新增根或可选性漂移的能力。

### 2. 四个文件分别拥有一个命名分支接口

目录固定为：

```text
src/types/memory/
├── cfg.d.ts        -> ScreepsMemoryConfig
├── runtime.d.ts    -> ScreepsMemoryRuntime
├── data.d.ts       -> ScreepsMemoryData
└── analytics.d.ts  -> ScreepsMemoryAnalytics
```

原匿名对象成员逐字迁入对应接口。每个文件只导入该分支真正需要的类型，并且全部使用 `import type`。即使文件已有 type import，也显式保留 `export {}`，防止未来删掉最后一个 import 后 `declare global` 因不再处于 external module 而触发 TS2669。

四个主接口的一级 inventory 锁定为：

- `ScreepsMemoryConfig`：`rooms`、`worker`、`energyPickup`、`pixelGenerator`、`roomPlannerBuild`、`productionMonitor`、`powerSpawnControl`、`crossShard`、`telemetry`、`cpuProfiler`、`synthesisControl`、`homeDefense`、`resourceControl`、`marketSaleAutomation`、`hub`、`factoryControl`、`remoteMining`。
- `ScreepsMemoryRuntime`：`lastDeployTag`、`energyPickup`、`spawnPlanner`、`roomPlannerBuild`、`linkNetwork`、`towerEmergencyRamparts`、`towerCombat`、`illegalStructureCleanup`、`defenseCoordination`、`crossShard`、`resourceControl`、`marketSaleAutomation`、`factoryControl`、`synthesisControl`、`hub`、`nukerControl`、`resourceReservations`、`powerBankBoost`、`powerBankObserver`、`remoteMining`、`transitDangerRooms`、`powerBankPermanentDangerRooms`。
- `ScreepsMemoryData`：`creepConfigs`、`manualUpgraders`、`marketSaleAutomation`、`resourceControl`、`factoryTasks`、`colonization`、`war`、`roomPlanner`、`rescue`、`flagHauling`、`crossShardColonization`、`interShardPortals`、`powerBankHarvest`、`powerBankHarvestHistory`、`remoteMining`。
- `ScreepsMemoryAnalytics`：`production`、`war`、`moduleCpu`、`cpuMonitor`、`hub`。

### 3. 未来扩展命名接口，不重复声明根属性

未来若某领域需要进一步拆分，必须在独立声明文件中 augmentation `ScreepsMemoryConfig` 等命名接口，或先把某个二级匿名对象提取为另一个命名接口。任何文件都不得再次声明 `Memory.cfg/runtime/data/analytics`，也不得尝试跨文件深合并同名匿名对象。

### 4. 用声明门禁证明“零运行时变化”

新增独立架构测试并使用 TypeScript compiler API，而不是只对源码做脆弱字符串匹配。持续静态门禁必须验证：

- build 与 workspace 两个 Program 都包含 `src/global.d.ts` 和四个分支声明文件；
- 仓库内只有中央 `Memory` 声明拥有四根，四根都是可选的正确 TypeReference；
- 四个分支文件是 `.d.ts` external modules，仅含 type import/ambient 类型声明，不含 initializer、函数体、enum、`require` 或动态 import；
- 四个一级字段 inventory 与迁移前完全一致。

本次变更验收还必须运行 build/test typecheck、全量 Jest 与 Rollup build；Rollup bundle 在规范化动态 build tag 后必须与变更前基线一致，并且 source map 不得包含声明文件模块。bundle 对比依赖当前变更的已记录基线，属于可复跑的 change/release validation，不伪装成无历史输入的永久单元测试。

不把一次编译耗时改善写成目标或 SLA。拆分会略增 compiler input 文件数，价值在所有权与审查边界，不在性能。

## Risks / Trade-offs

- [机械迁移漏字段或改变 optional/readonly/联合类型] → 先写 RED inventory/根引用测试，再逐段原样移动；双 typecheck 与全量 Jest 共同验证消费者。
- [误以为 interface 会深合并，后续重复声明根属性] → 静态门禁要求四根唯一所有者，并在规格中明确命名接口扩展规则。
- [新 `.d.ts` 未进入 Rollup 或 ts-jest 的 Program] → 同时解析 `tsconfig.build.json` 与根 `tsconfig.json`，逐文件断言收录。
- [type import 意外变成运行时依赖] → 只允许 `import type`，并比较 Rollup bundle 的规范化摘要与模块清单。
- [把声明整理扩展成 schema 修复] → 本切片明确冻结现有字段内容；发现的声明漂移记录到后续变更，不在机械迁移中“顺手修复”。
- [中央 `global.d.ts` 仍是共享修改点] → 它只保留根清单和其他既有 ambient 契约；本切片先消除最大匿名对象，后续 ambient ABI 清理独立进行。

## Migration Plan

1. 保存当前 build/workspace Program、一级字段 inventory 与规范化 Rollup bundle 摘要。
2. 先提交会因新接口/文件不存在而失败的声明边界测试。
3. 原样迁移四个匿名对象成员，并让中央 `Memory` 引用四个命名接口。
4. 运行目标测试、双 typecheck、全量 Jest、Rollup build、OpenSpec strict 与 diff check。
5. 本变更不需要 Memory 数据迁移，也不单独部署到 Screeps；若随后续运行时版本一同发布，只需确认 bundle tag，不需要游戏状态验收。
6. 回滚时恢复 `src/global.d.ts` 内联对象并删除四个声明文件；没有持久状态需要恢复。

## Open Questions

无。公开 ambient global ABI、无效 `NodeJS.Global` 与二级领域声明拆分都已明确留给后续切片。

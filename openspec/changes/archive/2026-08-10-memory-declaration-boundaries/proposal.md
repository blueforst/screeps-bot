## Why

`src/global.d.ts` 同时承载公开 global ABI、Screeps prototype augmentation 与四个生命周期不同的 Memory 根，其中 `Memory` 区块已占文件约 57%。任何领域新增字段都必须修改同一个超大匿名对象，评审很难确认改动究竟只影响某个 Memory 生命周期平面，还是意外改变了其他根、可选性或运行时 schema。

这一刀先建立可验证的声明所有权边界：保持 `Memory.cfg/runtime/data/analytics` 的全部现有字段、可选性与运行时路径不变，只把四根对象迁移到各自命名的全局接口。这样后续物流等领域可以沿命名接口继续拆分，而不必依赖 TypeScript 不支持的匿名对象“深合并”。

## What Changes

- 保留 `src/global.d.ts` 作为稳定的 Screeps 全局声明入口，并让 `Memory` 在该文件中只引用四个命名分支接口。
- 新增 `src/types/memory/` 下的 `cfg.d.ts`、`runtime.d.ts`、`data.d.ts` 与 `analytics.d.ts`，原样承接四个根的全部一级字段和嵌套类型。
- 增加声明架构门禁，锁定四根唯一所有者、命名引用、可选性、一级字段 inventory、external-module 形态以及 build/workspace TypeScript 配置的收录关系。
- 证明类型拆分不改变 Rollup 运行时代码、Memory 初始化、主循环阶段、序列化 schema 或已有消费者的类型表面。
- 本变更不删除历史 `NodeJS.Global` 兼容块，不修正公开 ambient global ABI，也不引入 runtime global manifest；这些属于后续独立切片。

## Capabilities

### New Capabilities

- `memory-declaration-ownership`: 定义四个 Screeps Memory 生命周期根的声明所有权、扩展方式与零运行时变化门禁。

### Modified Capabilities

无。

## Impact

- 声明文件：`src/global.d.ts` 与新增的 `src/types/memory/*.d.ts`。
- 架构门禁：TypeScript compiler API/Jest 测试，以及既有 build/test typecheck 与 Rollup build。
- 直接类型消费者覆盖约 68 个生产文件和 68 个测试文件，但它们不需要改 import、访问路径或运行时代码。
- 无 Memory 数据迁移、无外部 API 变更、无 shard 状态写入，也无需为纯声明拆分部署游戏逻辑。

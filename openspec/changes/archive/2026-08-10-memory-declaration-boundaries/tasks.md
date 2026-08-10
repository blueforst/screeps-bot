## 1. 声明合同与基线

- [x] 1.1 保存四根一级字段、build/workspace Program 文件集合与规范化 Rollup bundle 摘要基线
- [x] 1.2 先新增声明边界 RED 测试，覆盖中央根清单、四个命名接口、唯一所有权、optional TypeReference、external-module/type-only 约束与两个 tsconfig 收录关系
- [x] 1.3 增加编译契约样本，锁定 `NonNullable<Memory["root"]>` 与代表性深层字段在拆分后仍可赋值/读取

## 2. 四根声明拆分

- [x] 2.1 创建 `src/types/memory/cfg.d.ts`，原样迁移 `ScreepsMemoryConfig` 的 17 个一级字段及所需 type import
- [x] 2.2 创建 `src/types/memory/runtime.d.ts`，原样迁移 `ScreepsMemoryRuntime` 的 22 个一级字段及所需 type import
- [x] 2.3 创建 `src/types/memory/data.d.ts`，原样迁移 `ScreepsMemoryData` 的 15 个一级字段及所需 type import
- [x] 2.4 创建 `src/types/memory/analytics.d.ts`，原样迁移 `ScreepsMemoryAnalytics` 的 5 个一级字段及所需 type import
- [x] 2.5 将 `src/global.d.ts` 的 `Memory` 收窄为四个可选命名引用，并只移除因迁移后不再需要的 type import

## 3. 等价性验证

- [x] 3.1 运行声明边界目标 Jest、build typecheck 与 workspace/test typecheck，确认零诊断
- [x] 3.2 运行全量 Jest 与 Rollup build，比较规范化 bundle 摘要/模块边界并确认无 `.d.ts` 运行时产物
- [x] 3.3 运行 `openspec validate memory-declaration-boundaries --strict`、全局 strict 校验与 `git diff --check`
- [x] 3.4 独立审查字段/可选性/导入/消费者影响面，确认 P0/P1/P2 均已闭环；记录本切片无需 Memory 迁移或游戏状态部署验收

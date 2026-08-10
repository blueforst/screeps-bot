# Memory Declaration Ownership 规格

## Purpose

定义 `Memory.cfg/runtime/data/analytics` 四个生命周期根的单一声明所有权、命名扩展接缝与零运行时产物边界。

## Requirements

### Requirement: 四个 Memory 根具有单一命名所有权

系统必须（MUST）在仓库声明中只由一个中央 `Memory` 接口声明 `cfg`、`runtime`、`data` 与 `analytics` 四个根。每个根必须（MUST）保持可选，并分别引用 `ScreepsMemoryConfig`、`ScreepsMemoryRuntime`、`ScreepsMemoryData` 与 `ScreepsMemoryAnalytics` 命名全局接口；不得（MUST NOT）以内联对象表达，也不得（MUST NOT）由其他声明文件重复绑定。

#### Scenario: 中央根清单
- **WHEN** 架构测试解析仓库内所有生产声明文件
- **THEN** `src/global.d.ts` 是四个根的唯一仓库所有者，四个属性均为可选且引用对应命名接口

#### Scenario: 根缺失仍是合法输入
- **WHEN** 代码通过 `NonNullable<Memory["cfg" | "runtime" | "data" | "analytics"]>` 定义懒初始化返回类型
- **THEN** TypeScript 检查通过，且声明不会把任一根错误提升为必选

### Requirement: 分支声明保持现有 schema 等价

四个命名分支接口必须（MUST）原样保留迁移前对应匿名对象的全部一级字段、嵌套类型、可选性、联合类型和索引签名。该拆分不得（MUST NOT）新增、删除、重命名或修正持久字段，也不得（MUST NOT）改变任何 `Memory.cfg/runtime/data/analytics` 访问路径。

#### Scenario: 一级字段 inventory 等价
- **WHEN** 架构测试读取四个命名分支接口
- **THEN** `cfg/runtime/data/analytics` 分别包含迁移前锁定的 17、22、15、5 个一级字段，名称集合完全相同

#### Scenario: 现有消费者无需修改
- **WHEN** build 与 workspace TypeScript 配置检查全部生产和测试消费者
- **THEN** 既有 `Memory.root.field`、索引访问与 `NonNullable<Memory["root"]>` 用法零诊断通过，且不需要修改消费者 import 或运行时代码

### Requirement: 命名分支是唯一允许的扩展接缝

未来声明扩展必须（MUST）augmentation 对应的命名分支接口；若要拆分二级对象，必须（MUST）先为该对象建立命名接口。系统不得（MUST NOT）通过在多个文件中重复声明同一 `Memory` 根属性或同一匿名二级属性来尝试深合并。

#### Scenario: 合法的领域扩展
- **WHEN** 新领域声明向 `ScreepsMemoryData` 增加一个此前不存在的可选成员
- **THEN** TypeScript interface merging 可以合并该成员，而中央 `Memory.data` 绑定保持不变

#### Scenario: 重复根绑定被拒绝
- **WHEN** 任意生产声明文件再次声明 `Memory.cfg`、`Memory.runtime`、`Memory.data` 或 `Memory.analytics`
- **THEN** 架构门禁失败，即使重复声明在当前 TypeScript 版本中结构上可兼容

### Requirement: 声明拆分不产生运行时产物

四个分支文件必须（MUST）是位于 `src/**/*.d.ts` 的 external module，只能使用 type-only import 与 ambient 类型声明。它们不得（MUST NOT）包含运行时 initializer、函数体、enum、`require` 或动态 import，并且必须（MUST）同时进入生产 build 与完整 workspace TypeScript Program。

#### Scenario: 两个 TypeScript 边界都收录声明
- **WHEN** 分别解析 `tsconfig.build.json` 与根 `tsconfig.json`
- **THEN** 两个 Program 都包含中央声明和四个分支文件，且生产 Program 仍不包含测试与 Jest ambient

#### Scenario: Rollup 运行时等价
- **WHEN** 在相同源码与固定/规范化 build 元数据下比较拆分前后的 Rollup 输出
- **THEN** JavaScript bundle 的模块集合与语义摘要保持一致，且没有 `.d.ts` 成为运行时模块

### Requirement: 本切片保持其他 ambient 契约原状

本变更必须（MUST）只迁移四个 Memory 根的声明所有权。公开 console/global API、Screeps prototype augmentation、heap-only global cache、历史 `NodeJS.Global` 块和运行时 global 安装时序必须（MUST）保持原状。

#### Scenario: 非 Memory 声明不混入本次迁移
- **WHEN** 审查本变更的生产文件差异
- **THEN** 除中央 `Memory` 区块与四个新分支声明外，不存在公开 global 签名、prototype、runtime TypeScript 或 legacy JavaScript 行为变化

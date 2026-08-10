## 1. 基线与 RED 门禁

- [x] 1.1 记录27个 canonical role、26个 active role、`hubUpgrader` legacy 兼容与现有 registry/profile/GC 集合基线
- [x] 1.2 新增 Role Catalog 单元测试，锁定精确身份集合、生命周期状态、顶层冻结与 fail-closed `isRoleName`
- [x] 1.3 新增架构与类型门禁，锁定 `@/types/system` 导出 ABI、Catalog 低层无依赖、registry/profile key 一致及 MemoryCleanup 不再维护独立白名单
- [x] 1.4 新增 MemoryCleanup 回归，锁定全部合法 role（含 legacy）不因身份清理、未知与原型属性 role 仍被删除

## 2. Catalog 实现与迁移

- [x] 2.1 新增无依赖 `src/types/roleCatalog.ts`，声明 canonical role、active/legacy 状态、派生 `RoleName` 与 `isRoleName`
- [x] 2.2 让 `src/types/system.ts` 从 Catalog type-only 导入并从原路径 re-export `RoleName`，保持现有调用方 ABI
- [x] 2.3 让 MemoryCleanup 使用 `isRoleName` 并删除本地 `VALID_ROLES`，不改变17-tick调度、队列或 managed ownership 清理顺序

## 3. 回归与独立审查

- [x] 3.1 运行 Catalog、MemoryCleanup、role registry、spawn profile、mount 与 SpawnPlanner 聚焦测试以及 build/test 双 typecheck
- [x] 3.2 运行全量 Jest、Rollup build、OpenSpec strict 与 `git diff --check`
- [x] 3.3 独立审查依赖方向、持久化 ABI、legacy 兼容和测试假绿，关闭全部 P0/P1/P2

## 4. 提交、部署与归档

- [ ] 4.1 提交实现并部署同一已验证代码，确认 live deploy tag 与基础 CPU/运行状态
- [ ] 4.2 只读跨17-tick清理窗口确认合法 role 配置集合、引用与 Spawn 队列无身份误删
- [ ] 4.3 同步主规格、归档 OpenSpec change、复跑全局 strict 并提交文档

## 1. 基线与 RED 门禁

- [x] 1.1 记录当前 LinkNetwork Memory 路径、shape、11-tick刷新、17-tick清理、主循环相位与直接生产 owner 基线
- [x] 1.2 新增 gateway RED 单测，覆盖 absent peek 零写入、原样 write、按 owned set prune、删除计数与空容器语义
- [x] 1.3 补充 LinkControl/MemoryCleanup characterization，锁定 `<11`复用、`=11`重算、位置 fallback、非17/17-tick裁剪和 transfer intent
- [x] 1.4 新增架构 RED 门禁，要求生产 `linkNetwork` 属性 owner 仅为 gateway

## 2. LinkNetwork Memory Gateway

- [x] 2.1 新增 `linkNetworkMemory.ts`，从现有 Memory 声明推导 snapshot 类型，以纯 runtime root initializer 实现 peek/write/prune 三个窄操作
- [x] 2.2 让 `linkControl` 通过 gateway 读写分类缓存，保持分类、fallback、周期、容器清理与传能逻辑不变
- [x] 2.3 让 `memoryCleanup` 在原17-tick调用点委托 gateway prune，并删除本地重复 owner
- [x] 2.4 让 gateway、行为和架构 RED 全部转绿，确认 Memory path/shape 与空容器语义无变化

## 3. 静态与回归验证

- [x] 3.1 运行 LinkNetwork、LinkControl、MemoryCleanup、角色消费者和 main phase 定向 Jest
- [x] 3.2 运行 `npm run typecheck`、OpenSpec strict validation 与 `git diff --check`
- [x] 3.3 运行全量 Jest 与 Rollup build，确认 bundle 无 unresolved alias/新增 runtime 依赖异常
- [x] 3.4 独立审查 gateway 唯一 owner、只读零写入、TTL/phase兼容和测试假绿风险，并关闭 P0-P2

## 4. 部署与归档

- [ ] 4.1 提交实现并部署同一已验证版本，记录 deploy tag 与回滚父提交
- [ ] 4.2 只读观察 LinkControl phase CPU、成功 fixed-action 计数与 `Memory.runtime.linkNetwork` 原路径/shape；具体 transfer intent 由 characterization 验证
- [ ] 4.3 同步 capability 到主规格、归档 change，并再次运行 OpenSpec strict validation

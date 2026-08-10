## 1. 基线与 RED 门禁

- [x] 1.1 记录公共 global 写入、私有 heap 槽位、构建常量、ambient 变量与 bundle 规范化摘要基线
- [x] 1.2 新增覆盖 TypeScript、legacy JavaScript、稳定 global alias、非 nullish 简单赋值、公共末态 mutation 与有效 `declare global` 作用域的安装面一致性测试
- [x] 1.3 新增禁止 `NodeJS.Global` 精确镜像、模块局部 `_`、非 external-module 生产 TypeScript、script 顶层值、`declare global` 非变量值声明、`export as namespace` 与未分类 global 槽位的声明所有权测试
- [x] 1.4 新增 9 个缺失命令、市场 cold-heap 可选性、`RP` 与 carrier 命令签名的编译契约
- [x] 1.5 在未改生产声明时运行聚焦测试并确认预期 RED 原因与规格一致

## 2. 声明机械修正

- [x] 2.1 删除 `LoDashStatic` import、模块局部 `_` 与失效 `NodeJS.Global` 镜像
- [x] 2.2 为 `memoryAudit`、`memoryAuditRaw` 与 7 个市场操作命令增加由真实导出派生的 ambient 类型
- [x] 2.3 修正 `RP` 的参数/返回合同并将 `spawnMaxCarrier` 收窄为字符串返回
- [x] 2.4 确认没有 runtime TypeScript/JavaScript、Memory schema 或安装顺序改动

## 3. 验证与独立审查

- [x] 3.1 运行 build/workspace 双 TypeScript typecheck 与聚焦架构测试
- [x] 3.2 运行全量 Jest、OpenSpec strict 与 `git diff --check`
- [x] 3.3 执行 Rollup 构建，核对规范化 bundle 摘要及 source map 模块集合与基线一致
- [x] 3.4 独立审查公共/私有分类、alias/value-escape/末态 mutation 扫描完整性、安装可选性与声明签名，无 P0/P1/P2 后收口
- [x] 3.5 评估部署必要性；纯声明且 bundle 等价时明确记录无需 Screeps live deploy

## 4. 规格同步

- [x] 4.1 将完成的 delta spec 同步到主规格
- [x] 4.2 归档 `ambient-global-abi-contract` 并再次运行 strict 校验

## Ambient global ABI 验证记录

### 影响范围

- 生产改动仅为 `src/global.d.ts`：从 936 行 / 29,249 bytes 收敛为 683 行 / 21,513 bytes。
- 删除未生效的模块局部 Lodash `_` 与 `NodeJS.Global` 镜像；没有把历史镜像激活为新的全局 augmentation。
- 补齐 9 个已安装但漏声明的公共入口，并修正 `RP`、`spawnMaxCarrier` 与 `spawnMaxCarrierRaw` 的真实调用合同。
- 没有修改 runtime TypeScript/JavaScript、Memory schema、main phase、命令名称或安装时序。

### ABI 与静态门禁

- 生产 installer：100 个，精确分为 88 个公共 ABI 与 12 个私有 heap 槽位。
- 有效 ambient 变量：92 个，精确分为 88 个公共 ABI 与 4 个 Rollup 构建常量；公共安装与声明差集为空且无重复 owner。
- 门禁同时覆盖 build Program、legacy JavaScript、稳定 alias、非 nullish 简单赋值、公共末态 mutation、global/globalThis value escape、声明作用域与 `NodeJS.Global` 精确路径。
- 全部 16 个市场控制入口均验证 cold-heap `undefined`、非 `any` 且非空后可调用；新增 7 个入口与 2 个 Memory audit 入口额外锁定真实导出类型。

### 自动验证

- `npm run typecheck`：build/workspace 两个 TypeScript Program 均通过。
- `npx jest --config jest.config.cjs test/ambientGlobalAbiBoundaries.test.ts --runInBand`：1 suite / 5 tests 通过。
- `npm test -- --runInBand`：134 suites / 909 tests 通过。
- `openspec validate ambient-global-abi-contract --strict`：通过。
- `git diff --check`：通过。
- 三路独立审查分别覆盖声明实现、扫描器 mutation/属性测试与最终 gate 复验，最终结论均为 P0=0、P1=0、P2=0。

### Rollup 等价性与部署判断

- `npm run build`：通过；`dist/main.js` 为 3,854,907 bytes。
- 将 `const BUILD_TAG = "..." ;` 规范化为 `const BUILD_TAG = "<normalized>";` 后 SHA-256 为 `a7d29dbe712f25a10e6ad19425bfd7672f95e4d58672252b020e7146dabaad7e`，与基线完全一致。
- source map 共 182 个运行时 source，声明/测试 source 为 0。
- 因生产 JavaScript 字节语义不变且无 Memory/runtime 迁移，本切片无需 Screeps live deploy。

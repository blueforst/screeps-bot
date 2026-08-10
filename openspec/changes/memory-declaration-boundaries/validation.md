## 验证结果

基线：`37fc146d015f4cbc856fb7e502ec1e238526b2d6`。

- 旧四个匿名 TypeLiteral 与新四个命名接口的 TypeScript printer AST 文本逐根完全相同：`cfg 17/17`、`runtime 22/22`、`data 15/15`、`analytics 5/5`。
- 声明边界 RED：实现前 5 项中 4 项按预期失败，唯一通过的是旧代码已满足的“无重复根绑定”；实现后扩充为 6 项门禁并全部通过。
- 边界门禁同时扫描 build Program 内全部 `src` TypeScript 的 global augmentation/全局脚本，避免普通 `.ts` 重绑 `Memory` 根；canonical 分支允许未来独立 augmentation，但自身只允许单一无继承接口、type-only import 与显式 `export {}`。
- `npm run typecheck`：build/test 两个边界均零诊断。
- `npm test -- --runInBand`：133 suites / 904 tests 全通过。
- `npm run build`：通过；`dist/main.js` 仍为 3,854,907 bytes，规范化动态 `BUILD_TAG` 后 SHA-256 仍为 `a7d29dbe712f25a10e6ad19425bfd7672f95e4d58672252b020e7146dabaad7e`。
- source map：182 个 runtime sources，`.d.ts`、测试与 `src/types/memory` runtime module 均为 0。
- `openspec validate memory-declaration-boundaries --strict`：通过。
- `openspec validate --all --strict`：28 项通过，唯一失败仍是变更前已知且与本切片无关的 `fix-power-bank-squad-lifecycle`。
- `git diff --check`：通过。
- 两轮独立终审分别核对递归 schema/类型引用与 mutation-style 门禁；最终结论均为 P0=0、P1=0、P2=0。

本切片没有修改运行时 `.ts/.js`、Memory 初始化、持久路径或 shard 数据，因此无需 Memory 迁移，也不单独部署到 Screeps。回滚只需恢复原内联声明并删除四个 `.d.ts`；不存在游戏状态回滚。

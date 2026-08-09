## 1. 身体生成

- [x] 1.1 让 `twoToOneWorkMoveBody` 同时按能量和 50 部件上限计算完整组合数
- [x] 1.2 确认自动 mineralHarvester config、spawn planner 与 Spawn mount 继续共用同一 profile

## 2. 回归测试

- [x] 2.1 覆盖 3999 与 4000 能量边界，只增加完整组合
- [x] 2.2 覆盖 4250 与高能量房间的 50 部件边界，固定 48 部件和 `32 WORK + 16 MOVE`

## 3. 校验

- [x] 3.1 运行 spawn profile 定向 Jest 与相关 spawn planner 测试
- [x] 3.2 运行 TypeScript、生产构建、diff check 和 OpenSpec strict validate

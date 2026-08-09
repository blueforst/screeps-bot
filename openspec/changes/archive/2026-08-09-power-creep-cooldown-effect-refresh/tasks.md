## 1. 持续效果刷新实现

- [x] 1.1 在 `powerCreepControl.ts` 增加统一的更高级有效同类 effect 判定，并让所有带目标的 Power 任务复用
- [x] 1.2 移除 Storage 与 Source 的“存在任意有效 effect 即不可运行”硬编码，同时保持 cooldown、OPS、优先级和成功出队语义
- [x] 1.3 移除等待中 Storage 对其他 runnable effect 的特殊筛选，并让 workAnchor 跟随实际维护或预定位目标

## 2. 回归测试

- [x] 2.1 覆盖 Storage 同级/更低级 effect 的 cooldown 即时刷新、更高级 effect 等待以及无 effect 原行为
- [x] 2.2 覆盖 Regen 同级/更低级 effect 的即时刷新与成功轮换，以及更高级 effect 等待不轮换
- [x] 2.3 覆盖 Storage 与 Regen 同时就绪时先 Storage、下一 tick Regen 的优先级顺序
- [x] 2.4 覆盖更高级 Storage effect 等待时 runnable Regen 仍执行并锚定 Source

## 3. 验证

- [x] 3.1 运行定向 Jest、TypeScript 类型检查和生产构建
- [x] 3.2 检查限定 diff，并对 change 执行 strict validate

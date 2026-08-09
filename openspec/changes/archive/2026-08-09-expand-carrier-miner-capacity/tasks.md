## 1. Carrier 体型策略

- [x] 1.1 新增共用 1:1 carrier 身体生成策略，最高生成 20 CARRY + 20 MOVE，并按能量预算缩放
- [x] 1.2 将常规 carrier、remoteCarrier、应急 maxcarrier 与 HAUL 旗帜搬运接入共用策略
- [x] 1.3 添加最大容量、低能量缩放和各入口一致性的回归测试

## 2. Miner 体型策略

- [x] 2.1 将 link miner 调整为 8 CARRY，并按非 MOVE:MOVE = 2:1 计算 MOVE
- [x] 2.2 更新无技能、四级 REGEN_SOURCE 与安全换代回归测试

## 3. 验证

- [x] 3.1 运行相关 Jest 测试、TypeScript 检查与构建
- [x] 3.2 运行全量 Jest、git diff 检查和 OpenSpec 严格校验

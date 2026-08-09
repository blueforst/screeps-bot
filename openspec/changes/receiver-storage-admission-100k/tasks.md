## 1. Policy 特征测试

- [x] 1.1 更新默认值与 normalize 测试，锁定 Storage receiver minimum=100k、relief target=200k 且彼此独立
- [x] 1.2 覆盖 fresh normal exact pressure threshold、strictly below threshold、already-pressure exact threshold 与 recovery target
- [x] 1.3 覆盖 Terminal 40k/50k/80k 原关系与 exact pressure threshold

## 2. Receiver 数量合同

- [x] 2.1 移除 capacity-relief planner/ledger/executor 的重复一单位 sentinel
- [x] 2.2 新增 free=150k 可保留100k并接收50k的自动 relief 集成测试
- [x] 2.3 新增 free=100k safe capacity=0、不创建零 task/lease，以及多任务 commitment 不超配测试

## 3. 本地验证与独立复核

- [x] 3.1 运行 Capacity Headroom、Receiver Ledger、ResourceControl/Hub 聚焦测试
- [x] 3.2 运行 TypeScript、全量 Jest、build、OpenSpec strict 与 diff check
- [x] 3.3 独立复核水位独立性、exact threshold、滞回与累计 reservation

## 4. 部署与线上配置

- [ ] 4.1 提交并部署同一已验证 commit，记录父提交与 deploy tag
- [ ] 4.2 备份线上旧 receiver Storage minimum=200k，并写入100k
- [ ] 4.3 读取 runtime effective policy，观察 eligible receiver、排除原因、capacity task route 与接收后 headroom
- [ ] 4.4 严重异常时先恢复线上200k，再部署父提交

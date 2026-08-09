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

- [x] 4.1 提交并部署同一已验证 commit，记录父提交与 deploy tag
- [x] 4.2 备份线上旧 receiver Storage minimum=200k，并写入100k
- [x] 4.3 读取 runtime effective policy，观察 eligible receiver、排除原因、capacity task route 与接收后 headroom
- [x] 4.4 评估严重异常与线上200k/父提交回滚条件；本次未触发回滚

## 5. 线上验收记录

- 实现提交为 `afe2241288f56755dcd30b243183bae98676c357`，父提交/回滚点为 `dc5c6a6e77d02aea51966d44659dab8fb9bf6042`；部署标签为 `2026.8.10-5+afe2241@2026-08-09T21:08:38.708Z`。
- 旧值已由 monitor 快照留存：截至 tick `72891005`，effective receiver Storage minimum 与 recovery target 均为 `200000`；tick `72891035` 起 effective receiver minimum 为 `100000`，而 recovery target 保持 `200000`。
- tick `72892110` 再次读取 runtime effective policy，得到 `receiverStorageMinFreeCapacity=100000`、`storageReliefTargetFreeCapacity=200000`。同窗内 `E7N58` 向 `E4N58`、`E3N59` 向 `W1N57` 等 capacity route 均正常执行；不满足接收余量的任务继续以 `receiver_capacity` 排除，没有出现零量任务或 receiver 超配。
- 未发现严重异常，因此未恢复 `200000`，也未部署父提交；历史快照与父提交共同保留回滚证据。

## 1. 特征与纯预算测试

- [x] 1.1 新增跨房动作 Energy ownership 纯函数测试，覆盖 room watermarks 不参与、生产/其他 payload/fee/ordinary Terminal reserve 参与、current task 排除
- [x] 1.2 新增 E3N59 形态：cargo 已在受压 Terminal、Terminal Energy 为零、Storage 低于 target，旧实现因 `fee_budget` 阻塞
- [x] 1.3 新增 E7N58 形态：Storage 低 Energy 但 room-total ownership 足够，非 Energy cargo 可 staging

## 2. ResourceControl 解耦

- [x] 2.1 将 capacity movable、显式 task executor 与 task staging 切换到动作 ownership budget
- [x] 2.2 让显式 Energy task 不受 donor export state 或 receiver target need 截断，保留自动 Energy 恢复策略
- [x] 2.3 让 capacity relief 可选择 Energy 并按 receiver capacity 而非 Energy target 规划
- [x] 2.4 为 cargo 已在受压 Terminal 的非 Energy staging 增加原子 exact-fee bootstrap

## 3. Direct readiness 与兼容边界

- [x] 3.1 移除 Direct readiness Storage feed 的 room energyFloor 门禁，保留 production、effective reserve、headroom、WAL/exposure/claim
- [x] 3.2 同步 terminal-headroom、market 与 decentralized active specs 中的旧 energy protection 表述
- [x] 3.3 回归 auto reserve、Nuker/本地生产与自动 Energy recovery，证明其水位语义未变

## 4. 验证、部署与观测

- [x] 4.1 运行 ResourceControl/Capacity/Hub/Synthesis/Market 聚焦测试、TypeScript、全量 Jest、build、OpenSpec strict 与 diff check
- [x] 4.2 独立复核 ownership、current-task exclusion、pressure fee bootstrap、Energy capacity relief 与 Direct market 边界
- [x] 4.3 提交并部署同一已验证 commit，记录父提交、版本与 deploy tag
- [x] 4.4 观测 E3N59/E7N58 staging、Carrier feed、task blocker、真实发送与 Storage/Terminal headroom；评估后未触发父提交回滚

## 5. 线上验收记录

- 实现提交为 `afe2241288f56755dcd30b243183bae98676c357`，父提交/回滚点为 `dc5c6a6e77d02aea51966d44659dab8fb9bf6042`，版本为 `2026.8.10-5`；部署标签为 `2026.8.10-5+afe2241@2026-08-09T21:08:38.708Z`。
- 该实现继续包含在 `2026.8.10-6+4cb1bc8` 中。观察到 `E7N58` 的 Storage/Terminal Energy 仅约 `18.5k/37.4k` 时仍完成多批 L staging、Carrier feed 与跨房发送；`E3N59` Storage Energy 约 `141.7k` 时也于 tick `72892090` 向 `W1N57` 发送 `1282` H。
- `E7N58` 最后一批 `422` L 从 admission、无 suppression 到 tick `72892110` 精确完成发送，随后无 pending outgoing；说明既有跨房动作未再被 room floor/target/exportStart 二次门控。未发现生产 ownership、Terminal 物理容量或普通自动 Energy 恢复合同回归。

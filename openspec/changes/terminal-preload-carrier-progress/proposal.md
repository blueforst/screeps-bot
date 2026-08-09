## Why

跨房发送的 source-side Energy ownership 已与房间 `energyFloor/energyTarget` 解耦，但已获准的动作仍可能卡在房内最后一段搬运。Carrier 先处理普通房间 Energy demand，之后才进入 CarrierTaskBoard；所以 board 内的 `priority=80` 无法与普通 Energy 比较。只要 Lab 或下一轮 Spawn 预充持续出现，Storage→Terminal 的容量救援就可能永久得不到 pickup。

E7N58 已在线复现：Storage 满载、L 容量救援已通过 staging admission 并生成 `terminal_feed`，唯一 Carrier 却持续领取普通 Energy，跨房任务长期停在 Terminal 资源不足。这不是 200K 储备门槛，而是两个调度优先级域之间缺少明确边界。

## What Changes

- ResourceControl 在容量救援 staging admission 时，给关联的 `terminal_feed` 增加 heap-only `dispatchClass="capacity_relief"`；Carrier 不解析 task id 或 transfer reason。
- 只有该结构化类别获得一个专用执行通道；相同 producer 的 manual、Hub、自动 Energy、市场 readiness，以及其他 producer 的 feed 都保持原顺序。
- Tower、可立即工作的 active idle Spawn/Extension、PowerSpawn supply 与 Nuker Ghodium 继续优先；所有 active Spawn 都在生产时，Extension 只属于下一轮预充，允许容量救援先取得一个 slice。
- 一次容量救援 pickup 被接受后，该 Carrier 下一次到达低优先级调度点时让出一个完整 pass，避免持续 relief 反向饿死普通 Energy 与其他 board task。
- 容量救援 `terminal_feed` 复用 task-step amount claim 与目标 Terminal 容量 claim；同 tick 多 Carrier 的 accepted pickup 总量不得超过 step 或物理目标余量。
- 未接受或已失效的容量救援绑定在回落普通 Energy 前被选择性清理；accepted snapshot 仍保证已领取 cargo 送往原 Terminal。

## Capabilities

### New Capabilities

- `terminal-preload-carrier-progress`: 定义结构化容量救援 preload 与房内 Energy demand 之间的 Carrier dispatch、数量所有权和公平边界。

### Modified Capabilities

无。

## Impact

- 运行时：`src/runtime/resourceControl.ts`、`src/runtime/carrierTaskBoard.ts`、`src/roles/carrier.ts`、`src/roles/energyTargets.ts` 与 heap-only creep assignment state。
- 类型：CarrierTask 增加可选 dispatch class；不写入 Memory，不迁移线上数据。
- 测试：覆盖结构化分类、隐藏 Tower、active/inactive Spawn、direct PowerSpawn、失败回落、stale binding、同 tick claim 与跨周期公平。
- 线上：E7N58 类型的 accepted capacity relief 获得有界执行机会；Tower 或 active idle Spawn 出现时仍立即抢占。
- 回滚：部署父提交即可恢复旧 dispatch；无 Memory 或配置回滚。

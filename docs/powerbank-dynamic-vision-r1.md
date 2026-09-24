# 动态 Power Bank 区域与统一视野调度

状态：已完成离线实现、定向回归、类型检查和 build-only；**未部署**。

## 正式调用链

`src/main.ts` 按现有 tick 顺序先调用 `runPowerBankObserverIntake()` 消费本 tick 实际可见房间、确认上一 tick 的观察结果并记录 Bank；接着运行 `runPowerBankHarvest()`；普通 remote mining 随后运行；`runPowerBankVisionDispatch()` 最后统一提交 Observer 请求并协调纯视野 scout，位置仍在 `scheduleSpawnTasks()` 之前。Power Bank 不再依赖固定巡逻房间表作发现或派遣裁决。

## 运行规则与预算

- 区域从有效己方 spawn、RCL 6+、可用 Power Bank body、storage/terminal、所需 lab 能力且非防守状态的基地出发。对正常房间沿 `describeExits` 做有界 BFS；每基地最多 256 个图节点、8 个房间单程，最多 128 个 highway 目标、每目标最多保留 8 条基地路线。跨 sector 和 E/W、N/S 零点由房间坐标转换与出口连接处理；中间通行房可不是 highway。危险缓存变化参与失效。
- 区域缓存至少维持 100 tick；PB 巡查视野 freshness 为 250 tick。Observer 目标还受真实线性范围/native 返回码、请求截止时间、失败退避和同 tick 单机一次提交约束。观察成功只登记 pending，下一 tick 的实际 `Game.rooms[room]` 才确认结果。
- 每 tick 需求先按优先级上限 256 个，再在高优先级内优先分配可用 Observer 少的房间、截止时间和最久未见时间。超载写入 `unmet`；每台 Observer 的已提交历史 ID 有 256 项上限。自然可见房间由入口统一扫描，Power Bank scout 复用该 tick 扫描记录。
- 单个 Bank 出现后才用 `PathFinder` 做 tile 级检查：`maxOps=6000`、最多 16 个房间，路线白名单和危险房过滤、静态 CostMatrix、bank 邻位、收货端实际位置；只有完整路径有效，含部分 path 的 `incomplete` 和 ops 耗尽都不会派遣。关键未知/过期风险房需先取得视野。
- ETA 根据实际 body 的有效 MOVE、空/满载 CARRY、road/plain/swamp 疲劳分开估计战斗组、空载 hauler 去程和满载返程。返回实际收货房，按头寸、spawn 队列、boost、bank 自毁时间、creep TTL 和到达时 dropped power 估算准入。Dropped power 用每 tick `amount -= ceil(amount / 1000)` 的规则有界迭代。
- 旧持久任务在新字段缺失时保留兼容估计用于已派任务存续；新任务准入必须先得到完整 tile 路径和实际三段 ETA。区域收缩不会清除活动作战/运输任务。status 输出含 Observer/pending/unmet/scout、候选路线和拒绝原因。
- Observer 无法及时满足时才维护受限缺口 scout；PB patrol 最多 16 个目标，普通 remote 纯视野 fallback 最多 2 个。已有路线/访问证明仍由普通实体 scout 完成；Observer 不写入 `visitedRooms`。

## 行为场景 → 验证

| 场景 | 证据 |
|---|---|
| P1 动态候选、sector/零点与旧名单外 Bank | `powerBankRegion.test.ts`、`powerBankDiscovery.test.ts`、`powerBankMission.integration.test.ts` |
| P2 非 highway 通路、限制房/危险房 | `powerBankRegion.test.ts` |
| P3 内部不可达、partial path、ops 失败 | `powerBankPathing.test.ts`、`powerBankMission.integration.test.ts` |
| P4 body/地形/道路 ETA、满载返程、掉落衰减 | `powerBankPathing.test.ts`、`powerBankViability.test.ts` |
| P5 旧 Bank 去重与可行基地/现有 spawn 计划 | `powerBankDiscovery.test.ts`、`powerBankMission.integration.test.ts` |
| P6 t 提交、t+1 实际 Room 确认、漏结果退避 | `powerBankObserver.test.ts` |
| P7 单 Observer 单 tick、受限覆盖、优先级截断、未满足状态 | `powerBankObserver.test.ts` |
| P8 需求过载与 Observer 历史缓存上限 | `powerBankObserver.test.ts` |
| P9 纯视野 remote mining、实体 scout 路由保留、重复扫描复用 | `remoteMining.test.ts`、`scout.test.ts`、`powerBankScout.test.ts` |
| P10 范围变化时活动任务及资源连续性 | `powerBankHarvest.test.ts`、`powerBankHauler.test.ts` |
| P11 danger 未因 TTL/加入巡查被清除，缓存和 search 上限 | `powerBankRegion.test.ts`、`powerBankObserver.test.ts`、`powerBankPathing.test.ts` |
| P12 正式主循环跨 tick 从 Observer 到孵化；不可达 Bank 不生兵 | `powerBankMission.integration.test.ts` |

## 重跑命令与实际结果

```sh
npm run typecheck
npx jest --config jest.config.cjs --runInBand \
  src/main.test.ts \
  src/runtime/powerBankMission.integration.test.ts \
  src/runtime/powerBankRegion.test.ts \
  src/runtime/powerBankObserver.test.ts \
  src/runtime/powerBankPathing.test.ts \
  src/runtime/powerBankDiscovery.test.ts \
  src/runtime/powerBankViability.test.ts \
  src/runtime/powerBankHarvest.test.ts \
  src/runtime/remoteMining.test.ts \
  src/runtime/powerBankStatus.test.ts \
  src/runtime/spawnPlanner.test.ts \
  src/roles/powerBankScout.test.ts \
  src/roles/scout.test.ts \
  src/roles/powerBankHauler.test.ts
npm run build
```

本轮最终结果：双份 TypeScript no-emit 检查通过；上述 14 suites/51 tests 通过；提交后从干净 HEAD `2cee9c37ab0fc4e0274deda6b26d098bc9c2df30` 重跑 Rollup。输出 `No deployment target set. Build only.`，成功生成 `dist/main.js`，SHA-256 `c949ea237d19f00fcdf32820f0d41fd6a133408507c61d12231b8ee85df0d696`。全量 Jest 未运行；此 bundle 未推送至 Screeps。

## 后续

功能分支单独提交/普通推送，之后只读核对远端 HEAD。本轮不改线上 Memory、不通过 console 生兵、不部署；实际路况、引擎寻路成本和采集成功率尚未在线观察。

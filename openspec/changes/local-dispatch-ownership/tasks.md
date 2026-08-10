## 1. 基线与行为刻画

- [x] 1.1 复跑并记录当前Worker/Carrier核心、直接producer/consumer、双TypeScript、Rollup bundle大小、规范化hash与source inventory基线，确认除OpenSpec artifacts外工作树无非本变更修改；证据见`evidence/pre-change-baseline.md`
- [x] 1.2 为Worker补充home-room、colonizer current-room、缺config回退、priority/distance/assigned penalty/tie、sticky assignment、slot容量与defense safe-zone characterization
- [x] 1.3 为workerRole补充build/upgrade/repair/dismantle的成功、移动、无路、无效target、完成和空能量release characterization，并锁定mount同tick phase切换
- [x] 1.4 为Worker三tick refresh、global-reset空窗、stable upsert、normal-repair黏性、非自有room/dead assignment cleanup、workforce `+1`与非法建筑清理既有副作用补characterization
- [x] 1.5 为Carrier补充已有sticky task优先、失效后priority→source distance、同分稳定顺序、parallel step最近source/destination、普通task多carrier非独占与十二条hard lane characterization
- [x] 1.6 为Carrier补充same-tick amount claim的task/step cap、failed/throw release、OK commit、refresh后committed保留、dead claimant、stale handle与global reset characterization
- [x] 1.7 为Carrier补充accepted cargo在board refresh/prune后继续投递、terminal offload满仓绑定、capacity-relief bounded yield、producer prune/TTL/room mismatch与空replace既有副作用characterization
- [x] 1.8 新增目标红灯用例：Worker跨房同localId精确release与派工房scope漂移、Carrier同房跨producer共存/replace/prune/exact binding/amount隔离/projection双记录，以及downstream完整ref injective stable key；确认旧实现只在规范列明的身份修正上失败
- [x] 1.9 在未改生产代码前建立固定20 rooms×20 tasks×50 actors性能fixture，5轮warmup后分别测30批×100次Worker current/release与Carrier list/replace/claim；每轮release先重建binding，claim逐iteration推进tick，replace使用同exact ref刷新；测试每次向stdout输出原始batch sample、median/p95和确定性scan/call-count，变更前持久证据仅保留聚合值且明确不作为可重放raw A/B；证据见`test/localDispatchPerformanceBaseline.test.ts`与`evidence/pre-change-baseline.md`

## 2. Local Dispatch 身份、binding 与架构边界

- [x] 2.1 新增`src/runtime/dispatchOwnership/`纯ref模型，以type-only `WorkRef`交叉定义Worker/Carrier窄ref、own-field guard、构造、字段级equality与deterministic comparator，并覆盖Catalog/adapter值一致性、特殊字符、原型属性、malformed scope与输入不变性
- [x] 2.2 在现有CreepAssignmentState中加入canonical Worker/Carrier bindings及隔离snapshot，保留`taskId`/`synthesisCarrierTaskId`兼容镜像且不新增global/Memory schema；新store使用null-prototype或等价安全index，旧store只按own property读写actor key
- [x] 2.3 实现actor binding command/read port：保存经验证的ref/scope owned copy、精确bind、expected-ref/CAS release、canonical优先的mirror同步、唯一可证明的legacy heap提升，以及零/多匹配fail-closed
- [x] 2.4 为binding补输入alias隔离、stale release、A→B重绑、mirror漂移、scope/namespace冲突、legacy唯一/歧义、dead actor prune、global reset与safe peek无ensure测试；覆盖actor key为`__proto__`/`constructor`/`toString`的bind/read/release/prune
- [x] 2.5 扩展架构门禁：Dispatch Ownership只能type-import TaskSystem `WorkRef`；catalog/model/registry/snapshot不得反向依赖；adapter仅能导入read DTO且不得导入command/kernel/mutator；canonical/mirror identity、Worker assignee及Carrier identity/steps/publish metadata不得有旁路生产writer
- [x] 2.6 增加排除门禁，确认本目录未定义或实现TransferContract、CapacityLease、StageWorkClaim、RoomLogisticsAgent、terminal/market arbiter、reservation、通用TaskManager或通用claim接口

## 3. Worker slot ownership 迁移

- [x] 3.1 实现`WorkerSlotClaimPort`，以完整ref原子维护actor binding与`assignedCreeps`；新acquire验证容量，已有binding reconcile验证当前room/active/target/safety但保留capacity-shrink超配sticky语义
- [x] 3.2 将Worker current/acquire/release/clamp迁移到slot port，删除跨房间裸taskId扫描，并以expected-ref防止旧release清除新assignment
- [x] 3.3 保持`assignWorkerTask`、`releaseWorkerTask`、`getAssignedWorkerTaskId`兼容gateway，新增精确binding读取，并证明score、sticky、安全区、role release和三tick刷新结果不变
- [x] 3.4 将Worker纯观测consumer切到无ensure selector，验证telemetry数值不变且空房读取不再materialize private store；禁止其它生产模块导入mutable room gateway，并保持roomWorkforce、MemoryCleanup与illegal structure cleanup调用时序
- [x] 3.5 更新Worker task-system adapter以canonical完整ref闭合claim；legacy-only、mirror漂移、scope/namespace冲突和跨房同localId均投影unknown且不修来源
- [x] 3.6 运行Worker role/pool/assignment/adapter/roomWorkforce/MemoryCleanup/main聚焦回归并记录扫描次数，证明release不再遍历所有room task stores

## 4. Carrier owner-scoped board 迁移

- [x] 4.1 将Carrier private room store改为Map-based `room -> producer -> localId -> {task,publishOrder}`加room-local next order，replace逐层复制draft/steps，保留现有private global slot名称；同一exact ref refresh保留createdAt/rank，删除重发取得新rank
- [x] 4.2 实现完整Carrier ref exact lookup、deep-readonly production list/exact view与owner-aware隔离read DTO；排序按priority/createdAt/publishOrder且不暴露private index，覆盖producer/localId原型属性字符串的键安全与非法outer room scope的read fail-closed
- [x] 4.3 迁移replace/prune/TTL/room-mismatch/claim-release cleanup，使每个producer只reconcile自己的room snapshot且同localId其它owner不受影响
- [x] 4.4 保持`replaceCarrierTasksForProducerRoom`、`listCarrierTasksByRoom`、`listCarrierTasksForProducer`生产gateway；将旧localId可写room helper迁为明确test-only mutable helper并禁止生产导入，补publish输入alias与readonly编译门禁
- [x] 4.5 逐个回归Synthesis、Factory、ResourceControl、Boost、MineralExtraction、Nuker、PowerSpawn与PowerBankBoost的publish/clear/createdAt/commitment读取，覆盖动态producer namespace
- [x] 4.6 将Market Direct、MarketSaleProtection与ResourceControl的Carrier task/step稳定键改为完整ref+step的injective结构化编码，并回归特殊字符、destination capacity、terminal bootstrap recovery等隐藏reader，证明同名跨producer事实不误合并且不改变terminal exposure/action arbitration

## 5. Carrier sticky binding 与 same-tick amount slice

- [x] 5.1 将Carrier sticky assignment迁移到完整producer-scoped ref并同步legacy mirror；current task必须先匹配当前assigned room再exact lookup，scope变化或A owner消失后按既有lane重选而不能静默切到同名B owner
- [x] 5.2 更新accepted pickup/pending delivery以保留完整ref，并验证board删除后不会借同名其它producer恢复owner；保持from/to/resource/type snapshot、fallback和terminal offload重试语义
- [x] 5.3 将现有amount ledger封装为独立`CarrierAmountSlicePort`，claim时对完整task ref+step生成owned、单射结构化key（嵌套Map或统一tuple codec）再与claimant计量，保持tick/Game reset、commit/release和dead claimant语义；覆盖producer/localId/step含分隔符时的claim/commit/release隔离以及输入ref alias修改
- [x] 5.4 保持amount slice只接入现有terminal offload、capacity relief与Nuker Energy路径；用门禁/测试证明普通lab/factory/mineral/PowerSpawn等task仍允许多carrier且没有被升级为lease
- [x] 5.5 运行Carrier role/board/assignment/amount/destination/energy reservation/mount聚焦回归，锁定hard lane、sticky、parallel step、bounded yield、accepted cargo与same-tick re-entry

## 6. Projection、ABI 与复杂度门禁

- [x] 6.1 更新Carrier adapter/context读取owner-aware `{ref, task}` DTO，删除旧collision-risk诊断并对跨producer同localId输出两条独立记录；malformed sibling/accessor继续fail-closed隔离
- [x] 6.2 更新registry/snapshot fixtures与duplicate-ref测试，证明canonical排序不依赖private owner order且exact duplicate整批fail-closed
- [x] 6.3 扩展ambient/main/Memory/import边界测试，证明37个main phase、private/public global slot集合、Memory写path、console API、role topology和TaskSystem只读接口未扩大
- [x] 6.4 增加复杂度/调用计数门禁并复跑1.9固定fixture：Worker current/release、Carrier list/replace/claim各自保留30个batch sample和nearest-rank p95，并输出相对同机变更前记录的观测比值；Worker release为exact room lookup，新acquire/reconcile另以确定性计数覆盖，Carrier exact/replace/list/claim不执行rooms×tasks×actors笛卡尔扫描，read snapshot每来源至多线性扫描一次。硬门禁只使用可复现的确定性计数，不以手写缩减kernel或跨进程绝对毫秒判定通过；部署CPU授权留给8.2/8.3同shard前后窗口
- [x] 6.5 运行全部taskSystem与架构门禁，确认生产模块不导入snapshot/adapters，TaskSystem runtime不会因Dispatch的type依赖进入生产图

## 7. 全量验证与独立审查

- [x] 7.1 运行Worker/Carrier及所有直接producer/consumer聚焦Jest，并与1.1基线逐项核对除规范列明的完整ref身份修正外的行为；证据见`evidence/post-change-validation.md`
- [x] 7.2 运行全量Jest、`npm run typecheck`的build/test双配置、`openspec validate local-dispatch-ownership --strict`与`git diff --check`；证据见`evidence/post-change-validation.md`
- [x] 7.3 运行Rollup build，记录bundle大小、规范化hash和source inventory；确认新增source仅为批准的Dispatch/caller，且无TaskSystem runtime、Memory/global/main phase意外变化；证据见`evidence/post-change-validation.md`
- [x] 7.4 进行至少两路独立代码审查，按P0/P1/P2复核identity、CAS、owner reconcile、排序、amount slice、projection、真实producer/consumer与回滚；关闭所有本change P0/P1/P2；证据见`evidence/post-change-validation.md`
- [x] 7.5 核对OpenSpec proposal/design/spec/tasks与实现一致，更新任务勾选和验证证据，确认未实现任何`decentralized-logistics-contracts`保留能力；证据见`evidence/post-change-validation.md`

## 8. Rollout、回滚与归档

- [ ] 8.1 部署前逐项确认`terminal-headroom-recovery`、`market-base-resource-all-rooms`、`market-direct-continuous`与`market-scope-core-read-cpu`的live/Shadow/CPU/保护账本观察均已完成并冻结结论；任一窗口未完成时保持本change未部署，不以“重置后尚在观察”作为通过条件
- [ ] 8.2 先新增并冻结不进入bundle的`scripts/local-dispatch-rollout-probe.mjs`，只复用`npm run monitor:once`与`.codex/skills/screeps-game-data/console-api.mjs --probe`读取既有telemetry、deploy tag和private heap，禁止ensure/修复/写入；按design定义的`local-dispatch-rollout/v1` JSONL schema保存脚本/表达式、stdout/stderr与操作者日志。记录deploy tag、回滚commit及部署前同一shard至少100个连续可观测tick：前10 tick仅warmup，后90 tick计算Worker/Carrier task/binding、amount slice与accepted cargo的可观测净状态变化，连同market protection/production commitment贡献数与保护量、action arbitration、CPU used/bucket；可观测tick必须main完成、telemetry存在、deploy tag稳定且无已知global reset/部署/手工console mutation。median取排序后第45/46项算术平均，nearest-rank p95取第`ceil(0.95*90)`项；然后执行一次全量bundle切换并验证新tag，这不称为分组canary
- [ ] 8.3 部署后以完全相同的schema/脚本/集合编码收集10 warmup + 90 measured可观测tick；对每个集合只按`added_t=difference(S_t,S_{t-1})`、`removed_t=difference(S_{t-1},S_t)`统计可观测净状态变化，不把同tick bind→release、claim→release或pickup→delivery称为已计数事件。保存各hard lane、producer同名隔离、market/commitment完整ref稳定键/贡献/保护量、action arbitration及Memory/global异常的原始证据；未自然发生或无法由相邻快照捕获的稀有lane/瞬时转换必须标为线上未观测并依赖本地目标/领域回归，不得用零变化宣称通过。门禁为`postMedian-preMedian <= max(0.5 CPU, 0.10*preMedian)`、`postP95-preP95 <= max(1.0 CPU, 0.15*preP95)`，且post最后20 tick bucket median不得低于前20 tick median 500以上。身份/保护/仲裁异常或tick crash立即回滚；CPU/bucket超限在收集窗口后判定并回滚
- [ ] 8.4 观察通过后同步delta specs、严格校验、归档`local-dispatch-ownership`并提交最终归档；若回滚，先部署并验证旧tag，再触发global reset，容忍既有producer cadence的空窗并验证Worker/Carrier board重建、accepted-cargo fallback、market protection/commitment恢复及回滚后CPU；不把reset本身描述为恢复完成，不在本change启动decentralized logistics执行迁移

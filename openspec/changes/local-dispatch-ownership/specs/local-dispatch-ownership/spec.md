## ADDED Requirements

### Requirement: 本地派工使用完整 room-scoped WorkRef
Local Dispatch Ownership MUST 以结构化 `{system, namespace, scope, localId}` 识别 Worker 与 Carrier 工作；Worker MUST 使用固定 `workerTaskPool` namespace，Carrier MUST 使用实际 producer namespace，scope MUST 为包含合法 roomName 的 room scope。任何 lookup、binding、release、claim 或 projection MUST NOT 把裸 localId当作跨房间或跨 producer 唯一身份，也不得通过 split命名字符串反推字段。

#### Scenario: Worker 同 localId 在不同房间保持隔离
- **WHEN** 两个房间各有相同 localId 的 Worker task，且一个 creep绑定其中一条完整 ref
- **THEN** exact lookup、assignee闭合和release必须只影响该ref对应房间，另一房间任务不得被扫描命中或修改

#### Scenario: Carrier 特殊字符不破坏边界
- **WHEN** Carrier producer和localId包含冒号、箭头或其他既有命名字符
- **THEN** identity equality与lookup必须按结构化字段工作，不得因字符串拼接或拆分发生别名或误绑定

### Requirement: Actor binding 支持精确比较与 expected-ref release
系统 MUST 在现有 creep assignment heap中保存 Worker/Carrier canonical dispatch binding，并 MUST 以字段级完整 ref比较执行bind、read和release。assignment actor index MUST将actor name作为普通数据键：新store必须使用null-prototype、Map或等价安全结构，已存普通对象只能以own-property语义读写。读取既有binding MUST先验证其room scope仍等于该actor当前领域派工房间。release MUST接受或读取expected ref，并且只有当前binding与expected ref完全相等时才能清除；旧release handle不得清除随后建立的新binding。

#### Scenario: Stale release不影响新任务
- **WHEN** creep先绑定ref A、释放并重新绑定ref B，随后ref A的旧handle再次release
- **THEN** ref B binding及其领域反向索引必须保持不变，旧release必须成为无副作用no-op

#### Scenario: Bind保存ref的owned copy
- **WHEN**command成功bind后，调用方修改原ref对象、nested scope或复用该对象构造其它输入
- **THEN**stored canonical binding、compatibility mirror与反向索引必须保持bind时的值，后续equality/CAS不得观察到调用方修改

#### Scenario: Legacy localId只在唯一可证明时提升
- **WHEN** assignment只含旧localId镜像且预期房间中恰有一条完整ref匹配
- **THEN** command path可以在heap内补齐canonical binding；若为零匹配或多producer匹配，则必须fail-closed且不得跨房间猜测owner

#### Scenario: Actor派工房间变化释放旧scope
- **WHEN** Worker config room、colonizer物理room或Carrier assigned room变化，使canonical binding scope不再等于当前派工房间
- **THEN**系统必须释放旧ref并只在当前房间重新选择，不得因为旧task仍存在而继续sticky

#### Scenario: Actor原型属性名不别名
- **WHEN** actor name为`__proto__`、`constructor`、`toString`或其它对象原型属性名
- **THEN**bind、read、release与dead-actor prune必须只操作该actor的own record，不得命中继承属性、污染原型或改变其它actor binding

### Requirement: Worker slot ownership 原子维护双向索引
`WorkerSlotClaimPort` MUST 成为 Worker canonical actor binding与`assignedCreeps`反向索引的唯一ownership写入口，Worker producer只能在创建task时初始化空assignee列表。对未绑定actor的新Acquire MUST在同一同步事务中验证active task、完整ref、slot容量和actor当前binding，再无重复地写入双向证据；已有完整binding的reconcile MUST验证scope、active、target和安全性，但不得因后续slot缩容或已满而驱逐sticky actor。release、refresh clamp和死亡清理 MUST按完整ref收敛两侧。Worker selection、priority、distance、assigned penalty、安全区和完成predicate MUST保持Worker领域所有。

#### Scenario: 成功认领产生闭合证据
- **WHEN** active Worker task仍有slot且未绑定actor通过现有领域筛选
- **THEN** actor canonical binding必须等于该task完整ref、task必须恰好列出一次actor，compatibility taskId镜像必须等于ref.localId

#### Scenario: 双向漂移不被误认成健康claim
- **WHEN** task assignee列表与actor canonical binding缺失、不一致或scope不同
- **THEN** ownership reconcile必须fail-closed释放或收敛错误关系，且只读projection在收敛前不得发布claimed authority

#### Scenario: Worker既有派工策略不变
- **WHEN** 当前assignment仍active、target有效且满足defense safe-zone
- **THEN** 新出现的更高priority task不得抢占；只有当前任务失效、完成、不安全或既有release条件发生后才按原评分选择新任务

#### Scenario: Slot缩容不驱逐既有sticky actor
- **WHEN**task的maxAssignees从较大值缩小且已有完整binding数量超过新上限
- **THEN**现有binding仍可恢复缺失的assignedCreeps证据并继续执行，只有新actor acquire必须被容量拒绝

### Requirement: Carrier board 由 producer 对房间快照拥有
Carrier board MUST以`room + producer namespace + localId`作为真实存储身份，并 MUST使用Map或等价的null-prototype/own-property安全index，使所有字符串都只作为数据键。它 MUST保留每个producer对一个room的完整snapshot reconcile语义，并 MUST逐层复制publish draft/steps成为board-owned对象。每个exact ref的private record MUST具有单调publishOrder；刷新同一exact ref MUST保留createdAt和publishOrder，删除后重新发布 MUST取得新的publishOrder。删除本owner未重发task、prune owner room或TTL cleanup MUST NOT删除其他producer的同localId task，list MUST从owner index真实membership枚举而不是依赖第二份membership数组。生产list与exact lookup MUST只暴露task/steps的deep-readonly live view；Carrier identity、steps与publishOrder只能由board owner写入。

#### Scenario: 同房同localId跨producer共存
- **WHEN** producer A与producer B在同一房间分别发布localId相同的合法Carrier task
- **THEN** board、list、exact lookup和read snapshot必须同时保留两条ref，任一producer的后续replace或prune不得覆盖或删除另一条

#### Scenario: Publish保存draft与steps的owned copy
- **WHEN**producer replace成功后修改原draft、steps数组或nested step字段
- **THEN**board task、exact lookup、list、amount budget与read DTO必须保持publish时的值，调用方不得绕过owner snapshot改变来源

#### Scenario: Owner refresh保留稳定顺序
- **WHEN** producer刷新已有task且priority、createdAt与其他task形成相同排序键
- **THEN**该task必须保留首次发布位置，list最终tie-break不得因owner-scoped索引的遍历顺序而改变

#### Scenario: 删除重发取得新稳定位置
- **WHEN**exact ref被replace删除或cleanup后在同tick/后续tick重新发布，并与其它task形成相同priority和createdAt排序键
- **THEN**重新发布的ref必须取得新的publishOrder，owner index不得残留旧membership或旧rank

#### Scenario: 原型属性字符串是普通owner identity
- **WHEN**合法room中producer或localId分别为`__proto__`、`constructor`、`toString`或其它对象原型属性名
- **THEN**publish、list、exact lookup、replace、prune和cleanup必须把producer/localId作为数据键精确处理，不得命中继承属性、污染index或漏枚举

#### Scenario: 非法outer room key不成为合法ref
- **WHEN**private heap或read DTO被调试写入`__proto__`、`constructor`、`toString`等不合法room scope
- **THEN**ref guard与projection必须fail-closed隔离该room，且不得污染owner index、执行getter或把它发布成合法WorkRef

#### Scenario: Production reader不能修改board task
- **WHEN**TypeScript或架构测试检查production list/exact lookup的task、steps、producer、roomName、id与publish metadata
- **THEN**这些view必须deep-readonly，生产代码对其写入或导入test-only mutable helper必须在编译或架构门禁失败

### Requirement: Carrier sticky binding 使用完整 producer ref
Carrier已有任务黏性 MUST 使用完整`CarrierDispatchRef`读取当前task，不能只按localId匹配。候选lane、priority、source距离、parallel step选择和可运行判断 MUST 保持现有Carrier领域实现；多个carrier仍可绑定普通task，sticky binding不得被解释为独占slot或数量lease。

#### Scenario: 同名任务不会让既有Carrier静默换owner
- **WHEN** carrier绑定producer A的ref，随后producer B发布同房同localId task
- **THEN** carrier继续解析producer A的exact task；若A任务消失则按既有候选规则重新选择，不得自动返回B任务作为原assignment

#### Scenario: Carrier派工房间变化不保留旧sticky task
- **WHEN**carrier的当前assigned room不再等于binding ref的room scope
- **THEN**旧binding必须释放并在新房间按既有hard lane与候选规则重选，即使旧房task仍然存在

#### Scenario: 普通任务保持非独占
- **WHEN** 一个没有same-tick amount限制的普通Carrier task对多个carrier均可运行
- **THEN**完整sticky binding不得阻止多个carrier选择该task，也不得凭binding推断task已claim、running或terminal

### Requirement: Carrier same-tick amount slice 保持独立生命周期
`CarrierAmountSlicePort` MUST 只表达当前tick内一个task/step的整数执行预算，并 MUST 使用完整Carrier task ref、step id和claimant identity计量。claim MUST保存经验证的owned identity copy，budget key MUST使用嵌套Map、结构化tuple codec或其它字段边界可证明单射的编码，MUST NOT以delimiter concat/split表达ref或step。它 MUST 保持现有failed/throw release、intent `OK`后commit到tick结束、dead claimant回收和owner refresh不释放committed slice语义；它 MUST NOT表达cross-tick lease、carrying、delivery或task progress，也不得自动扩展到现有未调用该claim的Carrier路径。

#### Scenario: 同tick预算按完整ref隔离
- **WHEN** 两个producer的同房同localId task各含相同step id
- **THEN**它们的amount budget必须独立，任一task的claim、commit或release不得消耗另一task额度

#### Scenario: Commit不推进领域任务
- **WHEN** carrier的Screeps intent返回OK并commit amount slice
- **THEN**该slice只需阻止本tick重复领取，board task和step amount不得被递减，下一tick仍由producer观察物理状态后重建

#### Scenario: 同一exact ref刷新保留slice
- **WHEN**producer在同tick刷新相同room、namespace、localId的task
- **THEN**该ref已有的未commit与committed slice都必须继续有效；只有task被replace删除、prune或cleanup时才可释放未commit slice，committed slice仍保留到tick结束

#### Scenario: Amount key在特殊字符下仍单射且owned
- **WHEN**两个不同Carrier ref或step id含冒号、箭头、NUL、引号或反斜线，且claim后调用方修改原ref/scope对象
- **THEN**两个budget必须保持隔离，commit/release/owner cleanup必须仍作用于claim时的owned identity，不得受delimiter碰撞或输入alias修改影响

### Requirement: Carrier下游provenance与稳定键保留完整ref
任何从Carrier task/step派生的accepted-cargo provenance、market sale protection事实、production commitment或dedupe稳定键 MUST包含完整Carrier task ref与step id；downstream reader MUST NOT仅以taskId、room+taskId或taskId+stepId映射room、producer或贡献身份。字符串stable key MUST使用结构化tuple、长度前缀或其它可证明injective的字段边界编码，MUST NOT以delimiter concat/split编码完整ref。该身份修正 MUST NOT改变现有数量计算、terminal exposure、market action arbitration、destination容量或cargo fallback策略。

#### Scenario: 同名step不会在下游去重
- **WHEN**同房两个producer发布相同localId且各含相同step id
- **THEN**ResourceControl、Market Direct与MarketSaleProtection必须保留两条producer-scoped贡献或事实，不得用裸taskId稳定键覆盖、合并或把carrying cargo归给错误owner

#### Scenario: 特殊字符稳定键保持单射
- **WHEN**两条不同完整Carrier ref或step id包含冒号、箭头、引号、反斜线或现有命名分隔符
- **THEN**它们必须生成不同stable key，且任何consumer不得通过split该key反推room、producer、localId或stepId

#### Scenario: Board删除后accepted cargo仍保留原owner provenance
- **WHEN**carrier对producer A的task/step成功pickup后，A task被refresh删除或prune且producer B仍有同房同localId task
- **THEN**pending/accepted cargo必须继续携带A的完整ref与既有from/to/resource/type snapshot，不得借B的同名task恢复owner或改变既有delivery fallback

### Requirement: Dispatch read port 无ensure且隔离来源
Local Dispatch read port MUST 在private heap缺失时返回空快照，不得调用ensure、cleanup、legacy提升、sort-in-place或写端口；输出 MUST 与board、task、step、binding和assignee来源逐层隔离。Carrier read DTO MUST显式携带完整ref而不是暴露private owner index；malformed sibling和accessor不得阻断或执行其它合法记录。

#### Scenario: Global reset读取不创建heap
- **WHEN** Worker board、Carrier board、amount ledger或assignment store在global reset后不存在
- **THEN**read port必须返回空或缺失证据，调用前后private global key集合与来源引用必须相同

#### Scenario: 调用方修改快照不回流
- **WHEN**调用方修改read DTO中的ref、task、step、assignee或binding
- **THEN**production board和assignment必须保持不变，下一次读取不得继承该修改

### Requirement: Compatibility gateway 与运行边界保持稳定
现有领域producer、Worker/Carrier role、replace/list/assign/release入口 MUST继续可用并保持既有业务结果；旧`taskId`和`synthesisCarrierTaskId`在本切片 MUST作为localId兼容镜像随canonical binding同步写入。系统 MUST NOT新增Memory schema、private/public global slot、main phase或console API，且global reset后的heap丢失与原producer cadence重建语义 MUST保持不变。

#### Scenario: 旧localId reader继续工作
- **WHEN**新ownership path成功绑定Worker或Carrier task
- **THEN**旧reader读取对应compatibility字段时必须得到ref.localId，但任何新exact lookup不得依赖该镜像证明namespace或room

#### Scenario: Identity字段没有旁路writer
- **WHEN**架构测试扫描生产代码对`dispatchBindings`、`taskId`、`synthesisCarrierTaskId`和`assignedCreeps`的写入，以及对Worker mutable room gateway的import
- **THEN**dispatch identity与assignee写入必须只出现在批准的ownership/producer入口中，mutable Worker gateway不得被其它生产reader或role用作旁路

#### Scenario: Global reset不伪造持久claim
- **WHEN**global reset清除board、binding和same-tick amount ledger，且当前work的executionAuthority仍为Local Dispatch legacy backend
- **THEN**Local Dispatch必须等待现有Worker refresh或Carrier producer自然重建，不得自行从Memory创建或恢复Task、CapacityLease、StageWorkClaim或cargo ownership

### Requirement: Dispatch ownership 不接管领域授权与物流合同
Local Dispatch Ownership MUST NOT定义或实现TransferContract、CapacityLease、StageWorkClaim、RoomLogisticsAgent、Energy pickup reservation、destination capacity claim、terminal action claim、market exposure/WAL、统一priority、通用completion或TTL。若未来persistent StageWork启用，必须由物流领域的单一executionAuthority选择唯一backend，不能与legacy same-tick slice并行计量同一work；当contract backend获得唯一authority时，RoomLogisticsAgent MAY按其领域规范从持久store恢复lease/claim/cargo事实，Local Dispatch只能消费其发布的本地工作而不得创建或拥有这些持久事实。

#### Scenario: Same-tick slice不是CapacityLease
- **WHEN**Carrier task同时涉及receiver headroom、在途cargo和当前tick执行数量
- **THEN**Local Dispatch只能管理既有same-tick slice，receiver lease、cargo恢复和物理重验必须继续由各自领域owner处理

#### Scenario: Contract authority恢复不受legacy禁令阻断
- **WHEN**未来RoomLogisticsAgent按领域合同成为某work的唯一executionAuthority并在global reset后从Memory/Game恢复CapacityLease、StageWorkClaim或cargo事实
- **THEN**该领域恢复可以继续，Local Dispatch不得启动并行legacy slice或把恢复事实重新据为自己的持久claim

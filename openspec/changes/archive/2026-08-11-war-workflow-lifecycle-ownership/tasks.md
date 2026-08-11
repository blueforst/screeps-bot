## 1. 基线与目标红灯

- [x] 1.1 运行并记录 WarControl、Melee/Healer、Colonization、MemoryCleanup、TaskSystem War adapter 与 SpawnPlanner 相关基线，确认工作树现状（7 suites / 102 tests）
- [x] 1.2 增加 terminal仍有live/spawning时必须立即停产、detach且不重生的目标测试，并先证明旧实现失败
- [x] 1.3 增加 one-shot deployed generation只剩一人时进入`failed:generation_exhausted`的目标测试，并锁定非one-shot继续换代
- [x] 1.4 增加 standard 2攻1疗显式配对测试，证明attacker1不会等待不存在的healer且T3 Boost参数不漂移
- [x] 1.5 增加 Colonization/source变更/defense、terminal GC、restart和console purge必须释放exact owner资产的目标测试

## 2. War 资产释放与终态核心

- [x] 2.1 在War领域实现单次owner config枚举和幂等`releaseWarTaskAssets`，覆盖全Spawn queue、native spawning、configs、Boost与结构化计数
- [x] 2.2 实现非suicide detach：保留role/roleArgs与生命，设置`_warDetached`并清除configName；live lookup重验当前memory防止同tick cache借用旧成员
- [x] 2.3 实现统一terminal helper，原子写status/completedAt/failReason、释放资产并记录assetsReleasedAt；迁移done、staging timeout、Boost failure与controller victory，自动收敛缺证据legacy terminal
- [x] 2.4 实现exact owner purge command，让`stopWarRoom`和兼容`clearWarRoomTask`都先释放再删owner，并保持console结果ABI
- [x] 2.5 在owner restart、source替换与patrol terminal collision覆盖旧record前先释放旧owner，验证其它owner完全隔离

## 3. Generation 与显式编队配对

- [x] 3.1 将one-shot generation耗尽转为`failed:generation_exhausted`并释放资产；保留非one-shot generation递增、patrol survivor suicide等既有领域策略
- [x] 3.2 让War producer为standard attacker0/healer0与T3 duo写exact partner config arg，为standard attacker1写显式无partner事实
- [x] 3.3 修改Melee/Healer role只按自身显式exact partner执行、Traffic换位额外校验reciprocal exact partner，删除configName角色替换推断，并覆盖legacy缺partner fail-open
- [x] 3.4 验证active config刷新、spawn memory roleArgs fallback、detach survivor与Boost prepare均保持正确

## 4. 外部 owner 生命周期调用者

- [x] 4.1 保持Colonization现有状态机顺序，但让完成handoff、source变化、defense暂停和clearing abandon全部通过War领域purge gateway
- [x] 4.2 将MemoryCleanup terminal年龄改为`completedAt ?? statusSince ?? createdAt`，到期或source失效时通过exact purge并保持17-tick cadence
- [x] 4.3 将批量operations stop中的War清理接入领域gateway，保留原有suicide与计数语义且不与通用config清理重复计数
- [x] 4.4 扫描生产源码并移除War领域外所有raw owner delete，增加防回归架构门禁

## 5. 只读 projection 收口

- [x] 5.1 删除War adapter中raw-delete、standard-pairing、one-shot-loss与terminal-config-retention四个固定历史ambiguity；仅对缺assetsReleasedAt的legacy terminal保留release-unconfirmed诊断
- [x] 5.2 保留并回归scope/status/reason/generation/component等malformed fail-closed、确定排序与无副作用合同
- [x] 5.3 验证TaskSystem生产不可达门禁仍通过，War执行路径不导入snapshot/adapter

## 6. 回归与本地交付

- [x] 6.1 运行War/roles/Traffic/Colonization/MemoryCleanup/operations/SpawnPlanner/TaskSystem聚焦Jest并记录测试数（11 suites / 139 tests）
- [x] 6.2 运行全量Jest（166 suites / 1398 tests）、build/test双typecheck、`openspec validate war-workflow-lifecycle-ownership --strict`与`git diff --check`
- [x] 6.3 执行Rollup build，核对main phase/ABI架构测试与生成bundle成功；未执行部署
- [x] 6.4 对最终diff做独立P0/P1/P2审查（P0=0/P1=0/P2=0）；本地实现与bundle已验证，未部署、未取得live行为或CPU证据

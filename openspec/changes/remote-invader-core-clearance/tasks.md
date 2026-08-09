## 1. 外矿 Core 状态机

- [x] 1.1 扩展外矿防御原因并实现 level 0 Core、无敌效果与最低来源房容量判定
- [x] 1.2 将有效任务中的可清理 Core 纳入 `defending`，并兼容既有 `suspended/hostile_structures` 状态迁移
- [x] 1.3 实现无视野仅侦察、无敌期等待、高等级/容量不足暂停以及 defense mode 安全门控
- [x] 1.4 实现 Core 可见消失、任务取消或来源房失效后的 config 与 spawn queue 幂等清理

## 2. 清理单位行为

- [x] 2.1 扩展 `remoteDefender`，在 Core 防御原因下仅选择 Invader Core 作为结构目标并使用单体远程攻击
- [x] 2.2 保持合法 hostile creep 优先级、玩家结构排除与现有返回来源房退役行为

## 3. 自动化测试

- [x] 3.1 为 runtime 补充 Core 识别、旧状态迁移、无敌/无视野/高等级/容量/defense mode 与完成清理测试
- [x] 3.2 为角色补充 Core 单体攻击、玩家结构排除、合法 creep 优先和完成后退役测试
- [x] 3.3 验证 RCL7 `remoteDefender` profile 的单兵伤害预算满足 100,000 hits level 0 Core

## 4. 验证

- [x] 4.1 运行相关 Jest、`npx tsc --noEmit`、`npm run build` 与 `git diff --check`
- [x] 4.2 运行 `openspec validate remote-invader-core-clearance --strict` 并记录 shard1 只读实况证据与未部署风险

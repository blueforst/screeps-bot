## MODIFIED Requirements

### Requirement: Shadow 模式绝对零写
系统 SHALL 在 Shadow 模式执行与 active 模式相同的账本、价格和候选规划，但 MUST 禁止所有市场写 API、market staging 和 market reservation。Shadow 周期证据的连续计数 MUST 只被配置/身份/时序级别的证据作废事件清零；单轮采集 incomplete MUST 只中断该轮推进，MUST NOT 清零已积累的周期证据。

#### Scenario: Active 转入 off 或 shadow
- **WHEN** maker/hybrid 请求切换到 off/shadow，或配置缺失/无效时仍存在订单、pending create/mutation、staging、reservation 或 exposure
- **THEN** 系统先进入 requested/draining；只有排空并达到 stopped 后才正式进入目标模式

#### Scenario: Shadow 观察 100 周期
- **WHEN** 与 canary 完全相同的候选资源、价格底线、信用/费用、批次、历史和 canary 策略配置已冻结为 revision，且 Shadow 在该 revision 累计至少 100 个完整观察周期
- **THEN** 市场写调用和 staging 数均为 0，且所有候选都有接受或拒绝原因；任一相关配置变化必须把连续计数清零

#### Scenario: 采集噪声不作废周期证据
- **WHEN** 某 lane 的单轮 shadow 观察因 terminal 读取不完整、protection 账本单轮不可用、BUY book 读取 blocker、CPU ceiling 超限轮降级或同 tick 观察冲突而记为 incomplete
- **THEN** 该 lane 本轮不推进 completeCycles、不更新 lastCompleteTick；已积累的 completeCycles、lastCompleteTick 与证据 digest MUST 原样保留，后续完整观察从既有计数继续累计

#### Scenario: 持续 incomplete 停涨不晋级
- **WHEN** 某 lane 的观察持续为 incomplete（采集源长期不可用）
- **THEN** 该 lane 的 completeCycles 保持不涨，永远达不到 qualified 门槛；系统 MUST NOT 因计数停滞而放宽观察质量或人工推进 lane 生命周期

#### Scenario: tick 回滚仍清零
- **WHEN** 观察应用的当前 tick 小于该 lane 最近完整观察 tick（服务器回滚/重放）
- **THEN** 该 lane 的周期证据 MUST 清零并在新的时序上重新累计

#### Scenario: Shadow 覆盖异常输入
- **WHEN** Shadow 遇到历史不足或异常盘口
- **THEN** 它记录相同的 fail-closed 决策，且不产生任何副作用

## 1. 回归测试

- [x] 1.1 更新 Power Spawn 控制测试，覆盖非 Hub、无 `OPERATE_EXTENSION` PC、储备切换、无己方 Power Spawn和多房间并行加工。
- [x] 1.2 更新 Energy 目标测试，证明无 PC 能力的非储备加工房间由专用任务接管且不会走普通 Power Spawn Energy 投递。

## 2. 加工与补给实现

- [x] 2.1 将 Power Spawn 加工发现改为所有当前可见、己方控制、拥有己方 Power Spawn 的非储备房间，并移除 E4N58 与 PC 能力门禁。
- [x] 2.2 导出并复用统一房间加工资格，让普通 Energy 目标对有效专用补给让位，同时保留储备停止和 producer prune 行为。

## 3. 合同与本地验证

- [x] 3.1 运行 Power Spawn、Power Creep、Energy target、Carrier 和主循环相关 Jest 回归。
- [x] 3.2 运行 TypeScript 类型检查、构建、`git diff --check` 与 OpenSpec strict validate。
- [x] 3.3 运行全量 Jest，确认现有运行时合同无回归。

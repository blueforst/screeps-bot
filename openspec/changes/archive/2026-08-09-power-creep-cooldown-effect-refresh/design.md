## Context

`powerCreepControl` 已在 cooldown 归零时为 Storage 和下一座 Source 建立任务，但 `isTaskRunnable` 只要看到目标上存在有效同类 effect 就拒绝执行。这与游戏允许同级或更低级 effect 被覆盖的语义不符，也让当前预定位逻辑把本可立即执行的任务误判为等待任务。

## Goals / Non-Goals

**Goals:**

- cooldown 归零后立即覆盖目标上的同级或更低级同类 effect。
- 仅在目标上存在更高级同类 effect 时等待，避免可预知的 `ERR_FULL`。
- 使用同一个等级比较规则覆盖当前所有带目标的 Power 技能任务。
- 保持 Storage 400 优先级、Regen 成功后轮换以及现有队列去重和失败保留语义。
- 等待中的 Storage 只让自身不可运行，不阻断其他 runnable effect 任务，并让 workAnchor 反映实际维护目标。

**Non-Goals:**

- 不增加路径、返程、deadline 或安全裕量计算；`OPERATE_STORAGE` 自带的 200 tick cooldown 已提供调度余量。
- 不改变任务优先级、Memory 结构、Source 稳定排序或 Power Creep 生命周期。
- 不主动覆盖目标上的更高级 effect。

## Decisions

### 统一判定“更高级有效同类 effect”

增加一个内部 helper，读取任务目标的有效 effects，并将同一 Power 的 `effect.level` 与 PC 当前技能等级比较。只有存在 `effect.level > power level` 时返回阻断；没有 effect、同级或更低级均不阻断。

选择统一 helper 而不是继续为 Storage、Source 分别写条件，避免后续带持续 effect 的目标型任务再次出现“只看存在、不看等级”的错误。

### 在 runnable 判定层应用等级规则

调度函数继续以 cooldown 为入队门槛；任务清理继续保留 cooldown 已归零的维护任务。等级规则集中在 `isTaskRunnable` 的目标型 Power 公共路径中：先验证技能 ready 和目标，再拒绝更高级 effect，最后检查 OPS。

这样同 tick 同时就绪时仍由既有优先级决定：`operate_storage` 以 400 先执行并成功出队；下一 tick `regen_source` 以 300 执行并在 `OK` 后轮换。更高级 effect 仅使对应任务暂不可执行，任务本身继续保留。

### 可执行任务保持统一优先级选择

移除 `selectRunnableTask` 对 Storage 的特殊筛选，统一从按 priority、createdAt 排序的队列中选择第一个 runnable task。Storage 一旦可运行仍以 400 自然优先；若它因更高级 effect、cooldown 或 OPS 不可运行，其他 runnable effect 任务继续执行。

实际执行 `operate_storage` 或 `regen_source` 时，workAnchor 指向该任务目标；没有位置型执行任务或仅执行 `generate_ops` 时，才使用既有预定位目标。这样等待中的 Storage 不会把正在前往 Source 的 PC 标记为 Storage 守点。

### 保留既有执行和失败语义

不改变 `executeTask` 与 `finishSuccessfulTask`：`usePower()` 返回 `OK` 才删除任务并轮换 Source；更高级 effect 在调用前即被拦截，因此不会产生预期内的 `ERR_FULL`。其他返回码沿用现有处理。

## Risks / Trade-offs

- [运行时 effect 缺失或等级异常] → 只把 `ticksRemaining > 0` 且等级严格高于当前技能的同类 effect 视为阻断；其他状态交给游戏 API 的返回码处理。
- [Mock 不会自动推进 cooldown] → 顺序回归测试在首 tick 后显式模拟游戏设置 Storage cooldown，确保第二 tick 验证的是真实调度顺序。
- [更高级 effect 长时间存在] → 保留任务且不轮换 Source，待该 effect 消失后自动执行，避免降低已有增益。

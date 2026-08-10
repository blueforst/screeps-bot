## Why

`src/global.d.ts` 同时保留了真实生效的 `declare global`、从未参与 `global` 类型解析的 `NodeJS.Global` 镜像，以及与实际安装函数不一致的控制台命令签名。当前公共命令新增后可以只在运行时安装而不进入声明，错误签名也能长期被局部类型交叉掩盖，导致控制台 ABI 无法被可靠审查。

## What Changes

- 将 `declare global` 明确为扁平公共控制台 ABI 与构建常量的唯一声明入口，并用架构门禁核对生产安装面。
- 删除外部模块中从未生效的 `NodeJS.Global` 镜像，以及同样不生效的模块局部 Lodash `_` 声明；不改变运行时 `global` 访问方式。
- 为 `memoryAudit`、`memoryAuditRaw` 和 7 个市场自动化控制命令补齐声明，声明直接引用其真实导出类型。
- 修正 `RP` 的第二参数及 `false` 返回值，收窄 `spawnMaxCarrier` 为实际控制台字符串返回类型；保留 `spawnMaxCarrierRaw` 的结构化返回合同。
- 以显式白名单区分公共安装、私有 heap 状态与 4 个 Rollup 构建常量，防止未来新增全局槽位时静默漂移。
- 保持所有运行时代码、安装顺序、命令名称和 bundle 字节语义不变；本变更不引入 global manifest 或命名空间迁移。

## Capabilities

### New Capabilities

- `ambient-global-abi-ownership`: 规定公共 `global` 安装面、声明唯一所有权、命令签名与静态一致性门禁。

### Modified Capabilities

无。

## Impact

- 声明：`src/global.d.ts`。
- 测试：新增公共安装面与 ambient 声明的架构边界测试。
- OpenSpec：新增 `ambient-global-abi-ownership` 主能力。
- 运行时：无代码路径、Memory schema、全局安装时序或部署行为变化；构建产物须与变更前规范化后逐字节一致。

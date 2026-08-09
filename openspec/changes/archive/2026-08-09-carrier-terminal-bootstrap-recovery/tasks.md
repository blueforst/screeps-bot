## 1. Recovery policy 与 Memory

- [x] 1.1 为显式 room flag、managed role 认证、连续 25 tick 稳定窗口、pickup 重置和自动清理编写失败测试。
- [x] 1.2 新增 Terminal bootstrap recovery policy，并补充 `Memory.cfg` 与 `Memory.runtime` 可选类型。

## 2. Terminal 安全 pickup

- [x] 2.1 为默认 50,000 reserve 与 recovery reserve override 编写 reservation 单元测试。
- [x] 2.2 让 pickup reservation API 接受局部 Terminal reserve，同时保持所有未传参调用的既有语义。
- [x] 2.3 覆盖 carrier 未启用、显式启用、ResourceControl reserve 底线、market/action 保护和跨房不泄漏场景。
- [x] 2.4 将 recovery reserve 仅接入本房 Spawn/Extension demand 路径，并在成功 bootstrap pickup 时重置稳定窗口。

## 3. 验证

- [x] 3.1 运行 recovery policy、energy pickup reservation 与 carrier 定向 Jest，并确认当前 Nuker carrier 改动回归不受影响。
- [x] 3.2 运行 TypeScript、build、diff check 与 OpenSpec strict validate；不提交、不部署、不改版本。

## 4. 独立审阅修复

- [x] 4.1 先以失败测试覆盖同 tick 两个 carrier 的实际 reservation claim 分配、最终 Terminal withdraw 总量上限和 release/重取/default 50,000 reserve 兼容性。
- [x] 4.2 让 reservation API 可读取当前 creep 的实际 claim amount，并让 Terminal 执行层严格按该 claim cap withdraw。
- [x] 4.3 在周期 Memory cleanup 中清除没有 true flag 的 recovery runtime entry 与空容器，并补充回归测试。
- [x] 4.4 同步 design/spec，运行定向与全量 Jest、TypeScript、build、strict validate 和 diff check。

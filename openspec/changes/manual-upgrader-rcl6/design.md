## Context

手动 `upgrader` 目前仅在 RCL7 有效，且使用 15 WORK、5 CARRY、10 MOVE 的固定 2250 能量身材。RCL6 的房间能量容量为 2300，能够安全出生该身材，而 RCL8 仍不需要升级。

## Goals / Non-Goals

**Goals:**

- 允许己方 RCL6 与 RCL7 房间发布和维持手动 `upgrader`。
- 保持 RCL8 自动清理与本地 T3 选择规则不变。

**Non-Goals:**

- 不为 RCL5 及以下设计缩放身材。
- 不改变固定身材、boost 需求或控制台命令名称。

## Decisions

1. 将单一等级判定替换为 `controller.level >= 6 && controller.level < 8`，供启动命令、控制循环和角色自身共享。
2. 错误文本改为 `OWNED_RCL6_OR_RCL7`，让控制台反馈与实际合同一致。

## Risks / Trade-offs

- [RCL6 刚升级时可用能量未达 2250] → 出生计划会等待能量攒够；不创建低规格 creep。
- [未来想支持 RCL5] → 需要单独引入容量缩放 body，不能只继续放宽等级判定。

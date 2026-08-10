# LinkNetwork Memory Gateway 基线

基线提交：`9f42fd4`。

## 运行目的

- `linkControl` 将己方房间 Link 分类为 Source sender 与 Storage/Controller receiver，结果缓存 11 tick，避免每 tick重复位置扫描。
- `isReceiverLink` 以 cached receiver OR position 判断；`isStorageReceiverLink` 在有缓存时以 cached receiver AND storage-position 判断、无缓存时回退位置判断。
- `memoryCleanup` 每 17 tick删除已不属于己方房间的 Link 分类缓存，防止持久化分支无限增长。

## 兼容面

- wire：`Memory.runtime.linkNetwork[roomName]`。
- shape：`{ updatedAt: number, senderIds: string[], receiverIds: string[] }`。
- classify 到期条件：`Game.time - updatedAt >= 11`。
- cleanup 调度：`Game.time % 17 === 0`。
- phase：`memoryCleanup` 先于 `linkControl`。
- 清空最后一项后保留空 `linkNetwork` 容器。

## 当前 owner 与消费者

- 初始化/写入/TTL读取：`src/runtime/linkControl.ts`。
- 失房删除：`src/runtime/memoryCleanup.ts`。
- 领域消费者：`src/roles/energyTargets.ts`、`src/roles/carrier.ts`，仅通过 LinkControl API。
- 声明：`src/types/memory/runtime.d.ts`。
- 仓库 monitor/console 没有直接消费该字段。

## 历史

该路径、shape、11-tick分类与失房清理由 `d27deca`（`fix(v2026.02.27-6): harden link-era economy flow and core safemode guards`）同时引入；后续改动没有迁移 wire。

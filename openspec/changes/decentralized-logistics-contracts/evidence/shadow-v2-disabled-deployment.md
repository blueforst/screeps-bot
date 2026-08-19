# Shadow v2 disabled 部署记录

## 部署身份

- 部署时间：`2026-08-19`（Asia/Shanghai）。
- 代码 commit：`eb26197ae7230d623c18f7fd840b2f4c38ea6aff`（`fix(logistics): harden shadow telemetry gate`）。
- package version：`2026.8.19-1`。
- live deploy tag：`2026.8.19-1+eb26197@2026-08-19T04:40:18.525Z`。
- 执行命令：`npm run push`。
- 部署工具返回：`Uploaded 1 module(s) to Screeps branch default.`，exit code 0。
- 上传 bundle：`4,277,706` bytes；SHA-256 `be7e8377df38a4ab6339997b34bd52024e3cbebc2c3925e3616cca4f62e55737`。
- 回滚代码 commit：`06606da6557e4fadd07be81bedca7f2a70fa503a`；本次未执行回滚。

## live 配置与运行时核验

Screeps API 首次读取遇到既有限流；没有改变凭据或 live Memory，等待服务给出的 reset 窗口自然结束后再做只读核验。

- shard：`shard1`。
- 捕获时间：`2026-08-19T04:49:27.142Z`。
- latest tick：`73104845`；ResourceControl runtime `updatedAt=73104840`。
- 精确 live 配置：`{"canaryScopes":[],"schemaVersion":1,"mode":"disabled"}`。
- runtime logistics：`schemaVersion=2`、`requestedMode=disabled`、`effectiveAuthority=legacy`、`blocker=mode_disabled`。
- `available=false`、`complete=false`、`livenessAvailable=false` 是 disabled 合同的预期结果；没有开始新的 Shadow 测量窗口。
- coherent-read 状态：`snapshotIncoherent=false`、`inconclusive=false`、`coherenceRetryCount=0`。
- Memory：data `87B`、runtime `1,607B`、合计 `1,694B`，`withinLimit=true`。

可观察 authority / Shadow 记录全部为零：

```text
nonLegacyAuthorityRecords=0
activeContracts=0
activeLeases=0
activeClaims=0
shadowArbiterActorRecords=0
shadowClaimRecords=0
shadowJournalRecords=0
shadowCarrierTaskRecords=0
shadowReceiverReservationRecords=0
violations=[]
```

Market 侧同一轮只读投影为 `terminalClaims=[]`、`safetyViolationCount=0`。

## 权限边界

本次部署只更新代码并保持 live logistics disabled；未执行 console Memory 写入，也未授权 `shadow`、`canary` 或 `enabled`。任何再次启用 Shadow 都需要新的明确授权，并必须从本 bundle 重新执行 10 warmup + 100 measured tick；旧失败窗口不得拼接、倒填或复用。

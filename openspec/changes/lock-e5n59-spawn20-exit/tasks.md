## 1. 出生策略实现

- [x] 1.1 在 Spawn executor 中增加仅匹配 E5N59/Spawn20 的安全出口策略
- [x] 1.2 在 `spawnCreep` options 中仅为目标 Spawn 写入 `directions: [TOP]`
- [x] 1.3 保持队列、Memory、失败记录与 transient config 生命周期不变

## 2. 回归测试

- [x] 2.1 验证 Spawn20 的 carrier 与非 carrier 请求都只使用 `TOP`
- [x] 2.2 验证 E5N59 其他 Spawn 及其他房间 Spawn 不携带 `directions`
- [x] 2.3 验证目标 Spawn 的成功出队与失败重试语义保持不变

## 3. 静态验证

- [x] 3.1 运行 mountSpawn 定向测试
- [x] 3.2 运行全量测试、TypeScript 检查、构建与 OpenSpec 校验

## 4. 发布验证

- [x] 4.1 更新版本、创建 Git commit 并部署到游戏
- [x] 4.2 验证 shard1 deploy tag、E5N59/Spawn20 状态与工作区清洁度

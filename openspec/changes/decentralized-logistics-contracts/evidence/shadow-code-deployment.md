# Synthesis-only Shadow 代码部署记录

## 部署结果

- 部署时间：`2026-08-18`（Asia/Shanghai）。
- 代码 commit：`06606da6557e4fadd07be81bedca7f2a70fa503a`（`feat(logistics): add synthesis shadow comparator`）。
- package version：`2026.8.18-3`；bundle 内预期 tag 前缀：`2026.8.18-3+06606da`。
- 执行命令：`npm run push`。
- 部署工具返回：`Uploaded 1 module(s) to Screeps branch default.`，exit code 0。
- 最终上传 bundle：`4,228,118` bytes；SHA-256 `e28593d52c30980a59830c21f1a3aed29370fa8ab6b3cd1ccc1fe4016f6d132f`。
- 首选回滚代码 commit：`7384afb`。

## 权限与配置边界

本次只上传代码，没有执行任何 Game/Memory 写入，也没有修改 live `Memory.cfg.resourceControl.logistics`。缺失配置由新代码解析为 `mode=disabled`；运行时代码没有启用 contract backend 的调用点，因此本次部署不启动 Shadow comparator，更不创建 contract、lease、claim 或改变 legacy execution authority。

只有用户另行明确授权 live Memory 变更后，才允许将 mode 改为 `shadow` 并开始 10 warmup + 100 measured tick 观测。`canary/enabled` 与所有 authority 切换仍不获授权。

## 部署后只读验证边界

上传后只发起了一次 shard1 Monitor 只读请求，Screeps API 返回 HTTP 429、remaining 0。请求随即停止；没有使用服务返回的绕过限流入口，也没有重试或更换凭据。

因此部署当时只能证明工具成功写入 remote `default` 分支和上传 bundle 的本地身份。后续 live 已确认 tag、在用户独立授权后激活 Shadow，并完成 10 warmup + 100 measured 窗口；该窗口因 CPU 与因果/coherent-read 门槛失败，详见 `shadow-live-100-sample-failure.md`。当前 mode 已回退为 disabled，9.4 仍未完成。

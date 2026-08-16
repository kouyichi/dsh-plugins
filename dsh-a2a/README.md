# dsh-a2a — 原生 A2A 服务端

把 dsh 暴露为 **A2A v1.0**（Agent-to-Agent，JSON-RPC over HTTP）agent——其他 agent（Hermes 等）可直接调 tasks/send 让本 dsh 干活。生态空白：截至 2026-08-16 无第三方 A2A server（官方示例只覆盖 ACP/JSON-RPC）。

## 工具

| 工具 | 功能 |
|---|---|
| `a2a_start` | 启动 server（默认 127.0.0.1:9917；require_token=true 加 Bearer 认证） |
| `a2a_stop` / `a2a_status` | 停止 / 状态 |
| `a2a_tasks` | 任务列表与状态 |

## 协议

- `tasks/send` {id, message:{role, parts:[{type:"text",text}]}} → Task
- `tasks/get` / `tasks/cancel` / `tasks/list` / `agent/get`

每个任务独立 agent 执行（会话落盘可审计）。token 优先读 `DSH_A2A_TOKEN` 环境变量；`DSH_A2A_AUTOSTART=1` 可在启动时自动开。

## 示例（curl）

```bash
curl -s -X POST http://127.0.0.1:9917 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks/send","params":{"id":"t1","message":{"role":"user","parts":[{"type":"text","text":"运行 echo hello"}]}}}'
```

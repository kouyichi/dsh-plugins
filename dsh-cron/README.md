# dsh-cron — 后台定时任务

与官方 `schedule_create`（会话内提醒，session-local）不同：cron 是**跨会话持久后台任务**——每个任务每 N 分钟用独立 agent 执行一次 prompt，结果摘要落日志，重启后继续（Hermes cron + Kimi 内置 cron 模式）。

## 工具

| 工具 | 功能 |
|---|---|
| `cron_add` | 注册任务 {name, prompt, every_min} |
| `cron_list` | 任务列表（下次执行/上次状态） |
| `cron_remove` | 删除任务 |
| `cron_run` | 立即执行一次 |
| `cron_logs` | 执行历史 |
| `cron_status` | 插件状态 |

存储：`~/.dsh/cron/jobs.json` + `logs.jsonl`；每个任务独立 agent（会话落盘可审计）。

## 示例

```
cron_add name=每日检查 prompt="检查工作区状态并输出摘要" every_min=60
cron_list
cron_run id=c_xxxx
cron_logs
```

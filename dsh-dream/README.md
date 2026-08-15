# dsh-dream — 记忆整合插件（Claude auto-dream 移植）

把 Claude Code 社区著名的 auto-dream skill（grandamenium/dream-skill，模拟 Anthropic 未发布的 auto-dream）移植到 dsh。

## 4-phase 流程

1. **Orient** — 读取现有 `~/.dsh/dreams/MEMORY.md`
2. **Gather** — 扫描最近 20 个会话（多帧 zstd 解码），提取用户消息、注入消息、工具失败
3. **Consolidate** — 派子代理把新信号合并进记忆：相对日期→绝对、消矛盾、去重、用户纠正优先
4. **Prune & Index** — 重建为 ≤200 行精简索引

## 自动触发

后台每小时检查一次：距上次整合 ≥24h 即自动执行整合 pass（fork 子代理，无需用户在场）。

## 工具

| 工具 | 作用 |
|---|---|
| `dream_run` | 手动执行一次整合 |
| `dream_status` | 上次整合时间、到期倒计时、MEMORY.md 行数、历史记录 |
| `dream_now` | 跳过间隔检查强制整合 |

## 数据位置

- `~/.dsh/dreams/MEMORY.md` — 整合后的记忆（纯 markdown，可手动编辑）
- `~/.dsh/dreams/signals/` — 每次 pass 的原始信号
- `~/.dsh/dreams/state.json` — 状态

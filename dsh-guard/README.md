# dsh-guard — 安全 / 审批 / 治理

生态空白：整个 security & governance 分类都是 0-3★ 萌芽。本插件把两个头部 agent 的安全模式移植到 dsh：

- **Codex「sandbox × approval」** → 声明式拒绝规则层（`tools.guard()` 官方 seam，单调拒绝、无规则即无操作）
- **Claude Code PreToolUse hook 审计**（security-guidance）→ 全量工具调用审计 + 治理报告

## 工具

| 工具 | 功能 |
|---|---|
| `guard_rules` | 规则管理：add {tool, pattern, reason} / remove / list / toggle。tool 支持通配（bash*） |
| `guard_report` | 治理报告：工具分布、错误率、被拒统计、危险命令命中 |
| `guard_status` | 插件状态 |
| `guard_export` | 审计导出 markdown |
| `guard_clear` | 清空审计 |

存储：`~/.dsh/guard/rules.json` + `~/.dsh/guard/audit.jsonl`

## 示例

```
guard_rules action=add tool=bash pattern="rm -rf /" reason="禁止删除根目录"
guard_rules action=add tool=web_search reason="本项目禁用联网搜索"
guard_report period_days=7
```

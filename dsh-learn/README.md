# dsh-learn — 自我学习 + 技能维护插件

把 Hermes 的「自我学习 skill + 定期修正/退役总结 skill」（curator 机制）移植到 dsh。

## 功能

| 工具 | 作用 |
|---|---|
| `learn_record` | 会话中记录经验（纠正/踩坑/偏好/模式/工具）到收件箱 |
| `learn_draft` | 收件箱条目 → 技能草案（learn/drafts/） |
| `learn_promote` | 草案发布 → `~/.dsh/skills/`（dsh 自动发现，所有会话可见） |
| `learn_list` | 技能清单 + 生命周期状态（active/stale/archived/draft） |
| `learn_review` | 审查 pass：自动生命周期过渡 + 子代理内容审查（合并/修正/退役建议） |
| `learn_retire` / `learn_restore` | 主动退役（可恢复）/ 恢复 |
| `learn_pin` / `learn_summarize` | 钉住技能防自动退役 / 学习总结 |

## 生命周期（Hermes curator 同款）

- `active` → 30 天未用标 `stale` → 90 天未用自动归档（`learn_restore` 可恢复）
- pinned 技能永不自动过渡；从未用过的技能有宽限期
- 后台每 6 小时静默跑一次自动生命周期过渡
- 审查默认 dry-run 只出报告；归档可恢复，绝不自动删除

## 安装

1. profile `package.json` 添加 `"dsh-learn": "file:../../plugins/dsh-learn"`
2. 家级/对应 profile 的 `cordis.patch.yml` 添加 `- insert: [{ id: dsh-learn, name: dsh-learn }]`
3. `dsh plugin --profile <name> install` 后重启

## 数据位置

- `~/.dsh/learn/` — 收件箱、状态机、草案、归档、报告
- `~/.dsh/skills/<name>/SKILL.md` — 发布的技能（dsh 自动发现）

# dsh-tower — Kimi Code `/tower` 移植（control tower 多代理编排）

**上游**：MoonshotAI/kimi-code `feat(agent-core): add tower command to orchestrate multi-agents`（#2633，2026-08-16 合并）。本插件忠实移植其协议设计，工具名用 dsh 风格（`tower_*`）。

## 核心模型

- **The tower（你）**：唯一指挥塔，绝不写产品代码——规划 missions、派发 workers/reviewers、路由消息、合并分支、向人汇报
- **Workers**：每个 mission 一个，在**自己的 git worktree**（`.tower/worktrees/wt-N`）里干活，互不踩踏
- **Reviewers**：审查分支，结论通过 `tower_review` 提交（按分支 tip 打戳）
- **协议由工具强制**：`.tower/` 下的文件（state/inbox/findings/reviews/missions/activity log）只能由 Tower 工具写入，**禁止手改**；scope 重叠/越界、review 不干净、deps 未合并都会被 store 拒绝

## 工具（11 个）

| dsh 工具 | Kimi 对应 | 作用 |
|---|---|---|
| `tower_init` | TowerInit | 初始化 .tower/ 工作区（需 git 仓库，幂等） |
| `tower_plan` | TowerPlan | 拆 2-4 个 missions（build scope 两两不相交，survey 只读） |
| `tower_spawn` | TowerSpawn | 派发 worker（mission_id，自动建 worktree）或 reviewer（review_target） |
| `tower_status` | TowerStatus | 仪表盘：missions/roster/review gate/inbox 计数/activity |
| `tower_send` | TowerSend | 参与者间消息（tower/all/指定 agent） |
| `tower_inbox` | TowerInbox | 读收件箱（tower 看全部） |
| `tower_mission` | TowerMission | 读/更新 mission（worker 只能改自己的；task_done/note/blocker） |
| `tower_finding` | TowerFinding | scope 外发现提交给 tower 路由（bug/improve/vuln/idea） |
| `tower_review` | TowerReview | 审查结论（clean/p1-N/p2-N + merge 建议，按 tip 打戳） |
| `tower_merge` | TowerMerge | 合并分支（硬门禁：clean review + tip 未移 + deps 已合 + 改动在 scope 内） |
| `tower_teardown` | TowerTeardown | 全部合并后拆除 worktree（dirty 保留除非 force；comms 审计保留） |

## 数据（仓库内 `.tower/`）

```
.tower/
├── state.json          # 单一事实源（roster/missions/reviews/base/objective）
├── MISSIONS.md         # 人类视图（自动生成）
├── missions/M<n>.md    # 每 mission 视图
├── comms/
│   ├── inbox/<name>.jsonl   # 每人收件箱
│   ├── findings/            # findings
│   ├── reviews/             # review 结论
│   └── log/activity.log     # 审计轨迹
└── worktrees/wt-N/          # worker git worktrees（.tower/ 已自动 .gitignore）
```

## 标准工作流

1. `tower_init` → `tower_plan`（objective + 2-4 missions，disjoint scope、deps）
2. `tower_spawn` 每个 mission **背靠背**派发（并行，不要等），派完结束回合
3. 唤醒后 `tower_status` + `tower_inbox`：review 请求→派 reviewer；finding→分诊；blocker→解答/上报；完成→查 diff
4. `tower_merge` 按依赖顺序合并（门禁自动检查）；冲突分支让 worker rebase 重审
5. 全部 merged → 立即 `tower_teardown` + 最终总结

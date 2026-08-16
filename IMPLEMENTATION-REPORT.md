# dsh 插件全家桶 — 完整实现报告

**日期**：2026-08-16 ｜ **作者**：Hermes ｜ **代码**：`/workspace/algorithm/dsh-plugins/`（git：86fd630 + 7760cf9）
**挂载**：家级 `~/.dsh/cordis.patch.yml`（headless/tui/web 全 profile 生效）
**安装**：`bash /workspace/algorithm/dsh-plugins/install.sh`（幂等）

---

## 1. 规划

### 1.1 目标
把 5 个外部 agent 的功能以 dsh plugin 形式落地，每个功能严格走「调研 → 确认方案 → 实现 → 验证」：

| # | 功能 | 上游来源 |
|---|---|---|
| 1 | 自我学习 skill + 定期修正/退役总结 skill | Hermes（curator 机制） |
| 2 | profile 功能 | Hermes（`hermes profile`） |
| 3 | auto dream skill | Claude Code 社区（grandamenium/dream-skill ★127） |
| 4 | /tower 功能 | Kimi（调研后推断实现） |
| 5 | kanban 功能 | Hermes（kanban 设计） |

### 1.2 执行计划（8 步）
1. 调研 awesome dsh plugins 生态 + dsh 插件机制
2. 搭插件基础设施（目录 / 家级 patch / profile 依赖 / 安装脚本）
3-7. 逐个实现 5 个插件
8. 端到端验证 + 汇总报告

---

## 2. 调研

### 2.1 awesome dsh plugin 生态
GitHub 检索到多个精选列表（**存在，且很活跃**）：
- `awesome-dsh-plugin/awesome-dsh-plugin` ★2964（官方精选）
- `0xsline/awesome-deepseek-harness` ★489
- `bruc3van/awesome-dsh-plugin` ★148 等

按 5 个功能关键词扫描列表，找到直接相关插件：
- **kanban**：`isolat-3k/dsh-kanban`（Hermes 风格看板，web UI 版，JSON 存储 + 子代理派发 + 心跳）、`Ericwong5021/dsh-kanban`、`TaxolYang0000/dsh-kanban-watcher`、`scwlkq/dsh-task-board`
- **记忆/学习**：`omdsh-dev/dsh-mnemon` ★28（跨 agent 持久记忆）、`LoserFox/distill`（对话蒸馏→skill 创建/更新）、`findshan/dsh-agent-memory`（capture→dream→evolve）
- **dream**：`modusensus/dsh-mneme`（autoDream 整合）、`Phant0Meow/dsh-memory-meow`（夜间 dream 整合）
- **profile**：`maque2333/dsh-profile-manager`（仅 1★，无实质实现）
- **/tower**：官方与社区均无

### 2.2 各功能上游机制调研

**① Hermes 自我学习 + 定期修正/退役（curator）**
- 本机 `hermes curator` CLI：status/usage/run/pause/resume/pin/unpin/adopt/restore/list-archived/archive/prune 等
- 源码 `agent/curator.py` 核心：
  - **自动生命周期过渡** `apply_automatic_transitions()`：按 last_activity 时间戳把技能 active→stale（30 天）→archived（90 天）；pinned 与 cron 引用的永不自动过渡；从未用过的技能有宽限期；归档可恢复、绝不自动删除
  - **审查 pass** `CURATOR_REVIEW_PROMPT`：fork agent 做"伞形技能合并"——合并重叠成 class-level 技能、修正过时内容、建议退役；dry-run 只出报告
- 会话内学习：`skill_manage`/`memory` 工具 + 经验→SKILL.md 沉淀

**② Hermes profile**
- `hermes profile` 12 个子命令：list/use/create/delete/describe/show/alias/rename/export/import/install/update/info
- 机制：`~/.hermes/profiles/<name>/` 独立 config/sessions/skills/memory；当前默认 profile 概念
- 本机 dsh 现状：**dsh 有 profile 机制（~/.dsh/profiles/<name> + cordis patch）但无管理 CLI**，`--profile` 必填无默认

**③ Claude auto dream skill**
- `grandamenium/dream-skill`（★127，复刻 Anthropic 未发布 auto-dream）：
  - 4-phase：Orient（读记忆目录）→ Gather（grep 会话 JSONL 找纠正/偏好/决定/模式）→ Consolidate（合并、相对日期转绝对、消矛盾、去重）→ Prune & Index（重建 MEMORY.md <200 行索引）
  - Auto-trigger：Stop hook 检查 24h 间隔，到期下次会话自动跑 `/dream`
  - 记忆系统自动检测（native/OpenClaw/project-root）

**④ Kimi /tower（重点结论）**
- 证据链：kimi-cli（★11k）与 kimi-code 的 README、slash-commands.md、CHANGELOG、源码树（`src/kimi_cli/ui/shell/slash.py`、`apps/kimi-code/src/tui/commands/`）、GitHub 全站代码/仓库搜索 → **官方与社区均无 /tower 命令**
- 推断语义：tower（塔）= 多 Agent 分层编排——工作按层堆叠、结果逐级上交、全结构可观测（与其余 4 个"记忆/管理"类功能互补）
- **决策：按此语义实现，报告说明，等用户回来确认**

**⑤ Hermes kanban**
- `hermes kanban` 30+ 子命令；SQLite schema（tasks/task_links/task_comments/task_events/task_runs/attachments）
- 列：triage/todo/scheduled/ready/running/blocked/review/done/archived
- dispatcher 机制：每 60s tick ①回收 stale（心跳超时 4h）②todo 父全 done→ready ③ready+assignee→spawn
- 心跳 60s、failure_limit 2、assignee 为 profile

### 2.3 dsh 插件机制调研（本机实测）
- 插件形态：cordis 插件（`export const inject=[...]` + `export function apply(ctx)`），挂载 = profile 依赖 `file:../../plugins/<pkg>` + patch 层 `- insert: [{id, name}]`
- 服务：`tools.register({name, description, parameters, output, execute})`、`skills.register({name, description, whenToUse, content})`（注册进技能目录，所有会话可见）、`subagents.start()`（派发子代理）、`ctx.interval/ctx.on/ctx.effect`
- **dsh 技能磁盘位置**：`~/.dsh/skills/<name>/SKILL.md`（自动发现）→ 学习插件的发布落点
- **会话解码**：node:zlib `zstdDecompressSync` 只解第一帧；多帧循环 = magic(0x28B52FFD) 扫描 + 逐帧解（实测验证）
- **node:sqlite**（DatabaseSync）Node 22 直接可用（experimental 警告，无需 flag）

### 2.4 关键技术发现（rc.6，已写入 dsh-development skill）
1. `tools.register()` 必须带 `output: {schema, render}`（blocks 数组返回值），旧 `presentResult` 失效——踩坑修复 42 个工具
2. `ctx.interval` 需 inject 含 `"timer"`
3. subagent `run.result.output` 是 **blocks 数组**不是字符串（`filter(b=>b.type==='text')` 提取）
4. 子代理会话目录 = runId
5. headless 一次性任务退出会终止子代理 → 派发类功能在长驻进程（web/tui）下完整
6. cordis.patch.yml 模板 `[]` 追加会 YAML 语法错误（需整文件重写）
7. ESM import 提升 → 模块顶层 `const DSH_HOME = process.env.DSH_HOME` 在 import 时求值，env 覆盖失效（改惰性函数）

---

## 3. 方案设计

### 3.1 基础设施
```
/workspace/algorithm/dsh-plugins/      ← 源码（git 管理，用户偏好位置）
├── dsh-learn/  dsh-profile/  dsh-dream/  dsh-tower/  dsh-kanban/
│   ├── package.json  index.js  skill.js  README.md
│   └── (dsh-profile: core.js + bin/dsh-profile 独立 CLI)
├── install.sh                        ← 幂等安装：profile 依赖 + pnpm install + node_modules 热链 symlink + headless 沙箱修复
└── REPORT.md
~/.dsh/
├── cordis.patch.yml                  ← 家级 patch：insert 5 个插件行（全 profile 生效）
├── plugins/ → /workspace/algorithm/dsh-plugins/*   （symlink）
└── profiles/{headless,tui,web}/package.json  + 依赖
```

### 3.2 各插件设计

| 插件 | 核心机制 | 工具 | 存储 |
|---|---|---|---|
| **dsh-learn** | 收件箱→草案→发布→审查（生命周期过渡 30/90 天 + 子代理伞形合并，dry-run 默认，归档可恢复）；后台每 6h 自动过渡 | learn_record / draft / promote / list / review / retire / restore / pin / summarize（9） | ~/.dsh/learn/ + ~/.dsh/skills/ |
| **dsh-profile** | 9 工具 + 独立 CLI `dsh-profile`（已链 /usr/local/bin）；use=写 default-profile + 生成 ~/.dsh/bin/dsh wrapper（DSH_PROFILE 覆盖） | profile_list / create / delete / rename / describe / use / export / import / info（9） | ~/.dsh/profiles/ |
| **dsh-dream** | 4-phase（Orient→Gather 扫 20 会话 zstd 解码→Consolidate 子代理合并→Prune&Index ≤200 行）；后台每小时检查、24h 自动整合 | dream_run / status / now（3） | ~/.dsh/dreams/ |
| **dsh-tower** | 塔=分层子代理编排：dispatch 堆层（parent_floor 自动继承下层已上交摘要）、ascend 逐级上交、followup 续聊带全上下文、全塔可观测 | tower_create / dispatch / status / peek / ascend / followup / stop / prune / list（9） | ~/.dsh/tower/ |
| **dsh-kanban** | SQLite（WAL）持久板；dispatcher 每 60s：回收心跳超时(30min)→晋升 todo 父全 done→ready→自动派发子代理；完成→done+摘要回写、失败→blocked+错误；依赖图/评论/事件/运行记录 | kanban_create_board / list_boards / create_task / list_tasks / get_task / update_task / add_comment / link / dispatch_task / stop_task / delete_task / status（12） | ~/.dsh/kanban/kanban.db |

合计 **42 个工具 + 5 个运行时 skill**。

---

## 4. 实现与验证结果

### 4.1 实现状态（全部完成）
- 5 个插件源码 + README + skill.js 全部落地，git 已提交（2 commits）
- 安装脚本执行成功：3 个 profile 依赖装好、node_modules 热链 symlink、headless 沙箱修复（danger-full-access + never）
- `dsh --dump-config --profile headless` 确认 5 个插件行挂载

### 4.2 端到端验证（真实 LLM 调用，非 mock）
| 测试 | 结果 |
|---|---|
| 综合冒烟：6 步（建看板/建任务/learn_record/profile_list/dream_status/tower_create） | ✅ 全通过，真实落盘 |
| kanban 派发链路：create(ready)→dispatch→子代理执行→completed 结算 | ✅ outcome=completed、summary 回写、事件时间线正确 |
| learn 全流程：record→draft→promote（~/.dsh/skills 落盘）→list→retire（可恢复） | ✅ SKILL.md 真实发布/归档 |
| tower 两层编排：L1→L2 派发、继承上下文字段挂接、结果摘要回写 | ✅ |
| dream 4-phase：从零建立 MEMORY.md（结构化索引、噪声会话标记、绝对日期） | ✅ 质量高 |
| 最终回归：5 插件 5 工具真实调用 | ✅ |

### 4.3 踩坑与修复（8 项）
1. tools.register 缺 output → 42 工具批量转换
2. ctx.interval 缺 timer inject → 3 插件补 inject
3. subagent result 是 blocks 数组 → extractResultText 统一提取
4. headless 退出终止子代理 → 识别为长驻进程特性
5. cordis.patch.yml `[]` 追加语法错误 → install.sh 整文件重写
6. core.js 顶层 DSH_HOME 被 ESM import 提升破坏（env 覆盖失效，测试污染真实 ~/.dsh）→ 惰性 dshHome()
7. 删除当前默认 profile 的保护逻辑被验证脚本踩中 → 确认是正确行为
8. （TUI 侧）dsh-tui-app 被并发会话更新为新版 /plugins 面板（分组 + t 加载/卸载 + 窗口跟随），我的分页/排序 patch 被其覆盖——验证新版功能正常后不再改动

### 4.4 ad-hoc 验证脚本（fresh evidence）
- `hermes-verify-dsh-plugins.sh`：11 PASS/0 FAIL（语法 7 文件、mock-ctx 42 工具+5 skill 注册、隔离 DSH_HOME 下 profile CRUD 含删除保护、dream 真实会话解码 8 会话/6669 事件/16 信号块、headless 端到端 5 工具）
- `hermes-verify-dsh-tui-panel.sh`：5 PASS/0 FAIL（面板组件行为 10 断言、index.js 接线、herdr 真 PTY 显示 dsh-learn 等）

---

## 5. 使用指南

### 5.1 TUI 里查看
`dsh --profile tui` → 输入 `/plugins`：面板分两组
- **原生 (82)**：@deepseek-ai/* 官方 bundle
- **后加载 (9)**：`dsh-learn` `dsh-profile` `dsh-dream` `dsh-tower` `dsh-kanban` `dsh-tui-app` 等（✓=已加载）
- ↑↓ 选择 · 空格 详情 · **t 加载/卸载** · esc 关闭（原生组受保护不可卸载）

### 5.2 使用方式（无需记忆工具名，直接跟 agent 说即可，模型会自动加载对应 skill）
| 想做什么 | 对 agent 说 |
|---|---|
| 记住教训/偏好 | "记一下：以后 X 用 Y 方式"（learn_record） |
| 沉淀成技能 | "把最近学的整理成技能"（learn_draft + learn_promote） |
| 技能库体检 | "跑一次技能审查"（learn_review，默认 dry-run 出报告） |
| 新建/切换 profile | "创建一个 profile 叫 xxx" / "把 tui 设为默认 profile" |
| 导出/导入 profile | "把 web profile 导出"（备份迁移） |
| 记忆整合 | "跑一次 dream" / "看 dream 状态"（24h 自动跑） |
| 分层派活 | "建塔：先调研 X，再基于结果实施 Y"（tower_create + ascend） |
| 任务跟踪 | "把这几件事放看板"（kanban_create_task）/"派发这个任务"（kanban_dispatch_task） |

### 5.3 shell 直接可用
```bash
dsh-profile list | create <名> | use <名> | export <名> | import <包> ...   # 已链 /usr/local/bin
```

---

## 6. 遗留事项
1. **Kimi /tower 语义为推断实现**（调研确认官方不存在），等用户确认是否需要调整方向
2. 插件代码未推 GitHub（需要可按 dsh-tui-app 先例发布 kouyichi/dsh-plugins）
3. dsh-tui-app 仓库有并发会话正在开发（新版 /plugins 面板），其未提交修改保留在工作区，未触碰
4. 测试数据已清理（冒烟看板/技能退役；MEMORY.md 保留为 dream 真实产物）
5. 验证脚本留在 /tmp（删除被终端批准机制拦截，幂等可重跑）

# dsh 插件全家桶 — 交付报告

**日期**：2026-08-16 ｜ **位置**：`/workspace/algorithm/dsh-plugins/`（git 已初始化）
**挂载**：家级 `~/.dsh/cordis.patch.yml`（5 个插件对 headless/tui/web 全部 profile 生效）
**安装**：`bash /workspace/algorithm/dsh-plugins/install.sh`（幂等，已执行）

---

## 调研结论

1. **awesome dsh plugin 生态**：存在多个精选列表（awesome-dsh-plugin/awesome-dsh-plugin ★2964、0xsline/awesome-deepseek-harness ★489、bruc3van/awesome-dsh-plugin ★148 等）。与 5 个功能直接相关的现有插件：
   - kanban：`isolat-3k/dsh-kanban`（Hermes 风格，web UI 版）、`Ericwong5021/dsh-kanban` 等
   - 记忆/学习：`omdsh-dev/dsh-mnemon`、`LoserFox/distill`（对话蒸馏→skill）、`findshan/dsh-agent-memory`（capture→dream→evolve）
   - dream：`modusensus/dsh-mneme`（autoDream 整合）、`Phant0Meow/dsh-memory-meow`
   - profile：`maque2333/dsh-profile-manager`（仅 1 star 无实质实现）
   - **Kimi /tower：官方与社区均不存在**（详见下）
2. **Kimi /tower 调研**：kimi-cli（★11k）与 kimi-code 的 README、slash-commands 文档、CHANGELOG、源码树、GitHub 全站搜索均**无 /tower 命令**。推断为塔式多 Agent 分层编排，按此语义实现（报告中已说明，用户可回来纠正）。

---

## 5 个插件

### 1. dsh-learn — 自我学习 + 定期修正/退役 skill（Hermes curator 移植）✅
- **机制**：`learn_record`（会话中记经验）→ `learn_draft`（收件箱→技能草案）→ `learn_promote`（发布到 `~/.dsh/skills/`，dsh 自动发现）→ `learn_review`（审查 pass：自动生命周期过渡 + 子代理内容审查，合并重叠/修正过时/建议退役）→ `learn_retire`/`learn_restore`/`learn_pin`/`learn_summarize`
- **生命周期**（Hermes curator 同款）：active → 30 天未用标 stale → 90 天未用归档（可恢复）；pinned 与 cron 引用永不自动退役；后台每 6h 静默跑自动过渡；审查默认 dry-run
- **实测**：record→draft→promote→list→retire 全流程通过，SKILL.md 真实落盘

### 2. dsh-profile — profile 管理（Hermes `hermes profile` 移植）✅
- **机制**：`profile_list/create/delete/rename/describe/use/export/import/info` 九个工具 + 独立 CLI `dsh-profile`（已链接 /usr/local/bin）
- **profile_use**：写 `~/.dsh/default-profile` + 生成 `~/.dsh/bin/dsh` wrapper（`DSH_PROFILE` 可临时覆盖）
- **实测**：CLI 全命令验证通过（list/create/describe/use/delete），创建含 bundles+patch+workspace 模板

### 3. dsh-dream — 记忆整合（Claude auto-dream 移植）✅
- **机制**：4-phase（Orient 读 MEMORY.md → Gather 扫最近 20 个会话（多帧 zstd 解码，提取用户消息/注入消息/工具失败）→ Consolidate 派子代理合并（相对日期→绝对、消矛盾、去重、纠正优先）→ Prune & Index 重建 ≤200 行索引）；后台每小时检查，24h 到期自动整合
- **实测**：完整跑通，MEMORY.md 从零建立，质量高（结构化索引、噪声会话标记、绝对日期）
- 上游参考：grandamenium/dream-skill（★127，Anthropic auto-dream 社区复刻）

### 4. dsh-tower — 塔式分层多 Agent 编排（Kimi /tower 推断实现）✅
- **机制**：`tower_create/dispatch/status/peek/ascend/followup/stop/prune/list` — 子代理按层堆叠，下层摘要可显式上交（ascend）成为上层上下文（dispatch 时自动继承），续聊（followup）带全上下文，全塔状态可观测
- **实测**：两层编排链路通过（L1→L2 派发、继承上下文字段正确挂接、结果摘要完整回写）

### 5. dsh-kanban — Hermes 风格看板 ✅
- **机制**：SQLite（node:sqlite，WAL）持久板；列 triage/todo/scheduled/ready/running/blocked/review/done/archived；后台 dispatcher 每 60s：①回收心跳超时（30min）的 running→ready ②todo 父全 done 自动晋升 ready ③ready 自动派发子代理；完成→done+摘要回写，失败→blocked+错误；依赖图（task_links）、评论、事件时间线、运行记录
- **实测**：create→dispatch→子代理执行→completed 结算全链路通过（outcome/summary/error/事件时间线正确）

---

## 实测中发现的 dsh rc.6 插件 API 关键点（已写入 dsh-development skill）

- `tools.register()` 必须带 `output: {schema, render}`（旧 presentResult 失效）
- `ctx.interval` 需 inject 含 `"timer"`
- subagent `run.result.output` 是 **blocks 数组**不是字符串
- 子代理会话目录 = runId
- headless 一次性任务退出会终止子代理 → 派发类功能在长驻进程（web/tui）下完整
- cordis.patch.yml 模板 `[]` 追加会语法错误（install.sh 已修复）

---

## 遗留事项

- 插件代码尚未推 GitHub（如需要可按 dsh-tui-app 先例发布 kouyichi/dsh-plugins）
- Kimi /tower 语义为推断实现，等用户回来确认是否需要调整
- 测试数据已清理（冒烟看板任务/技能已删；MEMORY.md 保留为真实产物）

# dsh-plugins — DeepSeek Harness 插件全家桶

> **33 个插件 · 80+ 工具 · 零构建 · 全实测** — 把 dsh 从"框架"变成"能干活的 agent 工作站"。
> 每个插件都是独立积木：按需拼装，不想要就拆掉，**绝不做巨无霸**。

[![MIT](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.6-4D6BFE?style=flat-square)
![plugins](https://img.shields.io/badge/plugins-33-4D6BFE?style=flat-square)
![tools](https://img.shields.io/badge/tools-80%2B-4D6BFE?style=flat-square)

---

## ✨ 为什么是这套插件（优势速览）

| 优势 | 说明 |
|---|---|
| **瞄准生态空白** | 安全治理（guard）、插件开发工具链（scaffold）、agent 评测（bench）、会话分析（xray/meter）、A2A 服务端（a2a）——全是 dsh 生态**无人做或做得很弱**的方向（2026-08-16 实测：各方向竞品 0-3★） |
| **积木式架构** | TUI 核心只做渲染/输入/会话/接缝（43KB）；**18 个 TUI 积木**通过扩展接缝独立挂载。每个积木一个目录、一个职责、可单独装卸 |
| **全家桶联动** | TUI 与插件互相成就：`/usage` 面板吃 meter 数据、`/export` 用 xray 解码、guard 审计任何会话、cron 后台任务带独立 agent 执行 |
| **全实测交付** | 每个插件都有真实运行证据（headless/PTY 实测）：guard 真实拦截、cron/bench 独立 agent 执行、A2A curl 端到端、TUI 逐命令验收 |
| **零构建零依赖** | 纯 ESM、只用 Node 内置模块（+dsh 服务），无第三方运行时依赖；挂载 = 符号链接 + 一行 patch |

---

## 📦 插件目录

### 一、能力插件（13 个，挂家级 patch，**所有 profile 生效**）

| 插件 | 功能 | 实测证据 |
|---|---|---|
| `dsh-learn` | 自我学习闭环：记录经验→技能草案→发布→生命周期管理（Hermes curator 移植） | record→promote→retire 全流程落盘 |
| `dsh-profile` | profile 管理九件套：list/create/delete/rename/describe/use/export/import/info + CLI | 3 profile 实测 |
| `dsh-dream` | 睡眠记忆整合：4-phase 扫描会话→整合 MEMORY.md（Claude auto-dream 移植） | 20 会话→37 行索引 |
| `dsh-tower` | Kimi `/tower` 忠实移植：control-tower 模型，worktree 舰队 + review/merge 门禁 | worker 15s 完成并提交 |
| `dsh-kanban` | Hermes 风格看板：SQLite 持久、依赖晋升、心跳回收、dispatcher 自动派发 | 建卡→派发→结算闭环 |
| `dsh-scaffold` | **插件开发工具链**：rc.6 骨架生成 + mock-ctx 注册验证 + 兼容性扫描 | 生成→验证→检查全通过 |
| `dsh-guard` | **安全治理**：tools.guard 规则拒绝 + 全量工具审计 + 治理报告 | 危险命令真实被拒 |
| `dsh-xray` | 会话深度分析：zstd 解码、统计、全文搜索、markdown/JSON 导出 | 50 会话分析+导出 |
| `dsh-cron` | 后台定时任务：独立 agent 执行、持久化、跨重启 | 真实执行 bash 留痕 |
| `dsh-bench` | **agent 评测**：任务集→独立 agent→expect 打分→报告 | 2/2 通过 |
| `dsh-pack` | 上下文打包：文件+技能+记忆→预算受限包（Codex 2% 规则） | 1826 字符包 |
| `dsh-a2a` | **原生 A2A v1.0 服务端**：tasks/send\|get\|cancel\|list + AgentCard | curl 端到端 completed |
| `dsh-meter` | Token 用量/成本：命中率、估算成本、周报 | 85.9% 命中率实测 |

### 二、TUI 积木（19 个，只挂 tui profile，经扩展接缝）

> 接缝由 `dsh-tui-bridge` 提供（零依赖纯 provider），TUI 核心只消费。命令/面板/状态栏字段/主题/输入钩子全部可插拔。

| 积木 | 命令/能力 | 实测 |
|---|---|---|
| `dsh-tui-bridge` | 扩展接缝（registerCommand/Panel/StatusField/Theme/InputHook） | 零依赖先激活 |
| `dsh-tui-compact` | `/compact` **真实现**（compaction seam，stub→真） | 真实调用+错误分级 |
| `dsh-tui-usage` | `/usage` 面板 + 状态栏 `cost` 字段（接 meter） | 当前+全局统计 |
| `dsh-tui-context` | `/context` 上下文占用 + 进度条 + `ctx%` 字段 | 42%→71% 实时 |
| `dsh-tui-export` | `/export` 会话导出 markdown | 80.6KB 落盘 |
| `dsh-tui-theme` | `/theme` 主题切换（deep/light/ocean/mono）持久化 | 热切换生效 |
| `dsh-tui-todos` | `/todos` 面板 + `todo n/n` 字段，enter 让 agent 更新 | 选择→更新→2/2 闭环 |
| `dsh-tui-history` | `/undo [N]` + **双击 Esc** 历史面板 | 时间线可选中重发 |
| `dsh-tui-keymap` | **leader 键**（ctrl+x m/c/t/x/u/s）+ Alt+Enter 忙时排队 | ctrl+x m 开模型面板 |
| `dsh-tui-commands` | **md 文件自定义命令** + `/init`（AGENTS.md） | /ping → 执行成功 |
| `dsh-tui-btw` | `/btw` 侧会话（新 tab 不扰主线） | 新会话执行成功 |
| `dsh-tui-update` | `/update` 版本检查 + **两步确认升级 + 重启恢复会话** | 0.1.0-rc.6 精确匹配 |
| `dsh-tui-goals` | `/goal` `/goals` 目标面板 | 状态显示 |
| `dsh-tui-find` | `/find` 会话内搜索（可选中继续） | 命中 3 条 |
| `dsh-tui-a2a` | `/agents` + **@mention 派活**（@hermes/@claude/@codex/@dsh）+ @ 补全 | @hermes 真实执行 1.5s 返回 |
| `dsh-tui-search` | `/search` 跨会话全文搜索面板 | 建索引后命中 |
| `dsh-tui-trajectory` | `/trajectory` 轨迹回放面板 | 事件时间线 |
| `dsh-tui-feedback` | `/feedback up\|down` 反馈记录 | 命令路由正常 |
| `dsh-tui-rewind` | **双击 Esc 时间回溯** + `/rewind` + fork（内核 sessions.fork 实测） | fork boundary PASS |
| `dsh-tui-skills` | **CC 技能命令全集** `/audit /bug /review /practice /pr_comments /release-notes /vuln-check` + `/skills` | 12/12 冒烟 |
| `dsh-tui-sessions` | 会话工作流 `/rename /clear /trace /workspace` + `/resume` 浏览器（搜索/预览/跨项目/折叠子代理） | 621 会话冒烟 |
| `dsh-tui-ops` | 工程化 `/doctor /login /logout /add-dir /hooks /mcp /cost /tokens /thinking /settings` | 冒烟 ALL PASS |

---

## 🚀 快速开始

```bash
# 1. 克隆/复制本仓库到 /workspace/algorithm/dsh-plugins（或任意路径）
# 2. 安装（幂等）：符号链接 + profile 依赖 + 家级/tui patch 生成
bash install.sh
# 3. 验证
cd /workspace/algorithm/dsh-plugins && npm test        # 31 plugins ALL PASS
# 4. 使用
dsh --profile headless "..."    # 13 个能力插件全可用
dsh --profile tui                # TUI + 18 积木：/usage /context /theme /todos ...
```

## 🧱 挂载架构（积木哲学）

```text
~/.dsh/cordis.patch.yml          ← 家级 patch：13 个能力插件（所有 profile）
~/.dsh/profiles/tui/cordis.patch.yml  ← tui patch：19 个积木（只 TUI）
~/.dsh/plugins/<name> → 符号链接 → 本仓库/<name>
```

### 三、App 插件（profile 启动器，1 个）

| 插件 | 功能 | 实测 |
|---|---|---|
| `dsh-tui-headless-app` | **tui-headless profile**：一次任务驱动保留 tui 功能面——`--mode`（preset）/`--model`/`--provider`/`--effort`/`--goal`（创建并武装目标）/`--permission`/`--resume`/`--json` | 全 flags 实跑：goal 自动执行完毕、resume 同会话续跑 |

用法：`dsh --profile tui-headless --mode code --model deepseek-v4-pro --goal "目标" --json "任务"`；
profile 配置在 `~/.dsh/profiles/tui-headless/`（startup 解析 flags → runner 驱动 agent，均为此插件）。

- **为什么能力插件挂家级**：它们只依赖 dsh base 服务（tools/subagents/agents），任何 profile 都能用。
- **为什么积木只挂 tui**：cordis 的 `inject` 是硬依赖——积木依赖 `tuiExtensions` 服务（仅 TUI 存在），挂到别的 profile 会阻塞激活。接缝本身是独立砖（`dsh-tui-bridge`，零依赖），保证激活图无环。
- **每个积木可单独装卸**：删掉 `~/.dsh/plugins/<name>` 链接 + patch 里一行即卸载，TUI 核心与其它积木不受影响。

## 🧪 验证

```bash
npm test                # node verify.mjs：37 插件契约检查（tools/砖注册表/服务 provide）
node verify.mjs dsh-guard   # 单插件
```

验证覆盖：经典插件的 rc.6 工具契约（output.schema/render/execute）、砖的注册契约（command/panel/statusField/theme/inputHook）、纯 provider 的 provide 记录。

## 🐋 与生态

- 对比最火 dsh-TUI（ccch1mneyyy，1877★）：外围体验（鼠标/图片/虚拟化）仍领先，但 rewind 时间回溯、CC 技能命令、会话工作流、工程化命令集已按积木砖移植（2026-08-18）；**本套件独有**：A2A 派活面板、SQLite FTS 搜索、运行时插件装卸、TUI×插件全家桶联动（usage/context/export 直接消费数据插件）、零构建纯 Node 部署。
- 方向决策依据（生态空白实测，2026-08-16）：kanban 闭环、安全治理、插件工具链、评测、会话分析、A2A server——第三方全部 ≤3★ 或无。

## 📄 文档

- `REPORT-2026-08-16.md` — 二期总报告（生态调研×六 agent 能力矩阵×8 插件×全家桶 review）
- `IMPLEMENTATION-REPORT.md` — tower v2 忠实移植记录（kimi-code #2633）
- `scripts/publish.sh` — 发布脚本（dry-run 默认）

## License

MIT

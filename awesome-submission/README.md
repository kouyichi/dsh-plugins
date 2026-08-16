# awesome-dsh-plugin 收录提交包（Ready-to-submit）

本目录是为提交 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 准备的 **32 个条目**（31 个 dsh-plugins monorepo 子包 + dsh-tui-app 独立仓库）。

## 前提（已全部满足 ✓）

- [x] 每个插件 package.json 声明 `dsh.bundle`（`{"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}`）
- [x] 每个插件仓库根有 `cordis.patch.yml`（`dsh plugin add` 可安装）
- [x] 描述中英双语、只说功能、无营销词、`: ` 已加引号（YAML 校验通过）
- [x] `dsh-plugin` topic：dsh-tui-app 已打；dsh-plugins 已打（dsh-plugin/deepseek-harness/dsh/awesome-list/agent-plugins）
- [x] 真实可用代码（31 插件共 80+ 工具，verify.mjs 31 插件 ALL PASS + 端到端实测）
- [x] 提交数 ≥ 10（dsh-plugins 20+ / dsh-tui-app 32）

## 尚未满足（时间门槛）

- [ ] **dsh-plugins 仓库年龄 ≥ 1 天**：创建于 2026-08-16T19:58Z，**2026-08-17T19:58Z 后**才能提 PR（CI 自动检查）。dsh-tui-app（08-14 创建）**已达标，现在就能提**。

## 提交步骤

1. （已完成）发布仓库：`bash scripts/publish.sh --go` —— 建 repo + 打 topic + push
2. 提 PR：fork awesome-dsh-plugin，把本目录 `*.yml` 拷到 `data/plugins/`：
   ```sh
   npm ci
   node scripts/generate-readme.mjs
   ```
   （可以一次 PR 含全部 32 个文件；README 由脚本生成）
3. 等 CI（pr-check + pr-gate：bundle 校验 / 年龄 / awesome-lint / 站点构建）
4. 维护者 review 合并 → 网站自动重建

## 条目清单（32）

### 能力插件（13，monorepo 子包）

| 文件 | 分类 | 插件 |
|---|---|---|
| kouyichi__dsh-plugins--dsh-learn.yml | skill | 自我学习 + 技能维护（curator） |
| kouyichi__dsh-plugins--dsh-profile.yml | dev | profile 管理 |
| kouyichi__dsh-plugins--dsh-dream.yml | memory | 记忆整合（auto-dream 移植） |
| kouyichi__dsh-plugins--dsh-tower.yml | workflow | 多代理指挥塔（Kimi /tower 移植） |
| kouyichi__dsh-plugins--dsh-kanban.yml | workflow | Hermes 风格看板 |
| kouyichi__dsh-plugins--dsh-scaffold.yml | dev | 插件脚手架/验证工具链 |
| kouyichi__dsh-plugins--dsh-guard.yml | tools | 安全治理 |
| kouyichi__dsh-plugins--dsh-xray.yml | session | 会话日志分析 |
| kouyichi__dsh-plugins--dsh-cron.yml | workflow | 定时任务 |
| kouyichi__dsh-plugins--dsh-bench.yml | dev | 代理基准测试 |
| kouyichi__dsh-plugins--dsh-pack.yml | tools | 上下文打包 |
| kouyichi__dsh-plugins--dsh-a2a.yml | tools | A2A 服务 |
| kouyichi__dsh-plugins--dsh-meter.yml | tools | 用量计量 |

### TUI 积木（18，monorepo 子包）

| 文件 | 分类 | 插件 |
|---|---|---|
| kouyichi__dsh-plugins--dsh-tui-bridge.yml | dev | 扩展接缝（命令/面板/字段/主题/钩子） |
| kouyichi__dsh-plugins--dsh-tui-compact.yml | ui | /compact 真实现 |
| kouyichi__dsh-plugins--dsh-tui-usage.yml | ui | /usage 面板 + cost 字段 |
| kouyichi__dsh-plugins--dsh-tui-context.yml | ui | /context 占用进度条 |
| kouyichi__dsh-plugins--dsh-tui-export.yml | ui | /export markdown |
| kouyichi__dsh-plugins--dsh-tui-theme.yml | ui | /theme 四套主题 |
| kouyichi__dsh-plugins--dsh-tui-todos.yml | ui | /todos 面板 |
| kouyichi__dsh-plugins--dsh-tui-history.yml | ui | /undo + 双击 Esc |
| kouyichi__dsh-plugins--dsh-tui-keymap.yml | ui | leader 键 + Alt 排队 |
| kouyichi__dsh-plugins--dsh-tui-commands.yml | ui | md 自定义命令 + /init |
| kouyichi__dsh-plugins--dsh-tui-btw.yml | ui | /btw 侧会话 |
| kouyichi__dsh-plugins--dsh-tui-update.yml | ui | /update 版本检查 |
| kouyichi__dsh-plugins--dsh-tui-goals.yml | ui | /goal /goals 面板 |
| kouyichi__dsh-plugins--dsh-tui-find.yml | ui | /find 会话内搜索 |
| kouyichi__dsh-plugins--dsh-tui-a2a.yml | ui | /agents + @派活 |
| kouyichi__dsh-plugins--dsh-tui-search.yml | ui | /search 全文搜索 |
| kouyichi__dsh-plugins--dsh-tui-trajectory.yml | ui | /trajectory 回放 |
| kouyichi__dsh-plugins--dsh-tui-feedback.yml | ui | /feedback 记录 |

### 独立仓库（1）

| 文件 | 分类 | 插件 |
|---|---|---|
| kouyichi__dsh-tui-app.yml | ui | 交互式终端聊天应用（已发布，可立即提 PR） |

## 推荐项（可选，未做）

- npm 发布（免 allowBuilds 一步安装）——private 已全部移除，随时可 `npm publish`
- `data/screenshots.json` 截图
- 官方 @deepseek-ai/* 包改 peerDependencies

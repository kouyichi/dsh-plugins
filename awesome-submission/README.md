# awesome-dsh-plugin 收录提交包（Ready-to-submit）

本目录是为提交 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 准备的 14 个条目（13 个 monorepo 子包 + dsh-tui-app 独立仓库）。

## 前提（已全部满足 ✓）

- [x] 每个插件 package.json 声明 `dsh.bundle`（`{"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}`）
- [x] 每个插件仓库根有 `cordis.patch.yml`（`dsh plugin add` 可安装）
- [x] 描述中英双语、只说功能、无营销词、`: ` 已加引号（YAML 校验通过）
- [x] `dsh-plugin` topic：dsh-tui-app 已打；dsh-plugins 由 publish.sh 创建时自动打
- [x] 真实可用代码（13 插件共 76 工具，全部通过 verify.mjs mock 注册验证 + 端到端实测）

## 尚未满足（时间门槛，无法加速）

- [ ] **仓库年龄 ≥ 1 天**：repo 创建后需等满 24h（CI 自动检查，防"PR 前几分钟建仓"）
- [x] **提交数 ≥ 10**：dsh-plugins 当前 14+ commits ✓

## 提交步骤（24 小时后执行）

1. 发布仓库：`bash scripts/publish.sh --go`（自动建 repo + 打 topic + push）
2. 提 PR：fork awesome-dsh-plugin，把本目录的 `*.yml` 拷到 `data/plugins/`（每个 PR 一个文件，或一次 PR 多个文件均可——README 由脚本生成）：
   ```sh
   npm ci
   node scripts/generate-readme.mjs
   ```
3. 等 CI（pr-check + pr-gate：bundle 校验 / 年龄 / awesome-lint / 站点构建）
4. 维护者 review 合并 → 网站自动重建

## 条目清单

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
| kouyichi__dsh-tui-app.yml | ui | 交互式终端聊天应用（独立 repo） |

## 推荐项（可选，未做）

- npm 发布（免 allowBuilds 一步安装）——private 已移除，随时可 `npm publish`
- `data/screenshots.json` 截图
- 官方 @deepseek-ai/* 包改 peerDependencies

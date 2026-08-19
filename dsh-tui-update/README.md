# dsh-tui-update

TUI brick: `/update` — 检测新版 → 确认 → 执行升级 → 重启 TUI 并恢复当前会话。

## 行为

| 步骤 | 实现 |
| --- | --- |
| 检测 | `/update` 时并行 `npm view @deepseek-ai/dsh` 与 `npm view dsh-tui-app`，与本地安装版本（semver 风格比较）对比；启动 2.5s 后有一次静默后台检查，仅填充状态栏 |
| 提示 | 状态栏字段 `⬆dsh <ver>`（有新版时）、`!待确认`（已确认待执行）、`⏳升级中`；`/update` 输出完整版本对比与升级计划 |
| 确认 | 两步确认：第一次 `/update` 只展示计划并武装升级；**再次输入 `/update`** 才执行（会先重查，≤60s 用缓存） |
| 升级 | `npm install -g @deepseek-ai/dsh`（仅 CLI 有新版时）+ `cd <profile 目录> && corepack pnpm install`；execFile 管道捕获输出、240s 超时、失败打印中文报错 + 手动命令，不重启 |
| 验证 | 升级后重读本地版本，未前进则中止重启并给出修复命令（防镜像 registry 未同步） |
| 重启 | spawn 一个 detached 的 `node -e` 辅助进程（延迟 ~1.2s，等本进程完全退出、终端恢复后再启动新 TUI），新进程命令：`dsh --profile <name> --resume <当前 sessionId>`（sessionId 取自 `store.meta.sessionId`）；本进程经 `ctl.exit()` 自行退出 |

## 安全措施

- 破坏性操作必须二次 `/update` 确认；agent 忙时拒绝执行并保留确认状态。
- 重启前打印完整目标命令、本进程 PID 与新进程 PID。
- **只重启自己**：不 kill 任何其它进程；detached 子进程与当前进程组隔离。
- 任何一步失败：明确中文报错 + 手动升级命令（`npm install -g @deepseek-ai/dsh`、`cd <profile> && corepack pnpm install`、`dsh --profile tui --resume <id>`），会话不受影响。
- 网络受限（公司防火墙）导致 npm 失败时同样走上述降级路径。

## 已知限制

- 当前会话尚无任何对话（未持久化）时，`--resume` 可能失败，会启动新会话（已提示）。
- 多 tab 场景只恢复当前活动 tab 的会话（`store.meta.sessionId` 跟随活动 tab）。
- dsh-tui-app 在本机为 `file:` 本地开发依赖：npm 有新版时仅提示，`pnpm install` 不会拉取 npm 发布版。
- 重启后新进程为 detached 会话，终端尺寸变化（SIGWINCH）可能不触发 Ink 重绘。
- 升级过程中 TUI 保持交互；`/update` 有重入保护。

## 手动升级（降级路径）

```sh
npm install -g @deepseek-ai/dsh
cd ~/.dsh/profiles/tui && corepack pnpm install
dsh --profile tui --resume <sessionId>
```

# dsh-kanban — Hermes 风格看板插件

把 Hermes 的 kanban（SQLite 持久任务板 + dispatcher）移植到 dsh，纯工具型（无 web UI 依赖，headless/tui/web 通吃）。

## 核心机制

- **列**：triage → todo → scheduled → ready → running → blocked → review → done (+archived)
- **依赖晋升**：todo 任务的父任务全部 done 后自动晋升 ready
- **自动派发**：ready 任务由后台 dispatcher（每 60s）派给 dsh 子代理执行；完成→done+摘要回写，失败→blocked+错误
- **心跳回收**：运行中任务 30 分钟无任何会话活动即回收回 ready（防假运行）
- **手动派发**：`kanban_dispatch_task` 立即派发（可带补充 instructions）
- **持久化**：SQLite（node:sqlite，WAL），重启不丢

## 工具

| 工具 | 作用 |
|---|---|
| `kanban_create_board` / `kanban_list_boards` | 看板 CRUD |
| `kanban_create_task` / `kanban_list_tasks` / `kanban_get_task` / `kanban_update_task` / `kanban_delete_task` | 任务 CRUD（create 支持 parent_ids 依赖） |
| `kanban_link` | 依赖管理（父完成→子晋升） |
| `kanban_dispatch_task` / `kanban_stop_task` | 派发 / 终止 |
| `kanban_add_comment` | 评论 |
| `kanban_status` | 插件状态 |

## 数据位置

`~/.dsh/kanban/kanban.db`（表：boards/tasks/task_links/task_comments/task_events/task_runs）

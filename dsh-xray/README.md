# dsh-xray — 会话数据深度分析 / 导出

生态空白：会话数据仓库（检索/统计/导出）无头部。dsh-xray 是模型侧的会话分析工具，直接解码 `~/.dsh/sessions/` 下的 zstd 多帧会话日志。

## 工具

| 工具 | 功能 |
|---|---|
| `xray_sessions` | 总览：轮次/步骤/工具分布/错误率/Token/按天 |
| `xray_session` | 单会话深挖：用户消息、助手摘要、失败明细 |
| `xray_search` | 跨会话全文搜索（用户+助手消息） |
| `xray_export` | 导出 markdown / JSON（归档、喂给其他 agent） |

## 典型用法

```
xray_sessions days=7
xray_session id=<session-xxx>
xray_search query="kanban"
xray_export id=<session-xxx> format=markdown
```

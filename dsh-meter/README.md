# dsh-meter — Token 用量 / 成本统计

Web UI 侧计费组件已内卷（20+ 重复），但**模型侧**的用量分析是空的。meter 解码会话日志，聚合 Token（未缓存输入/缓存读/输出）、缓存命中率与估算成本。

## 工具

| 工具 | 功能 |
|---|---|
| `meter_summary` | 总览：命中率/成本/按天/Top 会话 |
| `meter_session` | 单会话明细 |
| `meter_report` | 生成 markdown 报告（~/.dsh/meter/reports/） |

价格默认值为估算，可在 `~/.dsh/meter/pricing.json` 覆盖：

```json
{ "input_per_mtok": 0.5, "cache_read_per_mtok": 0.1, "output_per_mtok": 1.5 }
```

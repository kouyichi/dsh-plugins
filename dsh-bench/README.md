# dsh-bench — Agent 评测 / Benchmark

生态空白：dsh 生态无评测工具（官方 BENCHMARK.md 面向内核）。bench 用独立 agent 跑任务集，按期望关键词打分，产出对比报告——模型/preset 对照实验的标配。

## 工具

| 工具 | 功能 |
|---|---|
| `bench_run` | 跑 benchmark：tasks 数组或 task_file JSON；expect 关键词判 pass；报告写 ~/.dsh/bench/runs/ |
| `bench_list` | 历史运行 |
| `bench_report` | 查看报告 |

## 示例

```
bench_run label=回归 tasks=[{"id":"git","task":"运行 git status 并总结","expect":["分支"]}]
bench_run task_file=/tmp/tasks.json
bench_report
```

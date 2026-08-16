# dsh-pack — 上下文打包

借鉴：Codex 技能「2% 上下文预算/渐进披露」+ Claude CLAUDE.md 分层记忆 + Pi resources 机制。

把任务相关的文件 + 技能目录 + 持久记忆 + 最近会话要点，编译成**有字符预算**的 markdown 上下文包——喂给子代理/新会话不撑爆 prompt。

## 工具

| 工具 | 功能 |
|---|---|
| `pack_build` | 构建上下文包（paths 文件/目录 + 技能目录 + MEMORY.md + 最近 N 会话） |
| `pack_list` / `pack_show` | 列表 / 读取 |
| `pack_budget` | 技能目录上下文预算估算（2% 规则） |

存储：`~/.dsh/packs/<name>.md`

## 示例

```
pack_build name=项目X paths=[/workspace/algorithm/foo/src,/workspace/algorithm/foo/README.md] keywords="修复 bug"
pack_budget
```

# dsh-scaffold — 插件开发工具链

生态空白：dsh 处于 rc 快速变动期（rc.6 已 breaking），第三方只有 skill 级脚手架（≤21★），无官方 CLI scaffolder / 测试 / 兼容性工具。

## 工具

| 工具 | 功能 |
|---|---|
| `scaffold_plugin` | 生成 rc.6 规范插件骨架（package.json + index.js + verify.mjs + README.md） |
| `verify_plugin` | mock-ctx 加载插件，逐工具检查 rc.6 注册契约（output.{schema,render}/presentCall/inject） |
| `compat_check` | 扫描插件目录：ESM/package.json 规范 + rc.6 已知坑（presentResult、ctx.interval 缺 timer、register 缺 output） |

## 验证

```bash
node verify.mjs .   # 独立于 dsh 运行（mock ctx）
```

## 挂载

链接到 `~/.dsh/plugins/` + 家级 `~/.dsh/cordis.patch.yml` insert 一行（install.sh 自动处理）。

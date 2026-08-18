/**
 * dsh-tui-commands — TUI brick: commands as Markdown files + /init.
 *
 * Claude Code / OpenCode style: drop a Markdown file into
 *   ~/.dsh/tui-commands/<name>.md
 * with a frontmatter `description:` and a body that is the prompt. The
 * command becomes /<name>; $ARGUMENTS (and $1..$n) in the body are replaced
 * with the rest of the line. /init generates a starter AGENTS.md in the cwd.
 *
 * @module dsh-tui-commands
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-tui-commands";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const COMMANDS_DIR = join(DSH_HOME, "tui-commands");

const AGENTS_MD_TEMPLATE = `# AGENTS.md — dsh agent 项目指引

> 由 dsh-tui-commands 的 /init 生成。编辑此文件让 agent 了解本项目：
> 构建/测试命令、目录结构约定、必须遵守的规则。支持分层：本文件、子目录 AGENTS.md。

## 项目

（一句话说明项目做什么）

## 常用命令

- 构建：
- 测试：
- 运行：

## 约定

- （代码风格、提交规范、禁止事项等）
`;

function parseCommandFile(path) {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  const desc = m ? (m[1].match(/^description:\s*(.+)$/m)?.[1] ?? "").trim() : "";
  const body = m ? m[2].trim() : text.trim();
  return { desc, body };
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-commands] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  // Load custom commands from ~/.dsh/tui-commands/*.md
  function loadCustomCommands() {
    if (!existsSync(COMMANDS_DIR)) return;
    for (const f of readdirSync(COMMANDS_DIR)) {
      if (!f.endsWith(".md")) continue;
      const name = "/" + f.replace(/\.md$/, "").toLowerCase();
      if (ext.commands.has(name)) {
        ctx.logger.warn(`[dsh-tui-commands] 自定义命令 ${name} 与内置/已注册命令重名，已忽略（${f}）`);
        continue; // built-in or earlier wins
      }
      try {
        const { desc, body } = parseCommandFile(join(COMMANDS_DIR, f));
        disposers.push(ext.registerCommand({
          name,
          busySafe: false,
          description: desc ?? "自定义命令（~/.dsh/tui-commands/*.md）",
          handler(full, ctl) {
            const args = full.slice(name.length).trim();
            let prompt = body
              .replace(/\$ARGUMENTS/g, args)
              .replace(/\$1/g, args.split(/\s+/)[0] ?? "")
              .replace(/\$n/g, args.split(/\s+/).slice(1).join(" "));
            prompt = prompt.trim();
            if (!prompt) {
              ctl.notice("warning", `${name} 需要参数（$ARGUMENTS）`);
              return;
            }
            ctl.notice("info", `${name}: 已提交自定义命令`);
            ctl.submit(prompt);
          },
        }));
        ctx.logger.info(`[dsh-tui-commands] loaded ${name}${desc ? ` — ${desc}` : ""}`);
      } catch (err) {
        ctx.logger.warn(`[dsh-tui-commands] skip ${f}: ${err.message}`);
      }
    }
  }
  loadCustomCommands();

  disposers.push(ext.registerCommand({
    name: "/init",
    description: "生成 AGENTS.md 项目指引",
    busySafe: true,
    handler(full, ctl, store) {
      const cwd = store.meta?.cwd ?? process.cwd();
      const target = join(cwd, "AGENTS.md");
      if (existsSync(target)) {
        ctl.notice("warning", `AGENTS.md 已存在（${target}），未覆盖`);
        return;
      }
      writeFileSync(target, AGENTS_MD_TEMPLATE);
      ctl.notice("success", `已生成 ${target}（编辑它让 agent 了解项目）`);
    },
  }));

  disposers.push(ext.registerCommand({
    name: "/commands",
    busySafe: true,
    handler(full, ctl) {
      ctl.notice("info", `自定义命令目录: ${COMMANDS_DIR}\n放一个 xxx.md（frontmatter description + 正文为 prompt，支持 $ARGUMENTS）即成为 /xxx 命令。当前自定义命令: ${[...ext.commands.keys()].filter((k) => k.startsWith("/") && !["/help", "/config", "/mode", "/model", "/resume", "/sessions", "/compact", "/jobs", "/plan", "/goal", "/search", "/trajectory", "/feedback", "/agents", "/tab", "/new", "/plugins", "/quit", "/exit", "/q", "/root", "/usage", "/context", "/export", "/theme", "/todos", "/undo", "/init", "/btw", "/update", "/goals", "/find"].includes(k)).join(" ") || "（无，可加）"}`);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

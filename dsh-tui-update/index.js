/**
 * dsh-tui-update — TUI brick: /update.
 *
 * Checks npm for the latest @deepseek-ai/dsh and prints the exact upgrade
 * command. No auto-update: dsh is in a fast-breaking rc phase, upgrades are
 * a deliberate act (the dsh-TUI's /update auto-restarts; we prefer to show
 * the command and let the user decide).
 *
 * @module dsh-tui-update
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

export const name = "dsh-tui-update";
export const inject = ["tuiExtensions"];

/** Resolve the installed @deepseek-ai/dsh version (argv[1] walk-up → CLI probe). */
function installedVersion() {
  try {
    const entry = resolve(process.argv[1] || "");
    let dir = dirname(entry);
    for (let i = 0; i < 8; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        const j = JSON.parse(readFileSync(pkg, "utf8"));
        if (j.name === "@deepseek-ai/dsh" || j.name === "dsh") return j.version;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* fall through */ }
  try {
    const out = execFileSync("dsh", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return process.env.DSH_VERSION || "unknown";
}

function npmView(pkg, cb) {
  execFile("npm", ["view", pkg, "version", "--json"], { timeout: 20000 }, (err, stdout) => {
    if (err) { cb(null); return; }
    try { cb(JSON.parse(stdout.trim())); } catch { cb(null); }
  });
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-update] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/update",
    description: "检查 dsh 新版本",
    busySafe: true,
    handler(full, ctl) {
      ctl.notice("info", "正在检查 npm…");
      npmView("@deepseek-ai/dsh", (latest) => {
        if (!latest) {
          ctl.notice("error", "npm 检查失败（离线或 registry 不可达）");
          return;
        }
        const local = installedVersion();
        if (latest === local || local === "unknown") {
          ctl.notice("info", `当前 ${local} 已是最新（npm: ${latest}）`);
          return;
        }
        ctl.notice(
          "info",
          `有新版: 本地 ${local} → npm ${latest}\n升级命令（自行执行）:\n  npm install -g @deepseek-ai/dsh@${latest}\n  # 或 dsh plugin --profile tui update\n升级后重启 TUI 生效（--resume 可恢复会话）`
        );
      });
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

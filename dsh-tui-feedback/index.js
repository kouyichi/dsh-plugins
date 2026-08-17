/**
 * dsh-tui-feedback — TUI brick: /feedback (extracted from the TUI core).
 *
 * Records 👍/👎 feedback for the last assistant message into
 * ~/.dsh/feedback.json (shared surface — the web UI and future tools can
 * consume it too).
 *
 * @module dsh-tui-feedback
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-tui-feedback";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

/** 砖自带的反馈记录（内核 /feedback 不可用时的兜底实现）。 */
function brickFeedback(full, ctl, store) {
  const last = store.lastAssistantId;
  if (!last) {
    ctl.notice("warning", "还没有可反馈的助手消息");
    return;
  }
  const m = full.slice("/feedback".length).trim().match(/^(up|down|👍|👎|good|bad)(?:\s+([\s\S]*))?$/i);
  if (!m) {
    ctl.notice("warning", "用法: /feedback up|down [备注]");
    return;
  }
  const verdict = ["up", "👍", "good"].includes(m[1].toLowerCase()) ? "up" : "down";
  const path = join(DSH_HOME, "feedback.json");
  let all = [];
  try { all = JSON.parse(readFileSync(path, "utf8")); } catch { all = []; }
  all.push({ messageId: last, verdict, note: m[2] ?? "", ts: Date.now() });
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2));
    ctl.notice("info", `已记录反馈（${verdict === "up" ? "👍" : "👎"}）→ ${path}`);
  } catch (e) {
    ctl.notice("error", `反馈写入失败: ${e.message}`);
  }
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-feedback] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/feedback",
    busySafe: true,
    description: "反馈（内核 /feedback <text> 优先；up/down 记到 feedback.json 由本砖兜底）",
    handler(full, ctl, store) {
      // 内核 /feedback 命令存在时转发内核执行（记录到会话日志）——
      // 核心命令桥已优先接管，本分支只在桥缺失/命令未注册时兜底。
      const agents = ctx.get("agents");
      const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
      const dshCmds = ctx.get("commands");
      if (parent && dshCmds?.execute) {
        try {
          if (dshCmds.list?.(parent)?.some((d) => d.name === "feedback")) {
            dshCmds.execute(parent, full, AbortSignal.timeout(60000)).then((exec) => {
              ctl.notice("info", exec?.result?.text ?? "✓ 已由内核 /feedback 处理");
            }).catch((e) => {
              ctl.notice("warning", `内核 /feedback 执行失败，回退本砖实现: ${e.message}`);
              brickFeedback(full, ctl, store);
            });
            return;
          }
        } catch { /* fall through to brick */ }
      }
      brickFeedback(full, ctl, store);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

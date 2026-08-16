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
    handler(full, ctl, store) {
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
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

/**
 * dsh-tui-find — TUI brick: /find <keyword>.
 *
 * In-session search: scans the CURRENT session's event stream (captured
 * live + persisted history from session/event subscription), finds user and
 * assistant messages containing the keyword, and shows them in a selectable
 * panel. Enter on a hit re-sends that context as a question (e.g. "继续做
 * 这件事") — a lightweight jump-to-message workflow.
 *
 * @module dsh-tui-find
 */

export const name = "dsh-tui-find";
export const inject = ["tuiExtensions"];

const MAX_KEEP = 400;
const NOISE = ["<system-reminder>", "<system>", "The approval policy changed", "You are a coding agent"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-find] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  const messages = []; // {role, text}

  const onEvent = (_subject, event) => {
    let role = null;
    if (event?.type === "user/message") role = "user";
    else if (event?.type === "assistant/message") role = "assistant";
    if (!role) return;
    const texts = [];
    const walk = (v) => {
      if (v == null) return;
      if (typeof v === "string") { texts.push(v); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === "object") {
        if (typeof v.text === "string") texts.push(v.text);
        for (const k of Object.keys(v)) {
          if (k === "type" || k === "role" || k === "name") continue;
          if (k === "content" || k === "text" || k === "message" || k === "data") walk(v[k]);
        }
      }
    };
    walk(event.data);
    const t = texts.map((s) => s.trim()).filter(Boolean).find((s) => !NOISE.some((n) => s.startsWith(n)));
    if (t) {
      messages.push({ role, text: t.slice(0, 2000) });
      if (messages.length > MAX_KEEP) messages.shift();
    }
  };
  ctx.on("session/event", onEvent);
  disposers.push(() => ctx.off?.("session/event", onEvent));

  disposers.push(ext.registerCommand({
    name: "/find",
    busySafe: true,
    handler(full, ctl, store) {
      const q = full.slice("/find".length).trim().toLowerCase();
      if (!q) {
        ctl.notice("warning", "用法: /find <关键词>（当前会话内搜索）");
        return;
      }
      store.set({ findQuery: q });
      ctl.openExtPanel("find");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "find",
    title: "会话内搜索 / find",
    load(store) {
      const q = store.findQuery || "";
      if (!q) return { lines: ["（无查询）"] };
      const hits = [];
      messages.forEach((m, i) => {
        const idx = m.text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const snippet = (start > 0 ? "…" : "") + m.text.slice(start, idx + q.length + 80) + "…";
          hits.push({ i, role: m.role, snippet });
        }
      });
      if (hits.length === 0) {
        return { lines: [`「${q}」在会话中无命中（已缓存最近 ${messages.length} 条消息）`, "", "提示: /search <词> 可跨会话全文搜索"] };
      }
      const lines = [`「${q}」命中 ${hits.length} 条（enter 重发该条继续追问）`, ""];
      hits.slice(-30).forEach((h) => {
        lines.push(`${h.role === "user" ? "👤" : "🤖"} [${h.i}] ${h.snippet.replace(/\n/g, " ")}`);
      });
      return { lines };
    },
    confirm(line, ctl) {
      const m = line?.match(/^[👤🤖] \[(\d+)\]/);
      if (!m) return;
      const idx = parseInt(m[1], 10);
      const msg = messages[idx];
      if (!msg) return;
      ctl.closeExtPanel();
      ctl.notice("info", `↩ 就命中消息继续: ${msg.text.slice(0, 60)}…`);
      ctl.submit(`继续处理上面这条消息的内容（原文: ${msg.text.slice(0, 1500)}）`);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

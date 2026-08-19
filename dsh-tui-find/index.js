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

/**
 * P-01/S-19: load 与 confirm 共用的命中计算。返回按时间倒序取最近 50 条的
 * 显示列表（{i: 原始消息索引, role, snippet}）+ 总数 + 是否截断。
 * 显示层用连续序号 [1..N]，confirm 再经此映射回原始消息索引。
 */
function computeHits(store) {
  const q = store.findQuery || "";
  if (!q) return { hits: [], total: 0, truncated: false };
  const all = [];
  messages.forEach((m, i) => {
    const idx = m.text.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const raw = m.text.slice(start, idx + q.length + 80);
      // mark the query with ⟦⟧ like /search so hits are visually obvious
      const marked = raw.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "⟦$1⟧");
      const snippet = (start > 0 ? "…" : "") + marked + "…";
      all.push({ i, role: m.role, snippet });
    }
  });
  const truncated = all.length > 50;
  return { hits: all.slice(-50), total: all.length, truncated };
}

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
      // S-18: 4000 字符截断会让关键词落在截断点之后漏匹配，提到 16000（近似全文，仍防内存膨胀）
      messages.push({ role, text: t.slice(0, 16000) });
      if (messages.length > MAX_KEEP) messages.shift();
    }
  };
  ctx.on("session/event", onEvent);
  disposers.push(() => ctx.off?.("session/event", onEvent));

  disposers.push(ext.registerCommand({
    name: "/find",
    description: "当前会话内过滤查找",
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
      const { hits, total, truncated } = computeHits(store);
      if (total === 0) {
        return { lines: [`「${q}」在会话中无命中（已缓存最近 ${messages.length} 条消息）`, "", "提示: /search <词> 可跨会话全文搜索"] };
      }
      const lines = [`「${q}」命中 ${total} 条（enter 重发该条继续追问）`, ""];
      // P-01: 显示序号从 1 开始连续（显示层 idx+1，内部仍用原始消息索引定位）
      hits.forEach((h, n) => {
        lines.push(`${h.role === "user" ? "👤" : "🤖"} [${n + 1}] ${h.snippet.replace(/\n/g, " ")}`);
      });
      // S-19: 命中过多时不再静默截断，明确提示只显示最近 50 条
      if (truncated) lines.push("", "（命中较多，仅显示最近 50 条；缩小关键词可精确过滤）");
      return { lines };
    },
    confirm(line, ctl, store) {
      // `u` flag is mandatory: without it the character class [👤🤖] matches
      // one UTF-16 surrogate and the following ` \[` can never line up,
      // silently disabling Enter on every hit.
      const m = line?.match(/^[👤🤖] \[(\d+)\]/u);
      if (!m) return;
      const n = parseInt(m[1], 10) - 1; // 显示序号（1 起）→ 命中列表下标
      const { hits } = computeHits(store);
      const h = hits[n];
      if (!h) return;
      const msg = messages[h.i];
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

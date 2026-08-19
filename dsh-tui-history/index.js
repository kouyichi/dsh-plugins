/**
 * dsh-tui-history — TUI brick: /undo + double-Esc history picker.
 *
 * Keeps the most recent REAL user messages (system injections filtered the
 * same way dsh-dream does) from the session/event stream, then:
 *   - /undo [N]      — re-send the last N user messages as one prompt
 *                      (rewind-lite: the agent re-does the work)
 *   - /undo list     — open a selectable timeline panel (double-Esc too)
 *   - double-Esc     — open the same picker (Codex-style "Esc Esc")
 * Panel: ↑↓ to pick a message, enter to re-send it from that point.
 *
 * @module dsh-tui-history
 */

export const name = "dsh-tui-history";
export const inject = ["tuiExtensions"];

const MAX_HISTORY = 200; // S-31: 上限 200 条，超出 shift（原 30 条易丢历史）
const NOISE = ["<system-reminder>", "<system>", "The approval policy changed", "You are a coding agent", "Current runtime context"];

/** 本地时区 HH:MM:SS（G202：原来 toISOString 是 UTC，早 8 小时）。 */
const hhmmss = (ms) => {
  const d = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-history] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  const history = []; // {ts, text}

  const onEvent = (_subject, event) => {
    if (event?.type !== "user/message") return;
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
      history.push({ ts: Date.now(), text: t.slice(0, 4000) });
      if (history.length > MAX_HISTORY) history.shift();
    }
  };
  ctx.on("session/event", onEvent);
  disposers.push(() => ctx.off?.("session/event", onEvent));

  function resend(text, ctl) {
    ctl.notice("info", `↩ 重发: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    ctl.submit(text);
  }

  disposers.push(ext.registerCommand({
    name: "/undo",
    description: "重发上一条输入",
    busySafe: false,
    handler(full, ctl) {
      const arg = full.slice("/undo".length).trim();
      if (arg === "list") {
        ctl.openExtPanel("history");
        return;
      }
      // P-05: 非法参数不再静默当 1 —— 给出用法提示
      if (arg !== "" && !/^[1-9]\d*$/.test(arg)) {
        ctl.notice("warning", "用法: /undo [N]（N 为正整数重发条数）或 /undo list");
        return;
      }
      const n = arg === "" ? 1 : parseInt(arg, 10);
      const slice = history.slice(-n);
      if (slice.length === 0) {
        ctl.notice("warning", "还没有可重发的用户消息（仅统计真实输入，系统注入已过滤）");
        return;
      }
      resend(slice.map((h) => h.text).join("\n"), ctl);
    },
  }));

  disposers.push(ext.addInputHook({
    onDoubleEsc: ({ ctl }) => {
      // H01: rewind 优先（双击 Esc = 时间回溯）。检测到 rewind 砖注册的 /rewind
      // 命令时让位返回 false（不消费）；仅当 rewind 不可用时打开历史面板并返回
      // true（消费）。顺序无关：rewind 先跑则短路，history 先跑则让位。
      if (ext.commands.has("/rewind")) return false;
      ctl.openExtPanel("history");
      return true;
    },
  }));

  disposers.push(ext.registerPanel({
    id: "history",
    title: "历史消息 / undo",
    load() {
      if (history.length === 0) {
        return { lines: ["（还没有可用的用户消息）"] };
      }
      const lines = [];
      lines.push(`最近 ${history.length} 条用户消息（enter 重发该条）`);
      lines.push("");
      history.forEach((h, i) => {
        const when = hhmmss(h.ts); // G202: 本地时区
        lines.push(`[${String(i + 1).padStart(2, " ")}] ${when} ${h.text.replace(/\n/g, " ").slice(0, 90)}`);
      });
      lines.push("");
      lines.push("提示: /undo N 直接重发最近 N 条；/undo list 打开本面板");
      return { lines };
    },
    confirm(line, ctl) {
      // Tolerate the panel's leading spaces and padStart-ed index ("[ 1]"):
      // the strict ^\[(\d+)\] never matched, so Enter silently did nothing.
      const m = line?.match(/^\s*\[\s*(\d+)\]\s+(\d\d:\d\d:\d\d)\s+([\s\S]*)$/);
      if (!m) return;
      const idx = parseInt(m[1], 10) - 1;
      const h = history[idx];
      if (!h) return;
      ctl.closeExtPanel();
      resend(h.text, ctl);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

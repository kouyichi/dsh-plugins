/**
 * dsh-tui-trajectory — TUI brick: /trajectory (extracted from the TUI core).
 *
 * Step-through of the current session: the panel reads store.get().events
 * (the TUI's own rendered event list — the brick gets the store via the
 * panel load() contract) and renders a compact per-entry timeline. Enter on
 * a row shows its full detail inline.
 *
 * @module dsh-tui-trajectory
 */

export const name = "dsh-tui-trajectory";
export const inject = ["tuiExtensions"];

function summarize(ev) {
  switch (ev.kind) {
    case "user": return `👤 ${String(ev.text ?? "").slice(0, 80)}`;
    case "assistant": return `🤖 ${String(ev.text ?? ev.reasoning ?? "").slice(0, 80)}`;
    case "tool": return `⚙️ ${ev.name ?? "?"} ${String(ev.args ?? "").slice(0, 60)}`;
    case "tool-result": return `↩ ${ev.ok === false ? "✗" : "✓"} ${String(ev.preview ?? ev.text ?? "").slice(0, 60)}`;
    case "reasoning": return `🤔 ${String(ev.text ?? "").slice(0, 80)}`;
    case "notice": return `⚠ ${String(ev.text ?? "").slice(0, 80)}`;
    default: return `${ev.kind ?? "?"} ${String(ev.text ?? "").slice(0, 80)}`;
  }
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-trajectory] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/trajectory",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("trajectory");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "trajectory",
    title: "轨迹 / trajectory",
    load(store) {
      const events = store.events ?? [];
      if (events.length === 0) {
        return { lines: ["当前会话还没有事件。", "", "提示: 发消息后本面板显示完整轨迹（含工具调用与思考）"] };
      }
      const lines = [`当前会话 ${events.length} 条事件（enter 看详情）`, ""];
      events.slice(-40).forEach((ev, i) => {
        lines.push(`[${String(i + 1).padStart(3, " ")}] ${summarize(ev)}`);
      });
      return { lines };
    },
    confirm(line, ctl, store) {
      const m = line?.match(/^\[(\d+)\]\s+/);
      if (!m) return;
      const idx = parseInt(m[1], 10) - 1;
      const events = store.events ?? [];
      const ev = events.slice(-40)[idx];
      if (!ev) return;
      const detail = ev.text ?? ev.reasoning ?? ev.args ?? ev.preview ?? JSON.stringify(ev).slice(0, 300);
      ctl.notice("info", `事件 ${idx + 1} 详情:\n${String(detail).slice(0, 1500)}`);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

/**
 * dsh-tui-keymap — TUI brick: leader keys + busy input queue.
 *
 * OpenCode-style leader key (ctrl+x prefix):
 *   ctrl+x m  → /model      ctrl+x c → /compact   ctrl+x t → /theme
 *   ctrl+x x  → /export     ctrl+x u → /undo 1    ctrl+x s → /usage
 *   ctrl+x q  → quit        ctrl+x h → /help
 *
 * Pi-style message queue:
 *   Alt+Enter → if a turn is running, QUEUE the prompt and deliver it when
 *               idle; otherwise submit immediately.
 *   Alt+Up    → take the queued prompt back (fills the input buffer).
 *
 * @module dsh-tui-keymap
 */

export const name = "dsh-tui-keymap";
export const inject = ["tuiExtensions"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-keymap] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  let pending = null; // queued prompt while busy
  let poller = null;

  function runCommand(ctl, name) {
    const def = ext.commands.get(name);
    if (def) {
      try { def.handler(name, ctl, undefined); } catch (e) { ctl.notice("error", `${name} 失败: ${e.message}`); }
    } else if (name === "/model") {
      ctl.openModel();
    } else if (name === "/help") {
      ctl.notice("info", "leader 键位: ctrl+x m 模型 · c c·compact · t 主题 · x 导出 · u undo · s usage · q 退出 · h 帮助");
    } else if (name === "/quit") {
      ctl.exit();
    } else {
      ctl.notice("warning", `未绑定: ${name}`);
    }
  }

  disposers.push(ext.addInputHook({
    onLeader: {
      m: ({ ctl }) => runCommand(ctl, "/model"),
      c: ({ ctl }) => runCommand(ctl, "/compact"),
      t: ({ ctl }) => runCommand(ctl, "/theme"),
      x: ({ ctl }) => runCommand(ctl, "/export"),
      u: ({ ctl }) => runCommand(ctl, "/undo"),
      s: ({ ctl }) => runCommand(ctl, "/usage"),
      q: ({ ctl }) => runCommand(ctl, "/quit"),
      h: ({ ctl }) => runCommand(ctl, "/help"),
    },
    onAltEnter(text, { ctl, store }) {
      const t = String(text || "").trim();
      if (!t) return;
      if (store.get().input?.busy) {
        pending = t;
        ctl.notice("info", `已排队（空闲自动发送，Alt+Up 取回）: ${t.slice(0, 60)}`);
        if (!poller) {
          poller = setInterval(() => {
            const s = store.get();
            if (pending && !s.input?.busy) {
              const p = pending;
              pending = null;
              clearInterval(poller);
              poller = null;
              ctl.notice("info", `↩ 发送排队消息: ${p.slice(0, 60)}`);
              ctl.submit(p);
            }
          }, 500);
        }
      } else {
        ctl.notice("info", "↩ 直接发送");
        ctl.submit(t);
      }
    },
    onAltUp({ ctl, store }) {
      if (!pending) {
        ctl.notice("info", "没有排队中的消息");
        return;
      }
      const p = pending;
      pending = null;
      if (poller) { clearInterval(poller); poller = null; }
      store.set({ input: { ...store.get().input, buffer: p, cursor: p.length } });
      ctl.notice("info", "已取回排队消息到输入框");
    },
  }));

  ctx.effect(() => () => {
    if (poller) { clearInterval(poller); poller = null; }
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

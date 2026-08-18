/**
 * dsh-tui-btw — TUI brick: /btw side-session.
 *
 * "By the way" question: opens a NEW tab (fresh agent session), switches to
 * it and submits the question there — the main conversation stays untouched.
 * The tab bar keeps both; PgUp/PgDn switches back. Kimi /btw pattern.
 *
 * @module dsh-tui-btw
 */

export const name = "dsh-tui-btw";
export const inject = ["tuiExtensions"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-btw] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/btw",
    description: "开侧会话提问（不打扰主线）",
    busySafe: true,
    async handler(full, ctl) {
      const q = full.slice("/btw".length).trim();
      if (!q) {
        ctl.notice("warning", "用法: /btw <问题>（在新 tab 的侧会话提问，不打扰主线）");
        return;
      }
      try {
        const opened = await ctl.newTab();
        if (!opened) return; // busy / rejected — newTab already noticed
        // give the new tab's agent a beat to settle, then submit
        setTimeout(() => ctl.submit(q), 300);
        ctl.notice("info", `侧会话已开启: ${q.slice(0, 60)}（PgUp/PgDn 切回主线）`);
      } catch (err) {
        ctl.notice("error", `/btw 失败: ${err.message}`);
      }
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

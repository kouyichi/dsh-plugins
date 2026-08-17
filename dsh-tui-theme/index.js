/**
 * dsh-tui-theme — TUI brick: /theme.
 *
 * Theme picker over the core theme registry (deep/light built-in + any
 * brick-registered themes). /theme lists available themes; /theme <name>
 * hot-switches and persists to tui-config.json. This brick also ships two
 * extra themes (ocean, mono) to demonstrate registerTheme().
 *
 * @module dsh-tui-theme
 */

export const name = "dsh-tui-theme";
export const inject = ["tuiExtensions"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-theme] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  // Extra themes (brick-registered; core provides deep + light).
  disposers.push(ext.registerTheme({
    name: "ocean",
    codes: {
      accent: "36",
      "accent-bold": "1;36",
      success: "32",
      error: "31",
      warning: "33",
      dim: "2",
      bold: "1",
    },
  }));
  disposers.push(ext.registerTheme({
    name: "mono",
    codes: {
      accent: "1",
      "accent-bold": "1",
      success: "1",
      error: "1",
      warning: "1",
      dim: "2",
      bold: "1",
    },
  }));

  disposers.push(ext.registerCommand({
    name: "/theme",
    description: "切换主题",
    busySafe: true,
    handler(full, ctl, store) {
      const arg = full.slice("/theme".length).trim();
      if (!arg) {
        const names = ["deep", "light", ...ext.themes.keys()];
        ctl.notice("info", `可用主题: ${names.join(" / ")}（当前: ${store.theme ?? "deep"}）\n用法: /theme <名字> 切换并持久化`);
        return;
      }
      ctl.applyTheme(arg);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

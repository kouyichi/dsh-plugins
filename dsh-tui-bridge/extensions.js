/**
 * dsh-tui extension seam — the brick interface for TUI companion plugins.
 *
 * The TUI stays a small, focused core (conversation, rendering, input,
 * panels, tabs). Every additional capability (compact, usage, context,
 * export, theme, todos, history, keymap, ...) is a SEPARATE cordis plugin —
 * a "brick" — that registers itself through this service. This mirrors the
 * dsh philosophy: everything is a plugin, compose small pieces.
 *
 * A brick plugin applies like:
 *
 *   export const name = "dsh-tui-xxx";
 *   export const inject = ["tuiExtensions"];
 *   export function apply(ctx) {
 *     const ext = ctx.get("tuiExtensions");
 *     if (!ext) { ctx.logger.info("tuiExtensions absent (non-TUI profile) — no-op"); return; }
 *     ext.registerCommand({ name: "/xxx", busySafe: true, handler(full, ctl, store) { ... } });
 *     ext.registerPanel({ id: "xxx", title: "XXX", async load(store) { return { lines: [...] }; } });
 *     ext.registerStatusField({ id: "xxx", order: 50, render(store) { return "plain text"; } });
 *     ext.registerTheme({ name: "xxx", codes: { accent: "34" } });
 *     ext.addInputHook({ onLeader: { x: () => {} }, onDoubleEsc: () => {}, onAltEnter: (text) => {}, onAltUp: () => {} });
 *     ctx.effect(() => () => {});
 *   }
 *
 * Contract notes:
 *   - command name includes the leading slash ("/compact").
 *   - busySafe: true means the command may fire while a turn runs.
 *   - panel load() returns { lines: string[] } (PLAIN text, no ANSI — the
 *     generic panel renders raw rows and does not tokenize; use unicode
 *     symbols like ✓ ✗ ● instead of colors).
 *   - status field render() returns a plain string (same no-ANSI rule) —
 *     it is appended to the status bar as-is.
 *   - theme codes follow the palette roles: accent/success/error/warning/
 *     dim/bold (+ composed like "accent-bold"), values are SGR params
 *     ("38;2;R;G;B" or "34").
 *
 * @module dsh-tui-app/extensions
 */

export function createExtensions() {
  const commands = new Map();      // "/name" -> {name, busySafe, handler(full, ctl, store)}
  const panels = new Map();        // id -> {id, title, load(store) -> {lines}}
  const statusFields = new Map();  // id -> {id, order, render(store) -> string}
  const themes = new Map();        // name -> {name, codes}
  const inputHooks = {
    onLeader: new Map(),   // key char -> fn({ctl, store})
    onDoubleEsc: [],       // fn({ctl, store})
    onAltEnter: [],        // fn(text, {ctl, store})
    onAltUp: [],           // fn({ctl, store})
  };

  return {
    commands,
    panels,
    statusFields,
    themes,
    inputHooks,
    registerCommand(def) {
      if (!def?.name || typeof def.handler !== "function") throw new Error("tuiExtensions.registerCommand: name + handler required");
      commands.set(def.name, { busySafe: false, ...def });
      return () => commands.delete(def.name);
    },
    registerPanel(def) {
      if (!def?.id || typeof def.load !== "function") throw new Error("tuiExtensions.registerPanel: id + load required");
      panels.set(def.id, { title: def.id, ...def });
      return () => panels.delete(def.id);
    },
    registerStatusField(def) {
      if (!def?.id || typeof def.render !== "function") throw new Error("tuiExtensions.registerStatusField: id + render required");
      statusFields.set(def.id, { order: 100, ...def });
      return () => statusFields.delete(def.id);
    },
    registerTheme(def) {
      if (!def?.name || typeof def.codes !== "object") throw new Error("tuiExtensions.registerTheme: name + codes required");
      themes.set(def.name, def);
      return () => themes.delete(def.name);
    },
    addInputHook(hook) {
      if (!hook) return () => {};
      if (hook.onLeader && typeof hook.onLeader === "object") {
        for (const [k, fn] of Object.entries(hook.onLeader)) {
          if (typeof fn === "function") inputHooks.onLeader.set(k, fn);
        }
      }
      if (typeof hook.onDoubleEsc === "function") inputHooks.onDoubleEsc.push(hook.onDoubleEsc);
      if (typeof hook.onAltEnter === "function") inputHooks.onAltEnter.push(hook.onAltEnter);
      if (typeof hook.onAltUp === "function") inputHooks.onAltUp.push(hook.onAltUp);
      return () => {
        inputHooks.onDoubleEsc = inputHooks.onDoubleEsc.filter((f) => f !== hook.onDoubleEsc);
        inputHooks.onAltEnter = inputHooks.onAltEnter.filter((f) => f !== hook.onAltEnter);
        inputHooks.onAltUp = inputHooks.onAltUp.filter((f) => f !== hook.onAltUp);
      };
    },
  };
}

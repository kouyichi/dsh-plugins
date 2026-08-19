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
 *   - onDoubleEsc hooks: a hook returning true means "consumed" — the app's
 *     ctl.doubleEsc must stop iterating at the first hook that returns true
 *     (short-circuit loop lives in dsh-tui-app/lib/index.js). This layer
 *     normalizes/preserves the boolean and cleans up the wrapper.
 *
 * RUNTIME COPY (H03): the seam that actually runs is THIS file (the
 * dsh-tui-bridge brick — the tui profile loads package "dsh-tui-bridge",
 * which symlinks here). The sibling copy dsh-tui-app/lib/extensions.js is
 * dead code at runtime: the app's index.js consumes ctx.get("tuiExtensions")
 * (provided by this brick) and never imports its own lib/extensions.js.
 * Both files are kept in sync as ONE implementation — the only difference
 * is the palette-import mechanism (see registerTheme). Keep them identical
 * when editing.
 *
 * @module dsh-tui-app/extensions
 */

// H03: 渲染器 palette 桥接。本文件（bridge）运行时位于仓库内、经 node_modules
// symlink 挂入 profile，无法用相对路径直达 app 的 palette 模块，因此按候选顺序
// 动态加载：先试同目录 / 包名（若被复制或安装到 app 相邻位置），最后回退到本机
// profile 的绝对路径（当前运行环境）。全部失败则降级为只记录主题名、不桥接。
const PALETTE_CANDIDATES = [
  "./theme/palette.js",
  "dsh-tui-app/lib/theme/palette.js",
  "/root/.dsh/profiles/tui/plugins/dsh-tui-app/lib/theme/palette.js",
];
let palettePromise = null;

/** 懒加载 palette API；不可用时返回 null（调用方自行容错）。 */
function paletteApi() {
  if (!palettePromise) {
    palettePromise = (async () => {
      for (const spec of PALETTE_CANDIDATES) {
        try {
          const m = await import(spec);
          if (typeof m.registerTheme === "function" && typeof m.setTheme === "function" && typeof m.themeName === "function") {
            return { registerTheme: m.registerTheme, setTheme: m.setTheme, themeName: m.themeName };
          }
        } catch { /* try next candidate */ }
      }
      return null;
    })();
  }
  return palettePromise;
}

export function createExtensions(logger) {
  const commands = new Map();      // "/name" -> {name, busySafe, handler(full, ctl, store)}
  const panels = new Map();        // id -> {id, title, load(store) -> {lines}}
  const statusFields = new Map();  // id -> {id, order, render(store) -> string}
  const themes = new Map();        // name -> {name, codes}
  const modelCatalogs = [];        // async () -> [{provider, providerName, items, efforts}]
  const inputHooks = {
    onLeader: new Map(),   // key char -> fn({ctl, store})
    onDoubleEsc: [],       // fn({ctl, store}) -> true = consumed (stop iteration)
    onAltEnter: [],        // fn(text, {ctl, store})
    onAltUp: [],           // fn({ctl, store})
    onSubmit: [],          // fn(text, {ctl, store}) -> true = consumed (skip agent submit)
    onSuggest: [],         // fn(buffer) -> string[] extra completion candidates
  };
  // H01: onDoubleEsc 原函数 -> 包装函数（清理时按包装身份移除）
  const doubleEscWrappers = new Map();

  const warn = (msg) => {
    try { (logger?.warn ?? console.warn)(`[tuiExtensions] ${msg}`); } catch { /* ignore */ }
  };

  // H04: 通用注册辅助 —— 同名注册告警（不再静默覆盖）；disposer 带所有权校验
  // （仅当当前值仍是自己注册的条目才 delete，避免幽灵删除他人覆盖后的新条目）。
  const registerEntry = (map, key, entry) => {
    if (map.has(key)) warn(`"${key}" 已注册，旧条目将被覆盖`);
    map.set(key, entry);
    return () => { if (map.get(key) === entry) map.delete(key); };
  };

  return {
    commands,
    panels,
    statusFields,
    themes,
    inputHooks,
    registerCommand(def) {
      if (!def?.name || typeof def.handler !== "function") throw new Error("tuiExtensions.registerCommand: name + handler required");
      return registerEntry(commands, def.name, { busySafe: false, ...def });
    },
    registerPanel(def) {
      if (!def?.id || typeof def.load !== "function") throw new Error("tuiExtensions.registerPanel: id + load required");
      return registerEntry(panels, def.id, { title: def.id, ...def });
    },
    registerStatusField(def) {
      if (!def?.id || typeof def.render !== "function") throw new Error("tuiExtensions.registerStatusField: id + render required");
      return registerEntry(statusFields, def.id, { order: 100, ...def });
    },
    registerTheme(def) {
      if (!def?.name || typeof def.codes !== "object") throw new Error("tuiExtensions.registerTheme: name + codes required");
      if (def.name === "deep" || def.name === "light") {
        warn(`registerTheme: 不能覆盖内置主题 "${def.name}"`);
        throw new Error(`tuiExtensions.registerTheme: cannot override built-in theme "${def.name}"`);
      }
      const entry = def;
      if (themes.has(def.name)) warn(`registerTheme "${def.name}" 已注册，旧条目将被覆盖`);
      themes.set(def.name, entry);
      // Bridge into the renderer's palette so brick themes actually take
      // effect (previously the palette only knew deep/light, and switching
      // to ocean/mono recorded the choice without changing any color).
      paletteApi().then((pal) => {
        if (!pal) return;
        try {
          pal.registerTheme(def.name, def.codes);
          if (pal.themeName() === def.name) pal.setTheme(def.name);
        } catch { /* palette bridge unavailable — name is still listed */ }
      });
      return () => { if (themes.get(def.name) === entry) themes.delete(def.name); };
    },
    registerModelCatalog(fn) {
      if (typeof fn !== "function") throw new Error("tuiExtensions.registerModelCatalog: async fn required");
      modelCatalogs.push(fn);
      return () => {
        const i = modelCatalogs.indexOf(fn);
        if (i >= 0) modelCatalogs.splice(i, 1);
      };
    },
    async modelCatalog() {
      const out = [];
      for (const fn of modelCatalogs) {
        try {
          const groups = await fn();
          if (Array.isArray(groups)) out.push(...groups);
        } catch { /* a broken catalog must not break /model */ }
      }
      return out;
    },
    addInputHook(hook) {
      if (!hook) return () => {};
      const leaderKeys = [];
      if (hook.onLeader && typeof hook.onLeader === "object") {
        for (const [k, fn] of Object.entries(hook.onLeader)) {
          if (typeof fn !== "function") continue;
          if (inputHooks.onLeader.has(k)) warn(`leader 键 "ctrl+x ${k}" 已被占用，旧绑定将被覆盖`);
          inputHooks.onLeader.set(k, fn);
          leaderKeys.push(k);
        }
      }
      if (typeof hook.onDoubleEsc === "function") {
        // H01: 收集层包装 —— 保留回调的消费语义（返回 true = 已消费，短路后续
        // 钩子）。短路循环本身在 app 侧 ctl.doubleEsc（dsh-tui-app/lib/index.js），
        // 本层负责规范化返回值并提供可清理的包装身份。
        const wrapper = (args) => hook.onDoubleEsc(args) === true;
        doubleEscWrappers.set(hook.onDoubleEsc, wrapper);
        inputHooks.onDoubleEsc.push(wrapper);
      }
      if (typeof hook.onAltEnter === "function") inputHooks.onAltEnter.push(hook.onAltEnter);
      if (typeof hook.onAltUp === "function") inputHooks.onAltUp.push(hook.onAltUp);
      if (typeof hook.onSubmit === "function") inputHooks.onSubmit.push(hook.onSubmit);
      if (typeof hook.onSuggest === "function") inputHooks.onSuggest.push(hook.onSuggest);
      return () => {
        const w = doubleEscWrappers.get(hook.onDoubleEsc);
        if (w) {
          inputHooks.onDoubleEsc = inputHooks.onDoubleEsc.filter((f) => f !== w);
          doubleEscWrappers.delete(hook.onDoubleEsc);
        }
        inputHooks.onAltEnter = inputHooks.onAltEnter.filter((f) => f !== hook.onAltEnter);
        inputHooks.onAltUp = inputHooks.onAltUp.filter((f) => f !== hook.onAltUp);
        inputHooks.onSubmit = inputHooks.onSubmit.filter((f) => f !== hook.onSubmit);
        inputHooks.onSuggest = inputHooks.onSuggest.filter((f) => f !== hook.onSuggest);
        // H03: leader 绑定必须一并清理，否则已卸载砖的 ctrl+x 快捷键继续触发
        // 幽灵回调；H04: 所有权校验 —— 仅当当前绑定仍是自己注册的函数才删除。
        for (const k of leaderKeys) {
          if (inputHooks.onLeader.get(k) === hook.onLeader[k]) inputHooks.onLeader.delete(k);
        }
      };
    },
  };
}

/**
 * verify.mjs — canonical contract test for the dsh plugin family.
 *
 * Loads every plugin under this repo with a mock ctx and asserts the rc.6
 * registration contract: name/inject exports, tools.register entries carrying
 * output.{schema,render} + execute (+ optional presentCall), skills.register
 * returns a disposer, ctx.interval/effect/on are tolerated.
 *
 * Run: node verify.mjs            (all plugins)
 *      node verify.mjs dsh-dream  (one plugin)
 * Exit 0 = all clean.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL(".", import.meta.url).pathname;
const EXCLUDE = new Set([".git"]);
const only = process.argv.slice(2);

const plugins = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !EXCLUDE.has(e.name) && e.name.startsWith("dsh-"))
  .map((e) => e.name)
  .filter((p) => only.length === 0 || only.includes(p))
  .sort();

let failures = 0;

function makeMockCtx() {
  const registrations = [];
  const skills = [];
  const extRegs = { commands: [], panels: [], statusFields: [], themes: [], hooks: 0, provides: [] };
  const ctx = {
    provide(name, value) {
      extRegs.provides.push(name);
      if (name === "tuiExtensions") {
        // record the seam instead of the real object so brick registrations
        // land in extRegs and get contract-checked below
        ctx._ext = {
          commands: new Map(), panels: new Map(), statusFields: new Map(), themes: new Map(),
          inputHooks: { onLeader: new Map(), onDoubleEsc: [], onAltEnter: [], onAltUp: [] },
          registerCommand: (d) => { extRegs.commands.push(d); return () => {}; },
          registerPanel: (d) => { extRegs.panels.push(d); return () => {}; },
          registerStatusField: (d) => { extRegs.statusFields.push(d); return () => {}; },
          registerTheme: (d) => { extRegs.themes.push(d); return () => {}; },
          addInputHook: (h) => { extRegs.hooks++; return () => {}; },
        };
      }
    },
    get(service) {
      if (service === "tuiExtensions") return ctx._ext ?? null;
      if (service === "tools") {
        return { register: (d) => { registrations.push(d); return () => {}; }, guard: () => () => {} };
      }
      if (service === "skills") return { register: (s) => { skills.push(s); return () => {}; } };
      return null;
    },
    interval() { return () => {}; },
    effect() {},
    on() { return () => {}; },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, registrations, skills, extRegs };
}

for (const p of plugins) {
  const problems = [];
  const { ctx, registrations, skills, extRegs } = makeMockCtx();
  try {
    const mod = await import(pathToFileURL(join(ROOT, p, "index.js")).href);
    if (typeof mod.name !== "string" || !mod.name) problems.push("missing name export");
    if (!Array.isArray(mod.inject)) problems.push("inject must be an array");
    // bricks may inject only tuiExtensions; classic plugins must include tools;
    // a pure provider (dsh-tui-bridge) may inject nothing at all;
    // app plugins (profile startup/runner, e.g. dsh-tui-headless-app) inject
    // their own startup service (name contains "startup")
    else if (mod.inject.length > 0 && !mod.inject.includes("tuiExtensions") && !mod.inject.includes("tools") && !mod.inject.some((s) => /startup/i.test(s))) {
      problems.push("inject must include 'tools' (classic), 'tuiExtensions' (TUI brick), or be empty (pure provider)");
    }
    if (typeof mod.apply !== "function") problems.push("missing apply export");
    if (problems.length === 0) {
      try { mod.apply(ctx); } catch (err) { problems.push(`apply threw: ${err.message}`); }
    }
    for (const t of registrations) {
      if (!t.name) problems.push("tool missing name");
      if (!t.output?.schema) problems.push(`tool ${t.name}: missing output.schema (rc.6 requirement)`);
      if (typeof t.output?.render !== "function") problems.push(`tool ${t.name}: output.render must be a function`);
      if (typeof t.execute !== "function") problems.push(`tool ${t.name}: missing execute`);
      if (t.presentCall !== undefined && typeof t.presentCall !== "function") problems.push(`tool ${t.name}: presentCall must be a function`);
    }
    // brick contract: command/panel/statusField/theme registrations must satisfy the seam
    for (const c of extRegs.commands) {
      if (!c.name || typeof c.handler !== "function") problems.push(`brick command: name+handler required (${c.name ?? "?"})`);
    }
    for (const pn of extRegs.panels) {
      if (!pn.id || typeof pn.load !== "function") problems.push(`brick panel ${pn.id ?? "?"}: id+load required`);
    }
    for (const f of extRegs.statusFields) {
      if (!f.id || typeof f.render !== "function") problems.push(`brick statusField ${f.id ?? "?"}: id+render required`);
    }
    for (const t of extRegs.themes) {
      if (!t.name || typeof t.codes !== "object") problems.push(`brick theme ${t.name ?? "?"}: name+codes required`);
    }
  } catch (err) {
    problems.push(`import failed: ${err.message}`);
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${p}: ${registrations.length} tools, ${skills.length} skills${ok ? "" : " | " + problems.join("; ")}`);
}

console.log(failures === 0 ? `\nverify: ${plugins.length} plugins, ALL PASS` : `\nverify: ${failures}/${plugins.length} plugins FAILED`);
process.exit(failures === 0 ? 0 : 1);

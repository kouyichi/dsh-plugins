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
  const ctx = {
    get(service) {
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
  return { ctx, registrations, skills };
}

for (const p of plugins) {
  const problems = [];
  const { ctx, registrations, skills } = makeMockCtx();
  try {
    const mod = await import(pathToFileURL(join(ROOT, p, "index.js")).href);
    if (typeof mod.name !== "string" || !mod.name) problems.push("missing name export");
    if (!Array.isArray(mod.inject) || !mod.inject.includes("tools")) problems.push("inject must include 'tools'");
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
  } catch (err) {
    problems.push(`import failed: ${err.message}`);
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${p}: ${registrations.length} tools, ${skills.length} skills${ok ? "" : " | " + problems.join("; ")}`);
}

console.log(failures === 0 ? `\nverify: ${plugins.length} plugins, ALL PASS` : `\nverify: ${failures}/${plugins.length} plugins FAILED`);
process.exit(failures === 0 ? 0 : 1);

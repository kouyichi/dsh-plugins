/**
 * dsh-tower — tiered multi-agent orchestration ("tower") for DeepSeek Harness.
 *
 * Design note: Kimi's CLI family (kimi-cli, kimi-code) has NO public "/tower"
 * command as of 2026-08 — verified against READMEs, slash-command docs,
 * changelogs, source trees and GitHub-wide search. This plugin implements the
 * most reasonable interpretation of "/tower": a TOWER of agent layers, i.e.
 * hierarchical multi-agent orchestration where work is stacked floor by
 * floor, results flow upward, and the whole structure is observable.
 *
 * Concepts:
 *   Tower  — a named hierarchical workspace of agent layers.
 *   Floor  — one layer = one subagent run (or a queued/completed one).
 *   ascend — results of a floor are summarized and injected into the prompt
 *            of the next floor above it (context flows up the tower).
 *   followup — a new floor stacked on top of an existing one, seeded with
 *            its parent's context (fork semantics).
 *
 * Tools:
 *   tower_create      — create a tower (optionally with a first floor)
 *   tower_dispatch    — dispatch a task as a new floor (parent tower/floors)
 *   tower_status      — render the tower tree with live run states
 *   tower_peek        — read one floor's latest result/summary/error
 *   tower_ascend      — summarize a floor's result into its parent floor's
 *                       context (explicit context hand-off up the tower)
 *   tower_followup    — stack a new floor on top of an existing floor,
 *                       seeded with that floor's context
 *   tower_prune       — remove completed floors (keep tower lean)
 *   tower_list        — list all towers
 *
 * Storage: ~/.dsh/tower/towers.json
 *
 * @module dsh-tower
 */

import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-tower";
export const inject = ["tools", "skills", "subagents", "agents"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const TOWER_DIR = join(DSH_HOME, "tower");
const STORE_FILE = join(TOWER_DIR, "towers.json");

const FLOOR_STATUSES = ["queued", "running", "done", "error", "stopped"];

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

function ensureDirs() { mkdirSync(TOWER_DIR, { recursive: true }); }

function loadStore() {
  ensureDirs();
  try { return JSON.parse(readFileSync(STORE_FILE, "utf8")); } catch { return { towers: [] }; }
}

function saveStore(store) {
  ensureDirs();
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function findTower(store, towerId) {
  const t = store.towers.find((x) => x.id === towerId || x.name === towerId);
  if (!t) throw new Error(`塔不存在: ${towerId}（tower_list 可查）`);
  return t;
}

function findFloor(tower, floorId) {
  const f = tower.floors.find((x) => x.id === floorId);
  if (!f) throw new Error(`层不存在: ${floorId}（tower_status 可查）`);
  return f;
}

function shortId(id) { return String(id || "").replace(/^t_/, "").slice(0, 8); }
function now() { return Date.now(); }
function fmtTs(ts) { return ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—"; }
function cap(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }

/* ------------------------------------------------------------------ */
/* subagent plumbing                                                   */
/* ------------------------------------------------------------------ */

async function pickProvider(subagents) {
  let providerName = null;
  try {
    const names = subagents.list ? subagents.list() : [];
    for (const p of ["spawn", "spawn-in-process", "fork", "fork-in-process"]) {
      if (names.includes(p)) { providerName = p; break; }
    }
    if (!providerName && names.length > 0) providerName = names[0];
  } catch { providerName = null; }
  if (!providerName) throw new Error("没有可用的 subagent provider");
  return providerName;
}

function pickParent(agents) {
  const initiator = (agents && typeof agents.currentInitiator === "function" ? agents.currentInitiator() : undefined);
  const roots = (agents && typeof agents.roots === "function" ? agents.roots() : []);
  return initiator || roots[0];
}

/**
 * Build the prompt for a floor. When the floor has a parent floor, inject the
 * parent's accumulated context (the "ascended" summary chain).
 */
function buildFloorPrompt({ title, task, context, inherited }) {
  const lines = [];
  lines.push(`你是一层「塔」中的执行代理（dsh tower floor）。`);
  lines.push(`本层标题：${title}`);
  if (inherited) {
    lines.push("");
    lines.push(`## 下层上交的上下文（已汇总）`);
    lines.push(inherited);
  }
  if (task) {
    lines.push("");
    lines.push(`## 本层任务`);
    lines.push(task);
  }
  if (context) {
    lines.push("");
    lines.push(`## 补充上下文`);
    lines.push(context);
  }
  lines.push("");
  lines.push("完成后用一句话给出可被上层使用的摘要（不要引用你无法确认的文件路径）。");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const subagents = ctx.get("subagents");
  const agents = ctx.get("agents");
  const disposers = [];
  /** live floors: floorId -> {signal, run} */
  const live = new Map();

  async function startFloor(tower, floor, prompt) {
    if (!subagents || !agents) throw new Error("当前 DSH 没有挂载 subagents/agents 服务");
    const parent = pickParent(agents);
    if (!parent) throw new Error("没有存活的代理会话可用于派发（请先在对话中开启一个会话）");
    const provider = await pickProvider(subagents);
    const signal = new AbortController();
    const run = await subagents.start(provider, {
      label: "tower[" + tower.name + "]: " + cap(floor.title, 60),
      prompt: [{ type: "text", text: prompt }],
      parent,
      signal: signal.signal,
    });
    live.set(floor.id, { signal, run });
    floor.status = "running";
    floor.runId = String(run.id);
    floor.started_at = now();
    floor.provider = provider;
    run.result.then((res) => settle(tower.id, floor.id, res)).catch((err) => settleErr(tower.id, floor.id, err));
    return floor;
  }

  /** Flatten a subagent result (blocks array / string / object) to text. */
  function extractResultText(result) {
    if (!result) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result.output)) {
      const text = result.output.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
      if (text) return text;
    }
    if (typeof result.output === "string" && result.output) return result.output;
    if (typeof result.result === "string" && result.result) return result.result;
    if (typeof result.summary === "string" && result.summary) return result.summary;
    return "";
  }

  function settle(towerId, floorId, result) {
    const store = loadStore();
    try {
      const tower = findTower(store, towerId);
      const floor = findFloor(tower, floorId);
      const output = extractResultText(result);
      floor.status = "done";
      floor.ended_at = now();
      floor.result = output ? cap(output, 8000) : "（子代理已完成，未产生文本输出）";
      floor.summary = cap(floor.result, 2000);
      floor.error = null;
      live.delete(floorId);
      saveStore(store);
    } catch (err) { ctx.logger.warn(`[dsh-tower] settle failed: ${err.message}`); }
  }

  function settleErr(towerId, floorId, err) {
    const store = loadStore();
    try {
      const tower = findTower(store, towerId);
      const floor = findFloor(tower, floorId);
      floor.status = "error";
      floor.ended_at = now();
      floor.error = String(err?.message || err).slice(0, 2000);
      live.delete(floorId);
      saveStore(store);
    } catch (e) { ctx.logger.warn(`[dsh-tower] settleErr failed: ${e.message}`); }
  }

  function stopFloor(towerId, floorId) {
    const store = loadStore();
    const tower = findTower(store, towerId);
    const floor = findFloor(tower, floorId);
    const entry = live.get(floorId);
    if (entry) {
      try { entry.signal.abort(); } catch { /* ignore */ }
      live.delete(floorId);
    }
    if (floor.status === "running") {
      floor.status = "stopped";
      floor.ended_at = now();
      saveStore(store);
    }
    return floor;
  }

  function renderTower(tower, opts) {
    const lines = [];
    lines.push(`塔 ${tower.name}（id=${tower.id}，${tower.floors.length} 层${tower.description ? "，" + tower.description : ""}）`);
    lines.push(`创建于 ${fmtTs(tower.created_at)}${tower.updated_at ? "；最近活动 " + fmtTs(tower.updated_at) : ""}`);
    lines.push("");
    for (const f of tower.floors) {
      const mark = f.status === "running" ? "▶" : f.status === "done" ? "✓" : f.status === "error" ? "✗" : f.status === "stopped" ? "■" : "·";
      lines.push(`${mark} L${f.floor} ${cap(f.title, 50)} [${f.status}]${f.runId ? " run=" + shortId(f.runId) : ""}`);
      lines.push(`   派发 ${fmtTs(f.started_at)}${f.ended_at ? " → 结束 " + fmtTs(f.ended_at) : ""}`);
      if (opts?.full && f.summary) lines.push(`   摘要: ${cap(f.summary, 200)}`);
      if (opts?.full && f.error) lines.push(`   错误: ${cap(f.error, 200)}`);
    }
    return lines.join("\n");
  }

  /* -------- tower_create -------- */
  tools.register({
    name: "tower_create",
    description: "创建一座「塔」（分层多 Agent 编排空间）。可选直接派发第一层任务（task）。tower 把多个子代理组织成层级：下层结果可汇总上交给上层（tower_ascend），可观测、可追踪。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "塔名（必填，简短描述性）" },
        description: { type: "string", description: "可选：塔的用途说明" },
        task: { type: "string", description: "可选：第一层任务（立即派发）" },
      },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = String(args.name || "").trim();
      if (!name) throw new Error("name 不能为空");
      const store = loadStore();
      const tower = {
        id: "t_" + randomUUID().slice(0, 8),
        name,
        description: String(args.description || ""),
        created_at: now(),
        updated_at: now(),
        floors: [],
      };
      store.towers.push(tower);
      saveStore(store);
      let extra = "";
      if (args.task) {
        const floor = { id: "f_" + randomUUID().slice(0, 8), floor: 1, title: "L1 " + cap(args.task, 40), task: String(args.task), status: "queued", created_at: now() };
        tower.floors.push(floor);
        saveStore(store);
        await startFloor(tower, floor, buildFloorPrompt({ title: floor.title, task: floor.task }));
        extra = `，已派发第 1 层（${floor.id}）`;
      }
      return `已创建塔 ${name}（id=${tower.id}）${extra}。\n\n用 tower_status tower=${tower.id} 查看；tower_dispatch 继续堆层；tower_ascend 汇总下层结果交给上层。`;
    },
    presentCall: (args) => present("塔：创建", args?.name || ""),

  });

  /* -------- tower_dispatch -------- */
  tools.register({
    name: "tower_dispatch",
    description: "往塔上堆一层新任务（派生子代理执行）。parent_floor 指定「下层」（该层的结果摘要可作为本层上下文，先 tower_ascend 汇总再派发效果最佳）；不指定则堆在塔顶。返回层 id。",
    parameters: {
      type: "object",
      properties: {
        tower: { type: "string", description: "塔 id 或名字" },
        task: { type: "string", description: "本层任务描述（必填）" },
        parent_floor: { type: "string", description: "可选：下层层 id（本层会带上该层已汇总的上下文）" },
        context: { type: "string", description: "可选：额外上下文" },
        title: { type: "string", description: "可选：本层标题（默认截取任务前 40 字）" },
      },
      required: ["tower", "task"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const store = loadStore();
      const tower = findTower(store, String(args.tower));
      let inherited = "";
      if (args.parent_floor) {
        const pf = findFloor(tower, String(args.parent_floor));
        if (pf.summary) inherited = `（下层 ${pf.id}「${cap(pf.title, 30)}」的摘要）\n${pf.summary}`;
      }
      const floorNo = tower.floors.length + 1;
      const title = String(args.title || "").trim() || `L${floorNo} ${cap(String(args.task), 40)}`;
      const floor = {
        id: "f_" + randomUUID().slice(0, 8),
        floor: floorNo,
        title,
        task: String(args.task),
        context: String(args.context || ""),
        parent_floor: args.parent_floor || null,
        inherited,
        status: "queued",
        created_at: now(),
      };
      tower.floors.push(floor);
      tower.updated_at = now();
      saveStore(store);
      await startFloor(tower, floor, buildFloorPrompt({ title, task: floor.task, context: floor.context, inherited }));
      return `已往塔 ${tower.name} 堆上第 ${floorNo} 层（id=${floor.id}）并派发。用 tower_status tower=${tower.id} 跟踪。`;
    },
    presentCall: (args) => present("塔：堆层", `${args?.tower || ""} L${args?.task ? cap(args.task, 30) : ""}`),

  });

  /* -------- tower_status -------- */
  tools.register({
    name: "tower_status",
    description: "查看塔的结构与各层状态（queued/running/done/error/stopped + runId + 时间）。full=true 附带每层摘要/错误。",
    parameters: {
      type: "object",
      properties: {
        tower: { type: "string", description: "塔 id 或名字；省略则列出全部塔" },
        full: { type: "boolean", description: "是否显示每层摘要与错误（默认 false）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const store = loadStore();
      if (store.towers.length === 0) return "还没有塔。用 tower_create 创建第一座。";
      if (!args.tower) {
        const lines = store.towers.map((t) => {
          const done = t.floors.filter((f) => f.status === "done").length;
          const running = t.floors.filter((f) => f.status === "running").length;
          const err = t.floors.filter((f) => f.status === "error").length;
          return `- ${t.name}（id=${t.id}）：${t.floors.length} 层，运行 ${running} / 完成 ${done} / 出错 ${err}${t.description ? "，" + t.description : ""}`;
        });
        return `塔列表（${store.towers.length}）：\n${lines.join("\n")}`;
      }
      const tower = findTower(store, String(args.tower));
      return renderTower(tower, { full: args.full });
    },
    presentCall: (args) => present("塔：状态", args?.tower || "全部"),

  });

  /* -------- tower_peek -------- */
  tools.register({
    name: "tower_peek",
    description: "查看塔中某一层的详细信息：任务、状态、摘要、结果（截断）、错误、时间线。",
    parameters: {
      type: "object",
      properties: { tower: { type: "string", description: "塔 id 或名字" }, floor: { type: "string", description: "层 id" } },
      required: ["tower", "floor"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const store = loadStore();
      const tower = findTower(store, String(args.tower));
      const f = findFloor(tower, String(args.floor));
      const lines = [];
      lines.push(`层 ${f.id}（L${f.floor}）「${f.title}」`);
      lines.push(`状态: ${f.status}${f.provider ? "（" + f.provider + "）" : ""}`);
      lines.push(`时间: 派发 ${fmtTs(f.started_at)}${f.ended_at ? " → 结束 " + fmtTs(f.ended_at) : ""}`);
      if (f.parent_floor) lines.push(`下层: ${f.parent_floor}`);
      lines.push(`任务: ${f.task}`);
      if (f.inherited) lines.push(`继承上下文: ${cap(f.inherited, 300)}`);
      if (f.summary) lines.push(`摘要: ${f.summary}`);
      if (f.result) lines.push(`结果: ${cap(f.result, 3000)}`);
      if (f.error) lines.push(`错误: ${f.error}`);
      return lines.join("\n");
    },
    presentCall: (args) => present("塔：查看层", `${args?.floor || ""}`),

  });

  /* -------- tower_ascend -------- */
  tools.register({
    name: "tower_ascend",
    description: "把某层的执行摘要「上交」给它的父层（parent_floor 或塔顶下一层）——把该层的结果摘要写入父层上下文字段，父层后续派发（tower_followup）会自动带上。用于分层任务中的逐级汇总。",
    parameters: {
      type: "object",
      properties: {
        tower: { type: "string", description: "塔 id 或名字" },
        floor: { type: "string", description: "层 id（其结果要上交）" },
        summary: { type: "string", description: "可选：手动提供的摘要（默认用该层的自动摘要/结果）" },
      },
      required: ["tower", "floor"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const store = loadStore();
      const tower = findTower(store, String(args.tower));
      const f = findFloor(tower, String(args.floor));
      const summary = String(args.summary || "").trim() || f.summary || f.result || "（该层无结果可上交）";
      const targetId = f.parent_floor || (f.floor > 1 ? tower.floors.find((x) => x.floor === f.floor - 1)?.id : null);
      if (targetId) {
        const target = findFloor(tower, targetId);
        target.inherited = `（下层 ${f.id}「${cap(f.title, 30)}」上交于 ${fmtTs(now())}）\n${summary}`;
        tower.updated_at = now();
        saveStore(store);
        return `已把层 ${f.id} 的摘要上交到层 ${target.id}（下次 tower_followup ${target.id} 时自动携带）。`;
      }
      tower.updated_at = now();
      saveStore(store);
      return `层 ${f.id} 没有上层（它是塔顶）。摘要：${cap(summary, 200)}`;
    },
    presentCall: (args) => present("塔：汇总上交", `${args?.floor || ""}`),

  });

  /* -------- tower_followup -------- */
  tools.register({
    name: "tower_followup",
    description: "在现有层之上叠加一层后续任务：新层自动继承该层的上下文与已上交摘要（相当于「续聊」）。用于对某层结果做追问/修正/扩展。",
    parameters: {
      type: "object",
      properties: {
        tower: { type: "string", description: "塔 id 或名字" },
        floor: { type: "string", description: "要续聊的层 id" },
        task: { type: "string", description: "后续任务（必填）" },
      },
      required: ["tower", "floor", "task"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const store = loadStore();
      const tower = findTower(store, String(args.tower));
      const base = findFloor(tower, String(args.floor));
      const floorNo = tower.floors.length + 1;
      const inheritedParts = [];
      if (base.summary) inheritedParts.push(`（下层 ${base.id}「${cap(base.title, 30)}」的摘要）\n${base.summary}`);
      if (base.inherited) inheritedParts.push(base.inherited);
      const floor = {
        id: "f_" + randomUUID().slice(0, 8),
        floor: floorNo,
        title: `续聊 L${floorNo}: ${cap(String(args.task), 40)}`,
        task: String(args.task),
        parent_floor: base.id,
        inherited: inheritedParts.join("\n\n"),
        status: "queued",
        created_at: now(),
      };
      tower.floors.push(floor);
      tower.updated_at = now();
      saveStore(store);
      await startFloor(tower, floor, buildFloorPrompt({ title: floor.title, task: floor.task, inherited: floor.inherited }));
      return `已在层 ${base.id} 之上叠加续聊层 ${floor.id} 并派发（自动携带下层上下文）。`;
    },
    presentCall: (args) => present("塔：续聊", `${args?.floor || ""}`),

  });

  /* -------- tower_stop / tower_prune / tower_list -------- */
  tools.register({
    name: "tower_stop",
    description: "终止塔中某层的运行（仅 running 有效），状态转 stopped。",
    parameters: {
      type: "object",
      properties: { tower: { type: "string", description: "塔 id 或名字" }, floor: { type: "string", description: "层 id" } },
      required: ["tower", "floor"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const f = stopFloor(String(args.tower), String(args.floor));
      return `已终止层 ${f.id}（状态 stopped）。`;
    },
    presentCall: (args) => present("塔：终止层", args?.floor || ""),

  });

  tools.register({
    name: "tower_prune",
    description: "清理塔中已完成/出错/终止的层（保留 running/queued）。tower 保持精简。",
    parameters: {
      type: "object",
      properties: { tower: { type: "string", description: "塔 id 或名字" }, keep: { type: "number", description: "可选：保留最近 N 层（默认全清已完成）" } },
      required: ["tower"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const store = loadStore();
      const tower = findTower(store, String(args.tower));
      const keep = Number(args.keep) || 0;
      const before = tower.floors.length;
      const finished = tower.floors.filter((f) => f.status !== "running" && f.status !== "queued");
      const running = tower.floors.filter((f) => f.status === "running" || f.status === "queued");
      let removed = 0;
      if (keep > 0) {
        const recent = finished.slice(-keep);
        tower.floors = [...running, ...recent];
        removed = before - tower.floors.length;
      } else {
        tower.floors = running;
        removed = finished.length;
      }
      tower.updated_at = now();
      saveStore(store);
      return `已清理塔 ${tower.name}：移除 ${removed} 层（剩 ${tower.floors.length} 层，含 ${running.length} 层运行中）。`;
    },
    presentCall: (args) => present("塔：清理", args?.tower || ""),

  });

  tools.register({
    name: "tower_list",
    description: "列出所有塔及其层数、运行状态概览。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const store = loadStore();
      if (store.towers.length === 0) return "还没有塔。用 tower_create 创建第一座。";
      const lines = store.towers.map((t) => {
        const running = t.floors.filter((f) => f.status === "running").length;
        const done = t.floors.filter((f) => f.status === "done").length;
        const err = t.floors.filter((f) => f.status === "error").length;
        return `- ${t.name}（id=${t.id}）：${t.floors.length} 层，运行 ${running} / 完成 ${done} / 出错 ${err}${t.description ? "，" + t.description : ""}`;
      });
      return `塔列表（${store.towers.length}）：\n${lines.join("\n")}`;
    },
    presentCall: () => present("塔：列表", "tower_list"),

  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "tower",
      description: "塔式分层多 Agent 编排：把子代理任务堆成可观测的层级结构，结果逐级上交（Kimi /tower 风格）。",
      whenToUse: "当任务需要多步接力/分层执行、多个子代理之间有先后依赖、或用户提到 tower/塔/分层时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "tower 把多个子代理任务组织成「塔」：每层一个子代理运行，下层结果可汇总上交（tower_ascend）成为上层上下文，支持续聊（tower_followup）与全塔状态观测。适合：长流程接力、先调研后实施、多步依赖任务。",
        "",
        "## 工具速览",
        "",
        "- `tower_create`：建塔（可带第一层任务）",
        "- `tower_dispatch`：堆新层（parent_floor 指定下层，自动继承其摘要）",
        "- `tower_status` / `tower_peek`：状态树 / 单层详情",
        "- `tower_ascend`：把下层摘要上交为上层上下文",
        "- `tower_followup`：在指定层上续聊（自动带上下文）",
        "- `tower_stop` / `tower_prune` / `tower_list`：终止 / 清理 / 列表",
        "",
        "## 工作流示例",
        "",
        "1. `tower_create name=调研-实施 task=\"调研 X 技术选型\"`",
        "2. 第 1 层完成后 `tower_ascend tower=… floor=…` 上交摘要",
        "3. `tower_dispatch tower=… task=\"基于调研结果实施\" parent_floor=<第1层id>`",
        "4. `tower_status full=true` 总览，`tower_peek` 看细节",
        "",
        "## 注意",
        "",
        "- 层与层之间默认隔离；上下文传递必须显式 ascend/followup（这是特性：防止上下文污染）",
        "- 塔数据存 ~/.dsh/tower/towers.json，重启不丢",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    for (const [, entry] of live) { try { entry.signal.abort(); } catch { /* ignore */ } }
  });
}

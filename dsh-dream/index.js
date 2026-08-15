/**
 * dsh-dream — memory consolidation for DeepSeek Harness.
 *
 * Port of Claude Code's "auto-dream" skill (grandamenium/dream-skill):
 * a 4-phase consolidation pass over accumulated memory, run while you sleep.
 *
 *   Phase 1 Orient     — read the current MEMORY.md + skill inventory
 *   Phase 2 Gather     — scan recent session logs (zstd) for corrections,
 *                        preference changes, decisions, recurring patterns
 *   Phase 3 Consolidate— merge new findings into MEMORY.md; relative dates
 *                        become absolute; contradictions resolved; no dups
 *   Phase 4 Prune&Index— rebuild MEMORY.md as a lean index (< 200 lines)
 *
 * Auto-trigger: a background tick checks every hour whether 24h have passed
 * since the last dream; when due it runs a consolidation pass via a forked
 * subagent (no user needed).
 *
 * Storage:
 *   ~/.dsh/dreams/MEMORY.md     — consolidated memory (the deliverable)
 *   ~/.dsh/dreams/state.json    — last_dream_at, pass history
 *   ~/.dsh/dreams/signals/      — raw gathered signals per pass
 *
 * @module dsh-dream
 */

import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-dream";
export const inject = ["tools", "skills", "subagents", "agents", "timer"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const DREAMS_DIR = join(DSH_HOME, "dreams");
const MEMORY_FILE = join(DREAMS_DIR, "MEMORY.md");
const STATE_FILE = join(DREAMS_DIR, "state.json");
const SIGNALS_DIR = join(DREAMS_DIR, "signals");
const SESSIONS_DIR = join(DSH_HOME, "sessions");

const DREAM_INTERVAL_MS = 24 * 3600 * 1000;   // dream at most once per 24h
const CHECK_INTERVAL_MS = 3600 * 1000;        // background check tick
const GATHER_SESSION_LIMIT = 20;              // most recent sessions to scan
const SIGNAL_CHAR_BUDGET = 60000;             // cap raw signal payload
const MAX_MEMORY_LINES = 300;                 // sanity cap for the rebuilt file

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  for (const d of [DREAMS_DIR, SIGNALS_DIR]) mkdirSync(d, { recursive: true });
}

function loadState() {
  ensureDirs();
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { last_dream_at: null, passes: [] }; }
}

function saveState(state) {
  ensureDirs();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readMemory() {
  ensureDirs();
  try { return readFileSync(MEMORY_FILE, "utf8"); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* session log scanning (multi-frame zstd decode)                     */
/* ------------------------------------------------------------------ */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode a multi-frame zstd session log (each flush appends a frame). */
export function decodeSessionLog(buf) {
  const chunks = [];
  let remaining = buf;
  let guard = 0;
  while (remaining.length > 0 && guard++ < 4096) {
    try {
      const out = zstdDecompressSync(remaining);
      chunks.push(out);
    } catch {
      break; // trailing garbage / partial frame
    }
    // Find the next frame start (magic after the current frame).
    const idx = remaining.indexOf(ZSTD_MAGIC, 1);
    if (idx < 0) break;
    remaining = remaining.subarray(idx);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** List session log paths, newest first. */
export function listSessionLogs(limit) {
  const out = [];
  if (!existsSync(SESSIONS_DIR)) return out;
  for (const ws of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(SESSIONS_DIR, ws.name);
    let sessions;
    try { sessions = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory() || !s.name.startsWith("session-")) continue;
      const log = join(wsDir, s.name, "session.jsonl.zstd");
      if (!existsSync(log)) continue;
      try {
        out.push({ path: log, mtimeMs: statSync(log).mtimeMs });
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** Parse raw event lines; tolerate compact JSON and partial garbage. */
export function parseEvents(text) {
  const events = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const line = nl < 0 ? text.slice(pos) : text.slice(pos, nl);
    pos = nl < 0 ? text.length : nl + 1;
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (ev && typeof ev === "object") events.push(ev);
    } catch {
      // Compact JSON may glue events on one line: try raw_decode style.
      let p = 0;
      while (p < t.length) {
        if (t[p] !== "{") { p++; continue; }
        try {
          const obj = JSON.parse(t.slice(p));
          events.push(obj);
          p = t.length;
        } catch {
          // find matching close brace
          let depth = 0;
          let q = p;
          for (; q < t.length; q++) {
            if (t[q] === "{") depth++;
            else if (t[q] === "}") { depth--; if (depth === 0) { q++; break; } }
          }
          p = q;
        }
      }
    }
  }
  return events;
}

/** Extract dream-relevant signals from one session's events. */
export function extractSignals(events) {
  const signals = [];
  const userTexts = [];
  let toolFails = 0;
  const fails = [];
  const seen = new Set();
  const isNoise = (t) =>
    t.startsWith("<system-reminder>") || t.startsWith("<system>") ||
    t.startsWith("The approval policy changed") || t.startsWith("You are a coding agent");
  for (const ev of events) {
    const type = ev.type;
    if (type === "user/message") {
      const text = extractText(ev);
      if (!text || !text.trim() || isNoise(text.trim())) continue;
      const key = text.trim().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      userTexts.push(text.trim().slice(0, 500));
    } else if (type === "agent/inbox/spliced") {
      // System-injected messages (runtime context, job notices) — mark skippable.
      const inserted = ev.data?.inserted || [];
      for (const ins of inserted) {
        const t = extractText(ins);
        if (!t || !t.trim() || isNoise(t.trim())) continue;
        const key = "inj:" + t.trim().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        if (ev.data?.target === "next-turn") userTexts.push("[user] " + t.trim().slice(0, 500));
      }
    } else if (type === "tool/result") {
      const content = ev.data?.content || [];
      for (const c of content) {
        if (c && c.isError === true) {
          toolFails++;
          const errText = String(c.text || c.error || "").slice(0, 300);
          if (errText) fails.push(errText);
        }
      }
    }
  }
  // Keep the first few user messages (real instructions), not the tail noise.
  const user = userTexts.filter((t) => !t.startsWith("[user]")).slice(0, 8);
  const injected = userTexts.filter((t) => t.startsWith("[user]")).slice(0, 4);
  if (user.length) signals.push(`用户消息（前 ${user.length} 条）：\n${user.map((t) => "  - " + t).join("\n")}`);
  if (injected.length) signals.push(`注入消息（前 ${injected.length} 条，多为系统上下文）：\n${injected.map((t) => "  - " + t).join("\n")}`);
  if (fails.length) signals.push(`工具失败（${toolFails} 次，前 ${fails.length} 个）：\n${fails.map((t) => "  - " + t).join("\n")}`);
  return signals;
}

function extractText(ev) {
  const parts = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === "string") { parts.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") {
      if (typeof v.text === "string") parts.push(v.text);
      for (const k of Object.keys(v)) {
        if (k === "type" || k === "role" || k === "name") continue;
        if (k === "content" || k === "text" || k === "message" || k === "data") walk(v[k]);
      }
    }
  };
  walk(ev.data ?? ev);
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* dream pass                                                          */
/* ------------------------------------------------------------------ */

function buildGatherSignalFile(logs) {
  ensureDirs();
  const lines = [];
  for (const log of logs) {
    let text = "";
    try { text = decodeSessionLog(readFileSync(log.path)); } catch { continue; }
    const events = parseEvents(text);
    const sigs = extractSignals(events);
    if (sigs.length === 0) continue;
    lines.push(`## 会话 ${log.path.split("/").slice(-2, -1)[0]}`);
    lines.push(`（mtime ${new Date(log.mtimeMs).toISOString().slice(0, 16)}）`);
    lines.push("");
    lines.push(sigs.join("\n"));
    lines.push("");
    if (lines.join("\n").length > SIGNAL_CHAR_BUDGET) break;
  }
  const signalId = "sig-" + randomUUID().slice(0, 8);
  const path = join(SIGNALS_DIR, signalId + ".md");
  writeFileSync(path, lines.join("\n") || "（最近会话未提取到有效信号）");
  return { path, charCount: lines.join("\n").length };
}

function buildDreamPrompt({ memory, signalsPath, sessionCount }) {
  const lines = [];
  lines.push("你是 dsh 的「梦境整合器」（memory consolidation，参照 Claude Code auto-dream skill 的 4-phase 流程）。");
  lines.push("");
  lines.push("目标：把分散在近期会话里的经验/纠正/偏好整合进持久记忆 MEMORY.md，并保持其精简、无矛盾、无过时引用。");
  lines.push("");
  lines.push("步骤：");
  lines.push("1. Orient：读下方「现有 MEMORY.md」。");
  lines.push(`2. Gather：读信号文件 ${signalsPath}（来自最近 ${sessionCount} 个会话的提取：用户消息、注入消息、工具失败）。`);
  lines.push("3. Consolidate：把新发现合并进记忆——相对日期一律转绝对日期（今天是 " + new Date().toISOString().slice(0, 10) + "）；解决矛盾（新纠正优先）；删除对已不存在文件的引用；不产生重复条目。");
  lines.push("4. Prune & Index：把 MEMORY.md 重建为精简索引（**不超过 200 行**）：过时条目降级到主题小标题下，冗长条目压缩成一句话。");
  lines.push("");
  lines.push("## 现有 MEMORY.md");
  lines.push("");
  lines.push(memory || "（尚不存在，从零建立）");
  lines.push("");
  lines.push("## 输出要求");
  lines.push("");
  lines.push("用 fs 工具把整合后的完整 MEMORY.md 覆盖写入：" + MEMORY_FILE);
  lines.push("写完后，最终回复只需一句话摘要：整合了多少条新信号、删除了多少条过时条目、现在多少行。");
  lines.push("");
  lines.push("硬性规则：");
  lines.push("- 不写入任何密钥/凭据/密码。");
  lines.push("- 用户纠正优先于旧记忆；不确定的事实标注「待确认」。");
  lines.push("- MEMORY.md 超过 300 行视为失败——必须压缩。");
  return lines.join("\n");
}

async function runDream({ ctx, subagents, agents, auto }) {
  ensureDirs();
  const startedAt = Date.now();
  const state = loadState();

  // Phase 1: orient.
  const memory = readMemory();

  // Phase 2: gather.
  const logs = listSessionLogs(GATHER_SESSION_LIMIT);
  const signal = buildGatherSignalFile(logs);
  if (!subagents || !agents) throw new Error("缺少 subagents/agents 服务，无法执行整合（可用 dream_status 查看状态）");
  const initiator = (agents && typeof agents.currentInitiator === "function" ? agents.currentInitiator() : undefined);
  const roots = (agents && typeof agents.roots === "function" ? agents.roots() : []);
  const parent = initiator || roots[0];
  if (!parent) throw new Error("没有存活的代理会话可用于派生整合子代理");
  let providerName = null;
  try {
    const names = subagents.list ? subagents.list() : [];
    for (const p of ["spawn", "spawn-in-process", "fork", "fork-in-process"]) {
      if (names.includes(p)) { providerName = p; break; }
    }
    if (!providerName && names.length > 0) providerName = names[0];
  } catch { providerName = null; }
  if (!providerName) throw new Error("没有可用的 subagent provider");

  const prompt = buildDreamPrompt({ memory, signalsPath: signal.path, sessionCount: logs.length });
  const run = await subagents.start(providerName, {
    label: "dream: memory consolidation",
    prompt: [{ type: "text", text: prompt }],
    parent,
    signal: new AbortController().signal,
  });
  await run.result;

  // Verify the written memory file.
  let lines = 0;
  try {
    const out = readFileSync(MEMORY_FILE, "utf8");
    lines = out.split("\n").length;
  } catch { /* not written */ }
  if (!existsSync(MEMORY_FILE)) {
    // Fallback: subagent didn't write (e.g. sandbox) — keep last memory.
    throw new Error("整合子代理未写出 MEMORY.md（沙箱权限？）——保留旧记忆。可检查 " + MEMORY_FILE);
  }
  if (lines > MAX_MEMORY_LINES) {
    // Soft cap: truncate aggressively to keep the file lean.
    const out = readFileSync(MEMORY_FILE, "utf8").split("\n");
    writeFileSync(MEMORY_FILE, out.slice(0, MAX_MEMORY_LINES).join("\n") + "\n");
  }

  state.last_dream_at = startedAt;
  state.passes = (state.passes || []).slice(-50);
  state.passes.push({ at: startedAt, sessions: logs.length, signal: signal.path, memoryLines: Math.min(lines, MAX_MEMORY_LINES), auto });
  saveState(state);
  return { memoryLines: Math.min(lines, MAX_MEMORY_LINES), sessions: logs.length, signalPath: signal.path };
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

  /* -------- dream_run -------- */
  tools.register({
    name: "dream_run",
    description: "执行一次记忆整合（dream）：Orient 读现有 MEMORY.md → Gather 扫描最近 20 个会话（zstd 解码，提取用户消息/注入消息/工具失败）→ Consolidate 派子代理把新信号合并进记忆（相对日期转绝对、消矛盾、去重）→ Prune & Index 重建为精简索引（≤200 行）。结果写入 ~/.dsh/dreams/MEMORY.md。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const r = await runDream({ ctx, subagents, agents, auto: false });
      return `梦境整合完成：扫描 ${r.sessions} 个会话，MEMORY.md 现 ${r.memoryLines} 行（≤${MAX_MEMORY_LINES}）。\n信号文件：${r.signalPath}\n记忆文件：${MEMORY_FILE}`;
    },
    presentCall: () => present("Dream：整合记忆", "dream_run"),

  });

  /* -------- dream_status -------- */
  tools.register({
    name: "dream_status",
    description: "查看梦境状态：上次整合时间、是否到期（24h）、MEMORY.md 行数、最近整合记录。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const state = loadState();
      const lines = [];
      const last = state.last_dream_at;
      if (last) {
        const age = Date.now() - last;
        const due = age >= DREAM_INTERVAL_MS;
        lines.push(`上次整合：${new Date(last).toISOString().slice(0, 16)}（${Math.floor(age / 3600000)} 小时前，${due ? "已到期" : `${Math.ceil((DREAM_INTERVAL_MS - age) / 3600000)} 小时后到期`}）`);
      } else {
        lines.push("从未整合过记忆（到期即自动运行）。");
      }
      let memLines = 0;
      try { memLines = readFileSync(MEMORY_FILE, "utf8").split("\n").length; } catch { /* none */ }
      lines.push(`MEMORY.md：${existsSync(MEMORY_FILE) ? memLines + " 行" : "（尚未创建）"} @ ${MEMORY_FILE}`);
      const passes = state.passes || [];
      if (passes.length > 0) {
        lines.push(`最近整合（${passes.length} 次记录）：`);
        for (const p of passes.slice(-5)) {
          lines.push(`- ${new Date(p.at).toISOString().slice(0, 16)}：${p.sessions} 会话，${p.memoryLines} 行${p.auto ? "（自动）" : ""}`);
        }
      }
      return lines.join("\n");
    },
    presentCall: () => present("Dream：状态", "dream_status"),

  });

  /* -------- dream_now (force, no subagent dependency for status-only envs) -------- */
  tools.register({
    name: "dream_now",
    description: "立即执行一次梦境整合并跳过 24h 间隔检查（等价于 dream_run 但强制）。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const r = await runDream({ ctx, subagents, agents, auto: false });
      return `强制整合完成：${r.sessions} 会话，MEMORY.md ${r.memoryLines} 行。`;
    },
    presentCall: () => present("Dream：强制整合", "dream_now"),

  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "dream",
      description: "记忆整合（dream）：把近期会话经验整合进 ~/.dsh/dreams/MEMORY.md，4-phase（Orient/Gather/Consolidate/Prune&Index），每 24h 自动触发。",
      whenToUse: "当用户提到记忆/忘记/记住、会话经验总结、或 dream/整合时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "dream 是 dsh 的「睡眠记忆整合」：每 24 小时自动扫描最近会话，把用户纠正、偏好变化、重要决定、反复出现的模式整合进 ~/.dsh/dreams/MEMORY.md（自动去重、消矛盾、相对日期转绝对、压缩为 ≤200 行索引）。",
        "",
        "## 使用",
        "",
        "- `dream_run`：手动执行一次整合",
        "- `dream_status`：查看上次整合时间与到期状态",
        "- `dream_now`：跳过间隔检查强制整合",
        "",
        "## 注意",
        "",
        "- 自动触发在后台进行（每小时检查一次是否到期），无需用户在场",
        "- MEMORY.md 是纯文本 markdown，可随时手动编辑；下次整合会基于它继续",
        "- 整合子代理不得写入密钥/凭据",
      ],
    }));
  }

  /* -------- background auto-trigger -------- */
  let running = false;
  disposers.push(ctx.interval(CHECK_INTERVAL_MS, async () => {
    if (running) return;
    const state = loadState();
    const last = state.last_dream_at;
    if (last && Date.now() - last < DREAM_INTERVAL_MS) return;
    if (last === null && existsSync(MEMORY_FILE)) return; // never dream with no baseline? no: first dream is fine
    running = true;
    try {
      const r = await runDream({ ctx, subagents, agents, auto: true });
      ctx.logger.info(`[dsh-dream] auto pass: ${r.sessions} sessions, ${r.memoryLines} lines`);
    } catch (err) {
      ctx.logger.warn(`[dsh-dream] auto pass failed: ${err.message}`);
    } finally {
      running = false;
    }
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

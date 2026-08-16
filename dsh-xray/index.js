/**
 * dsh-xray — session data deep analysis & export for DeepSeek Harness.
 *
 * Ecosystem gap: session analytics/export is half-blank (only billing-ish
 * widgets and a 3★ trajectory tool; no unified "session warehouse").
 * dsh-xray is the model-side session warehouse:
 *
 *   xray_sessions — overview analytics across recent sessions
 *                   (counts, tokens, tool distribution, error rates)
 *   xray_session  — deep-dive into one session (full event timeline stats)
 *   xray_search   — full-text search over user/assistant message text
 *   xray_export   — export a session to markdown / JSON file
 *
 * Session logs live at ~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd
 * — multi-frame zstd with compact JSON events (see dsh-ops skill).
 *
 * @module dsh-xray
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-xray";
export const inject = ["tools", "skills"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const XRAY_DIR = join(DSH_HOME, "xray");

/* ------------------------------------------------------------------ */
/* session log decoding (multi-frame zstd + compact JSON)              */
/* ------------------------------------------------------------------ */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decodeSessionLog(buf) {
  const chunks = [];
  let remaining = buf;
  let guard = 0;
  while (remaining.length > 0 && guard++ < 4096) {
    try {
      chunks.push(zstdDecompressSync(remaining));
    } catch {
      break;
    }
    const idx = remaining.indexOf(ZSTD_MAGIC, 1);
    if (idx < 0) break;
    remaining = remaining.subarray(idx);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a decoded log into events (line-based with compact-JSON recovery). */
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
      let p = 0;
      while (p < t.length) {
        if (t[p] !== "{") { p++; continue; }
        try {
          events.push(JSON.parse(t.slice(p)));
          p = t.length;
        } catch {
          let depth = 0, q = p;
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

/** Walk an event payload and collect all strings (for text extraction). */
export function collectText(v, out = []) {
  if (v == null) return out;
  if (typeof v === "string") { out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) collectText(x, out); return out; }
  if (typeof v === "object") {
    if (typeof v.text === "string") out.push(v.text);
    for (const k of Object.keys(v)) {
      if (k === "type" || k === "role" || k === "name" || k === "id" || k === "ts" || k === "seq") continue;
      if (k === "content" || k === "text" || k === "message" || k === "data" || k === "inserted" || k === "reasoning") collectText(v[k], out);
    }
  }
  return out;
}

/** Try to extract token usage counters from an event payload (defensive). */
function extractUsage(ev) {
  const walk = (v, out) => {
    if (!v || typeof v !== "object") return out;
    if (typeof v.usage === "object" && v.usage !== null) {
      const u = v.usage;
      out.cacheRead += Number(u.cacheReadTokens || u.cache_read || 0) || 0;
      out.uncachedInput += Number(u.uncachedInputTokens || u.uncached_input || u.inputTokens || u.input_tokens || 0) || 0;
      out.cacheWrite += Number(u.cacheWriteTokens || u.cache_write || 0) || 0;
      out.output += Number(u.outputTokens || u.output_tokens || u.completionTokens || 0) || 0;
    }
    for (const k of Object.keys(v)) {
      if (v[k] && typeof v[k] === "object") walk(v[k], out);
    }
    return out;
  };
  return walk(ev, { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0 });
}

/** List session dirs, newest first. Returns [{id, dir, log, mtimeMs, workspace}] */
export function listSessions(limit = 200) {
  const out = [];
  if (!existsSync(SESSIONS_DIR)) return out;
  for (const ws of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(SESSIONS_DIR, ws.name);
    let entries;
    try { entries = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of entries) {
      if (!s.isDirectory() || !s.name.startsWith("session-")) continue;
      const log = join(wsDir, s.name, "session.jsonl.zstd");
      if (!existsSync(log)) continue;
      try {
        out.push({ id: s.name, dir: join(wsDir, s.name), log, mtimeMs: statSync(log).mtimeMs, workspace: ws.name });
      } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** Load + decode + parse one session. Returns events or throws. */
export function loadSession(idOrDir) {
  const dir = idOrDir.includes("/") || idOrDir.endsWith(".zstd")
    ? idOrDir
    : (listSessions(5000).find((s) => s.id === idOrDir || s.id.includes(idOrDir))?.dir);
  if (!dir) throw new Error(`会话不存在: ${idOrDir}（xray_sessions 可查 id）`);
  const log = join(dir, "session.jsonl.zstd");
  if (!existsSync(log)) throw new Error(`会话日志不存在: ${log}`);
  const text = decodeSessionLog(readFileSync(log));
  return { dir, log, events: parseEvents(text), text };
}

/* ------------------------------------------------------------------ */
/* analytics                                                           */
/* ------------------------------------------------------------------ */

const NOISE_PREFIXES = ["<system-reminder>", "<system>", "The approval policy changed", "You are a coding agent"];

function analyzeEvents(events) {
  const a = {
    turns: 0, steps: 0, userMsgs: 0, assistantMsgs: 0, reasoningMsgs: 0,
    toolCalls: 0, toolErrors: 0, tools: {}, errors: [], firstTs: null, lastTs: null,
    usage: { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0 },
    userTexts: [], assistantTexts: [], toolNames: {},
  };
  for (const ev of events) {
    const type = ev.type;
    const ts = Number(ev.ts ?? ev.data?.ts ?? 0);
    if (ts) { if (!a.firstTs || ts < a.firstTs) a.firstTs = ts; if (!a.lastTs || ts > a.lastTs) a.lastTs = ts; }
    if (type === "turn/start" || type === "turn/end") a.turns++;
    else if (type === "step/start" || type === "step/end") a.steps++;
    else if (type === "user/message") {
      a.userMsgs++;
      const texts = collectText(ev).map((t) => t.trim()).filter(Boolean);
      for (const t of texts) {
        if (NOISE_PREFIXES.some((p) => t.startsWith(p))) continue;
        a.userTexts.push(t.slice(0, 500));
        break;
      }
    } else if (type === "assistant/message") {
      a.assistantMsgs++;
      const texts = collectText(ev).map((t) => t.trim()).filter(Boolean);
      const meaningful = texts.filter((t) => !t.startsWith("<") && t.length > 0);
      if (meaningful.length) a.assistantTexts.push(meaningful[0].slice(0, 500));
      const u = extractUsage(ev);
      a.usage.cacheRead += u.cacheRead; a.usage.uncachedInput += u.uncachedInput;
      a.usage.cacheWrite += u.cacheWrite; a.usage.output += u.output;
    } else if (type === "reasoning-chunks") {
      a.reasoningMsgs++;
    } else if (type === "tool/call") {
      a.toolCalls++;
      const name = String(ev.data?.name || "?");
      a.tools[name] = (a.tools[name] || 0) + 1;
      a.toolNames[name] = true;
    } else if (type === "tool/result") {
      const content = ev.data?.content || [];
      const bad = Array.isArray(content) ? content.filter((c) => c && c.isError === true) : [];
      if (bad.length > 0) {
        a.toolErrors++;
        a.errors.push({ tool: String(ev.data?.name || "?"), msg: String(bad[0]?.text || bad[0]?.error || "?").slice(0, 300) });
      }
    }
  }
  return a;
}

const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "—";
const fmtRel = (ms) => {
  if (!ms) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
};
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const disposers = [];

  /* -------- xray_sessions -------- */
  tools.register({
    name: "xray_sessions",
    description: "会话数据分析总览：扫描最近 N 个会话（zstd 解码），统计轮次/步数/工具调用分布/错误率/Token 用量（若事件含 usage）。可按 days 或 limit 过滤。",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "只统计最近 N 天的会话（默认 7）" },
        limit: { type: "number", description: "最多扫描 N 个会话（默认 200）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const days = Math.max(1, Number(args.days) || 7);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 200));
      const since = Date.now() - days * 86400000;
      const sessions = listSessions(limit).filter((s) => s.mtimeMs >= since);
      if (sessions.length === 0) return `近 ${days} 天没有会话记录（@ ${SESSIONS_DIR}）。`;
      const totals = { sessions: sessions.length, turns: 0, steps: 0, toolCalls: 0, toolErrors: 0, cacheRead: 0, uncachedInput: 0, output: 0 };
      const toolsAgg = {};
      const errs = [];
      const perDay = {};
      for (const s of sessions) {
        try {
          const { events } = loadSession(s.id);
          const a = analyzeEvents(events);
          totals.turns += a.turns; totals.steps += a.steps; totals.toolCalls += a.toolCalls; totals.toolErrors += a.toolErrors;
          totals.cacheRead += a.usage.cacheRead; totals.uncachedInput += a.usage.uncachedInput; totals.output += a.usage.output;
          for (const [t, n] of Object.entries(a.tools)) toolsAgg[t] = (toolsAgg[t] || 0) + n;
          for (const e of a.errors.slice(0, 3)) errs.push({ ...e, id: s.id });
          const day = new Date(s.mtimeMs).toISOString().slice(0, 10);
          perDay[day] = (perDay[day] || 0) + 1;
        } catch { /* skip unreadable */ }
      }
      const lines = [];
      lines.push(`# xray 会话总览（近 ${days} 天，${totals.sessions} 个会话）`);
      lines.push("");
      lines.push(`- 轮次 ${totals.turns} / 步骤 ${totals.steps} / 工具调用 ${totals.toolCalls}（失败 ${totals.toolErrors}，${totals.toolCalls ? Math.round(totals.toolErrors / totals.toolCalls * 100) : 0}%）`);
      const inTok = totals.uncachedInput + totals.cacheRead + totals.cacheRead;
      lines.push(`- Token（事件含 usage 时）: 输入 ~${totals.uncachedInput + totals.cacheRead}（缓存读 ${totals.cacheRead}），输出 ${totals.output}`);
      lines.push(`- 按天: ${Object.entries(perDay).sort().map(([d, n]) => `${d}×${n}`).join("，")}`);
      lines.push("");
      const top = Object.entries(toolsAgg).sort((a, b) => b[1] - a[1]).slice(0, 15);
      if (top.length) {
        lines.push("## 工具调用分布（top " + top.length + "）");
        for (const [t, n] of top) lines.push(`- ${t}: ${n}`);
      }
      if (errs.length) {
        lines.push("");
        lines.push("## 高频错误样本");
        for (const e of errs.slice(0, 8)) lines.push(`- ${e.id.slice(-12)} ${e.tool}: ${cap(e.msg, 120)}`);
      }
      lines.push("");
      lines.push("提示: xray_session id=<会话id> 看单会话详情；xray_search query=… 全文搜索；xray_export 导出。");
      return lines.join("\n");
    },
    presentCall: () => present("Xray：会话总览", "xray_sessions"),
  });

  /* -------- xray_session -------- */
  tools.register({
    name: "xray_session",
    description: "单会话深度分析：轮次/步骤/工具调用明细/错误/Token/用户消息/助手回复摘要。id 可用完整 session-<uuid> 或前缀。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "会话 id（xray_sessions 可查）" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const { dir, events } = loadSession(String(args.id));
      const a = analyzeEvents(events);
      const lines = [];
      lines.push(`# 会话 ${basename(dir)}`);
      lines.push("");
      lines.push(`- 时间: ${fmtTs(a.firstTs)} ~ ${fmtTs(a.lastTs)}（${a.firstTs && a.lastTs ? Math.round((a.lastTs - a.firstTs) / 1000) + "s" : "—"}）`);
      lines.push(`- 轮次 ${a.turns} / 步骤 ${a.steps} / 助手消息 ${a.assistantMsgs} / 推理块 ${a.reasoningMsgs}`);
      lines.push(`- 工具调用 ${a.toolCalls}（失败 ${a.toolErrors}）`);
      lines.push(`- Token: 输入 ${a.usage.uncachedInput + a.usage.cacheRead}（缓存读 ${a.usage.cacheRead}）输出 ${a.usage.output}`);
      lines.push("");
      lines.push("## 工具明细");
      const sorted = Object.entries(a.tools).sort((x, y) => y[1] - x[1]);
      if (sorted.length === 0) lines.push("（无工具调用）");
      for (const [t, n] of sorted) lines.push(`- ${t}: ${n} 次`);
      lines.push("");
      lines.push("## 用户消息（前 12）");
      if (a.userTexts.length === 0) lines.push("（无）");
      for (const t of a.userTexts.slice(0, 12)) lines.push(`- ${cap(t, 200)}`);
      lines.push("");
      lines.push("## 助手回复摘要（前 8）");
      if (a.assistantTexts.length === 0) lines.push("（无）");
      for (const t of a.assistantTexts.slice(0, 8)) lines.push(`- ${cap(t, 200)}`);
      if (a.errors.length) {
        lines.push("");
        lines.push("## 工具失败（前 10）");
        for (const e of a.errors.slice(0, 10)) lines.push(`- ${e.tool}: ${cap(e.msg, 150)}`);
      }
      return lines.join("\n");
    },
    presentCall: (args) => present("Xray：会话详情", String(args?.id || "").slice(0, 16)),
  });

  /* -------- xray_search -------- */
  tools.register({
    name: "xray_search",
    description: "跨会话全文搜索：在最近 N 个会话的用户/助手消息里搜关键词（大小写不敏感），返回命中会话 + 匹配上下文片段。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词（必填）" },
        limit: { type: "number", description: "最多扫描会话数（默认 100）" },
        max_hits: { type: "number", description: "最多返回命中（默认 10）" },
      },
      required: ["query"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const q = String(args.query || "").trim().toLowerCase();
      if (!q) throw new Error("query 必填");
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 100));
      const maxHits = Math.min(20, Math.max(1, Number(args.max_hits) || 10));
      const hits = [];
      for (const s of listSessions(limit)) {
        try {
          const { events } = loadSession(s.id);
          const a = analyzeEvents(events);
          const candidates = [...a.userTexts, ...a.assistantTexts];
          for (const t of candidates) {
            const idx = t.toLowerCase().indexOf(q);
            if (idx >= 0) {
              const start = Math.max(0, idx - 60);
              const snippet = (start > 0 ? "…" : "") + t.slice(start, idx + q.length + 120) + "…";
              hits.push({ id: s.id, mtimeMs: s.mtimeMs, snippet });
              break;
            }
          }
        } catch { /* skip */ }
        if (hits.length >= maxHits * 2) break;
      }
      if (hits.length === 0) return `近 ${limit} 个会话中没找到「${args.query}」。`;
      const lines = [`搜索「${args.query}」：${hits.length} 个命中会话`];
      for (const h of hits.slice(0, maxHits)) {
        lines.push(`- ${h.id.slice(-14)}（${fmtRel(Date.now() - h.mtimeMs)}）`);
        lines.push(`  ${h.snippet}`);
      }
      lines.push("");
      lines.push(`用 xray_session id=<会话id> 查看完整会话。`);
      return lines.join("\n");
    },
    presentCall: (args) => present("Xray：搜索", String(args?.query || "").slice(0, 30)),
  });

  /* -------- xray_export -------- */
  tools.register({
    name: "xray_export",
    description: "导出会话为 markdown（默认）或 JSON：完整事件时间线 + 分析摘要，写入 ~/.dsh/xray/（可指定 path）。用于归档、分享、喂给其他 agent。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "会话 id" },
        format: { type: "string", enum: ["markdown", "json"], description: "默认 markdown" },
        path: { type: "string", description: "可选：输出路径" },
      },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const { dir, events } = loadSession(String(args.id));
      const a = analyzeEvents(events);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      let out;
      if (args.format === "json") {
        out = JSON.stringify({ session: basename(dir), exported_at: new Date().toISOString(), summary: {
          turns: a.turns, steps: a.steps, toolCalls: a.toolCalls, toolErrors: a.toolErrors,
          tools: a.tools, usage: a.usage,
        }, events }, null, 2);
      } else {
        const lines = [];
        lines.push(`# 会话导出 ${basename(dir)}`);
        lines.push("");
        lines.push(`> 导出时间 ${fmtTs(Date.now())} | 轮次 ${a.turns} | 步骤 ${a.steps} | 工具 ${a.toolCalls}（失败 ${a.toolErrors}）`);
        lines.push("");
        for (const ev of events) {
          const type = String(ev.type || "?");
          if (type === "user/message") {
            const texts = collectText(ev).map((t) => t.trim()).filter((t) => t && !NOISE_PREFIXES.some((p) => t.startsWith(p)));
            if (texts.length) lines.push(`## 👤 ${texts[0]}`);
          } else if (type === "assistant/message") {
            const texts = collectText(ev).map((t) => t.trim()).filter((t) => t && !t.startsWith("<"));
            if (texts.length) lines.push(texts.join("\n\n"), "");
          } else if (type === "tool/call") {
            lines.push(`- ⚙️ ${ev.data?.name}: \`${cap(String(ev.data?.arguments ?? ""), 300)}\``);
          } else if (type === "tool/result") {
            const content = ev.data?.content || [];
            const bad = Array.isArray(content) ? content.filter((c) => c?.isError === true) : [];
            if (bad.length) lines.push(`  ❌ ${cap(String(bad[0]?.text || bad[0]?.error || ""), 200)}`);
          }
        }
        out = lines.join("\n");
      }
      mkdirSync(XRAY_DIR, { recursive: true });
      const target = args.path ? String(args.path) : join(XRAY_DIR, `${basename(dir)}-${ts}.${args.format === "json" ? "json" : "md"}`);
      writeFileSync(target, out);
      return `已导出会话 ${basename(dir)}（${(out.length / 1024).toFixed(1)} KB）→ ${target}`;
    },
    presentCall: (args) => present("Xray：导出", String(args?.id || "").slice(0, 16)),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "xray",
      description: "会话数据分析：xray_sessions 总览 / xray_session 详情 / xray_search 全文搜索 / xray_export 导出。",
      whenToUse: "当需要分析历史会话、统计工具使用/错误、搜索过去说过的话、或导出会话记录时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "xray 直接解码 ~/.dsh/sessions 下的 zstd 会话日志（多帧解码 + 紧凑 JSON 容错），提供模型侧的数据分析：",
        "",
        "- `xray_sessions`：总览（轮次/步骤/工具分布/错误率/Token/按天）",
        "- `xray_session id=…`：单会话深挖（用户消息/助手摘要/失败明细）",
        "- `xray_search query=…`：跨会话全文搜索",
        "- `xray_export id=… format=markdown|json`：导出归档或喂给其他 agent",
        "",
        "## 注意",
        "",
        "- Token 统计依赖事件里的 usage 字段，无 usage 时显示 0",
        "- 解码是纯本地计算，几百个会话可能耗时数秒（limit 控制扫描量）",
        "- 搜索是朴素子串匹配（大小写不敏感），不是语义搜索",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

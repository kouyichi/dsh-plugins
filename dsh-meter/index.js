/**
 * dsh-meter — token usage & cost metering for DeepSeek Harness.
 *
 * The web-UI side is saturated with balance/billing widgets (20+ duplicates),
 * but there is NO model-side usage analytics over the durable session logs.
 * dsh-meter decodes session logs and aggregates token usage (input vs cache-
 * read vs output), cache hit rate, and an estimated cost with configurable
 * pricing (~/.dsh/meter/pricing.json; defaults are labeled as estimates).
 *
 *   meter_summary — aggregate usage across recent sessions (+ per-day)
 *   meter_session — one session's usage detail
 *   meter_report  — write a markdown report to ~/.dsh/meter/reports/
 *
 * @module dsh-meter
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-meter";
export const inject = ["tools", "skills"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const METER_DIR = join(DSH_HOME, "meter");
const PRICING_FILE = join(METER_DIR, "pricing.json");

/** Default pricing (USD per 1M tokens) — ESTIMATES, override in pricing.json. */
const DEFAULT_PRICING = { input_per_mtok: 0.5, cache_read_per_mtok: 0.1, output_per_mtok: 1.5 };

/* ------------------------------------------------------------------ */
/* decoding (shared pattern with dsh-xray)                             */
/* ------------------------------------------------------------------ */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeSessionLog(buf) {
  const chunks = [];
  let remaining = buf;
  let guard = 0;
  while (remaining.length > 0 && guard++ < 4096) {
    try { chunks.push(zstdDecompressSync(remaining)); } catch { break; }
    const idx = remaining.indexOf(ZSTD_MAGIC, 1);
    if (idx < 0) break;
    remaining = remaining.subarray(idx);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseEvents(text) {
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
        try { events.push(JSON.parse(t.slice(p))); p = t.length; } catch {
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

/** Aggregate usage counters from one session's events. */
export function usageFromEvents(events) {
  const u = { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0, turns: 0, steps: 0, toolCalls: 0, toolErrors: 0 };
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (typeof v.usage === "object" && v.usage !== null) {
      const w = v.usage;
      u.cacheRead += Number(w.cacheReadTokens ?? w.cache_read ?? 0) || 0;
      u.uncachedInput += Number(w.uncachedInputTokens ?? w.uncached_input ?? w.inputTokens ?? w.input_tokens ?? 0) || 0;
      u.cacheWrite += Number(w.cacheWriteTokens ?? w.cache_write ?? 0) || 0;
      u.output += Number(w.outputTokens ?? w.output_tokens ?? w.completionTokens ?? 0) || 0;
    }
    for (const k of Object.keys(v)) {
      if (v[k] && typeof v[k] === "object") walk(v[k]);
    }
  };
  for (const ev of events) {
    const type = ev.type;
    if (type === "turn/start" || type === "turn/end") u.turns++;
    else if (type === "step/start" || type === "step/end") u.steps++;
    else if (type === "tool/call") u.toolCalls++;
    else if (type === "tool/result") {
      const content = ev.data?.content || [];
      if (Array.isArray(content) && content.some((c) => c && c.isError === true)) u.toolErrors++;
    }
    walk(ev.data ?? ev);
  }
  return u;
}

function listSessionLogs(limit) {
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
      try { out.push({ id: s.name, path: log, mtimeMs: statSync(log).mtimeMs }); } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

function loadPricing() {
  mkdirSync(METER_DIR, { recursive: true });
  try { return { ...DEFAULT_PRICING, ...JSON.parse(readFileSync(PRICING_FILE, "utf8")) }; }
  catch { return { ...DEFAULT_PRICING }; }
}

function costOf(u, pricing) {
  return (
    u.uncachedInput / 1e6 * pricing.input_per_mtok +
    u.cacheRead / 1e6 * pricing.cache_read_per_mtok +
    u.output / 1e6 * pricing.output_per_mtok
  );
}

const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "—";
const fmtUsd = (v) => `$${v.toFixed(4)}`;
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const disposers = [];

  /* -------- meter_summary -------- */
  tools.register({
    name: "meter_summary",
    description: "用量总览：扫描最近会话（zstd 解码），统计 Token（缓存读/未缓存输入/输出）、缓存命中率、估算成本、按天分布、按会话 Top。价格可在 ~/.dsh/meter/pricing.json 覆盖（默认值为估算）。",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "统计窗口（天），默认 7" },
        limit: { type: "number", description: "最多扫描会话数，默认 300" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const days = Math.max(1, Number(args.days) || 7);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 300));
      const since = Date.now() - days * 86400000;
      const pricing = loadPricing();
      const sessions = listSessionLogs(limit).filter((s) => s.mtimeMs >= since);
      if (sessions.length === 0) return `近 ${days} 天没有会话。`;
      const agg = { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0, turns: 0, steps: 0, toolCalls: 0, toolErrors: 0, withUsage: 0 };
      const perDay = {};
      const perSession = [];
      for (const s of sessions) {
        try {
          const u = usageFromEvents(parseEvents(decodeSessionLog(readFileSync(s.path))));
          agg.cacheRead += u.cacheRead; agg.uncachedInput += u.uncachedInput; agg.cacheWrite += u.cacheWrite; agg.output += u.output;
          agg.turns += u.turns; agg.steps += u.steps; agg.toolCalls += u.toolCalls; agg.toolErrors += u.toolErrors;
          if (u.cacheRead + u.uncachedInput + u.output > 0) agg.withUsage++;
          const day = new Date(s.mtimeMs).toISOString().slice(0, 10);
          perDay[day] = perDay[day] || { cacheRead: 0, uncachedInput: 0, output: 0 };
          perDay[day].cacheRead += u.cacheRead; perDay[day].uncachedInput += u.uncachedInput; perDay[day].output += u.output;
          perSession.push({ id: s.id, ...u, mtimeMs: s.mtimeMs });
        } catch { /* skip */ }
      }
      const totalIn = agg.uncachedInput + agg.cacheRead;
      const hitRate = totalIn ? agg.cacheRead / totalIn : 0;
      const cost = costOf(agg, pricing);
      const lines = [];
      lines.push(`# 用量总览（近 ${days} 天，${sessions.length} 会话，${agg.withUsage} 个含 usage 数据）`);
      lines.push("");
      lines.push(`- 输入: ${agg.uncachedInput.toLocaleString()}（未缓存）+ ${agg.cacheRead.toLocaleString()}（缓存读）| 缓存命中率 ${(hitRate * 100).toFixed(1)}%`);
      lines.push(`- 输出: ${agg.output.toLocaleString()}`);
      lines.push(`- 估算成本: ${fmtUsd(cost)}（价格: 输入 $${pricing.input_per_mtok}/M, 缓存读 $${pricing.cache_read_per_mtok}/M, 输出 $${pricing.output_per_mtok}/M — 可在 ${PRICING_FILE} 覆盖）`);
      lines.push(`- 活动: ${agg.turns} 轮 / ${agg.steps} 步 / ${agg.toolCalls} 工具调用（失败 ${agg.toolErrors}）`);
      lines.push("");
      lines.push("## 按天");
      for (const [d, v] of Object.entries(perDay).sort()) {
        lines.push(`- ${d}: 输入 ${(v.uncachedInput + v.cacheRead).toLocaleString()}（缓存 ${(v.cacheRead / Math.max(1, v.uncachedInput + v.cacheRead) * 100).toFixed(0)}%）/ 输出 ${v.output.toLocaleString()} ≈ ${fmtUsd(costOf(v, pricing))}`);
      }
      lines.push("");
      lines.push("## Top 会话（按成本）");
      for (const s of [...perSession].sort((a, b) => costOf(b, pricing) - costOf(a, pricing)).slice(0, 8)) {
        lines.push(`- ${s.id.slice(-14)}（${fmtTs(s.mtimeMs).slice(0, 10)}）: ${fmtUsd(costOf(s, pricing))} | 输入 ${(s.uncachedInput + s.cacheRead).toLocaleString()} 输出 ${s.output.toLocaleString()} | ${s.toolCalls} 工具${s.toolErrors ? "（" + s.toolErrors + " 失败）" : ""}`);
      }
      lines.push("");
      lines.push("提示: meter_session id=… 看单会话；meter_report 生成报告文件。");
      return lines.join("\n");
    },
    presentCall: () => present("Meter：用量总览", "meter_summary"),
  });

  /* -------- meter_session -------- */
  tools.register({
    name: "meter_session",
    description: "单会话用量明细：Token 拆分、缓存命中率、成本、活动统计。id 可用完整 id 或前缀。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "会话 id" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const sessions = listSessionLogs(5000);
      const s = sessions.find((x) => x.id === String(args.id) || x.id.includes(String(args.id)));
      if (!s) throw new Error(`会话不存在: ${args.id}`);
      const u = usageFromEvents(parseEvents(decodeSessionLog(readFileSync(s.path))));
      const pricing = loadPricing();
      const totalIn = u.uncachedInput + u.cacheRead;
      const lines = [];
      lines.push(`# 会话 ${s.id}`);
      lines.push(`> ${fmtTs(s.mtimeMs)}`);
      lines.push("");
      lines.push(`- 输入: ${u.uncachedInput.toLocaleString()}（未缓存）+ ${u.cacheRead.toLocaleString()}（缓存读）| 命中率 ${(totalIn ? u.cacheRead / totalIn * 100 : 0).toFixed(1)}%`);
      lines.push(`- 输出: ${u.output.toLocaleString()}`);
      lines.push(`- 估算成本: ${fmtUsd(costOf(u, pricing))}`);
      lines.push(`- 活动: ${u.turns} 轮 / ${u.steps} 步 / ${u.toolCalls} 工具调用（失败 ${u.toolErrors}）`);
      return lines.join("\n");
    },
    presentCall: (args) => present("Meter：会话用量", String(args?.id || "").slice(0, 16)),
  });

  /* -------- meter_report -------- */
  tools.register({
    name: "meter_report",
    description: "生成用量报告 markdown 文件（~/.dsh/meter/reports/）：含总览、按天、Top 会话、成本明细。可用于周报/审计。",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "窗口（天），默认 7" }, path: { type: "string", description: "可选：输出路径" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const days = Math.max(1, Number(args.days) || 7);
      const since = Date.now() - days * 86400000;
      const pricing = loadPricing();
      const sessions = listSessionLogs(2000).filter((s) => s.mtimeMs >= since);
      const lines = [];
      lines.push(`# dsh 用量报告（近 ${days} 天）`);
      lines.push("");
      lines.push(`> 生成时间 ${fmtTs(Date.now())} | 会话数 ${sessions.length} | 价格配置见 ${PRICING_FILE}`);
      lines.push("");
      const agg = { cacheRead: 0, uncachedInput: 0, output: 0 };
      const perSession = [];
      for (const s of sessions) {
        try {
          const u = usageFromEvents(parseEvents(decodeSessionLog(readFileSync(s.path))));
          agg.cacheRead += u.cacheRead; agg.uncachedInput += u.uncachedInput; agg.output += u.output;
          perSession.push({ id: s.id, mtimeMs: s.mtimeMs, ...u });
        } catch { /* skip */ }
      }
      lines.push(`## 总览`);
      lines.push("");
      lines.push(`- 输入: ${agg.uncachedInput.toLocaleString()} + 缓存读 ${agg.cacheRead.toLocaleString()}（命中率 ${(agg.uncachedInput + agg.cacheRead ? agg.cacheRead / (agg.uncachedInput + agg.cacheRead) * 100 : 0).toFixed(1)}%）`);
      lines.push(`- 输出: ${agg.output.toLocaleString()}`);
      lines.push(`- 估算成本: ${fmtUsd(costOf(agg, pricing))}`);
      lines.push("");
      lines.push(`## 会话明细`);
      lines.push("");
      lines.push("| 会话 | 日期 | 输入 | 缓存读 | 输出 | 成本 |");
      lines.push("|---|---|---|---|---|---|");
      for (const s of [...perSession].sort((a, b) => costOf(b, pricing) - costOf(a, pricing))) {
        lines.push(`| ${s.id.slice(-14)} | ${fmtTs(s.mtimeMs).slice(0, 10)} | ${s.uncachedInput.toLocaleString()} | ${s.cacheRead.toLocaleString()} | ${s.output.toLocaleString()} | ${fmtUsd(costOf(s, pricing))} |`);
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      mkdirSync(join(METER_DIR, "reports"), { recursive: true });
      const out = args.path ? String(args.path) : join(METER_DIR, "reports", `meter-${ts}.md`);
      writeFileSync(out, lines.join("\n"));
      return `已生成用量报告（${sessions.length} 会话，${fmtUsd(costOf(agg, pricing))}）→ ${out}`;
    },
    presentCall: () => present("Meter：报告", "meter_report"),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "meter",
      description: "Token 用量与成本统计：meter_summary 总览 / meter_session 单会话 / meter_report 报告文件。",
      whenToUse: "当需要统计 token 消耗、缓存命中率、估算成本、或出用量周报时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "meter 解码会话日志统计 Token 用量（输入/缓存读/输出）与估算成本。",
        "",
        "## 常用",
        "",
        "- `meter_summary days=7`：总览（命中率/成本/按天/Top 会话）",
        "- `meter_session id=…`：单会话明细",
        "- `meter_report days=7`：生成 markdown 报告文件",
        "",
        "## 注意",
        "",
        "- 价格默认值为估算，可在 ~/.dsh/meter/pricing.json 覆盖（input_per_mtok / cache_read_per_mtok / output_per_mtok）",
        "- 仅统计事件中带 usage 的会话（无 usage 时成本为 0）",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

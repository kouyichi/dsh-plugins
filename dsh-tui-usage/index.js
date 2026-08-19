/**
 * dsh-tui-usage — TUI brick: /usage panel.
 *
 * One screen with token + cache + estimated cost for the current session and
 * a quick global overview (recent sessions). Pricing file is shared with the
 * dsh-meter plugin (~/.dsh/meter/pricing.json) so both surfaces agree.
 *
 * @module dsh-tui-usage
 */

import { existsSync, openSync, readFileSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-tui-usage";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const PRICING_FILE = join(DSH_HOME, "meter", "pricing.json");

const DEFAULT_PRICING = { input_per_mtok: 0.5, cache_read_per_mtok: 0.1, output_per_mtok: 1.5 };

// H15: pricing 模块级缓存 —— 状态栏 render 每次调用都会触发，不能每次读盘。
// 策略：启动/首次读一次，之后靠 mtime 变化刷新 + 60s TTL 双保险。
const PRICING_TTL_MS = 60_000;
let pricingCache = null;
let pricingMtime = -1;
let pricingLoadedAt = 0;

function loadPricing() {
  const now = Date.now();
  if (pricingCache && now - pricingLoadedAt < PRICING_TTL_MS) return pricingCache;
  let next = { ...DEFAULT_PRICING };
  try {
    const st = statSync(PRICING_FILE);
    if (pricingCache && st.mtimeMs === pricingMtime) {
      // 文件未变：延长缓存有效期，避免每次 render 都 stat
      pricingLoadedAt = now;
      return pricingCache;
    }
    pricingMtime = st.mtimeMs;
    next = { ...DEFAULT_PRICING, ...JSON.parse(readFileSync(PRICING_FILE, "utf8")) };
  } catch { /* 文件缺失/解析失败 → 默认价 */ }
  pricingCache = next;
  pricingLoadedAt = now;
  return pricingCache;
}

const costOf = (u, p) =>
  u.uncachedInput / 1e6 * p.input_per_mtok +
  u.cacheRead / 1e6 * p.cache_read_per_mtok +
  u.output / 1e6 * p.output_per_mtok;

const fmtUsd = (v) => (v > 0 && v < 0.0001 ? "<$0.0001" : `$${v.toFixed(4)}`);

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** H16: 只读文件头部 maxBytes，避免面板扫描时整文件读入内存。 */
function readHead(path, maxBytes = 64 * 1024) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

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

function usageFromEvents(events) {
  const u = { cacheRead: 0, uncachedInput: 0, cacheWrite: 0, output: 0, turns: 0, toolCalls: 0, toolErrors: 0 };
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (typeof v.usage === "object" && v.usage !== null) {
      const w = v.usage;
      u.cacheRead += Number(w.cacheReadTokens ?? w.cache_read ?? 0) || 0;
      u.uncachedInput += Number(w.uncachedInputTokens ?? w.uncached_input ?? w.inputTokens ?? w.input_tokens ?? 0) || 0;
      u.cacheWrite += Number(w.cacheWriteTokens ?? w.cache_write ?? 0) || 0;
      u.output += Number(w.outputTokens ?? w.output_tokens ?? w.completionTokens ?? 0) || 0;
    }
    for (const k of Object.keys(v)) if (v[k] && typeof v[k] === "object") walk(v[k]);
  };
  for (const ev of events) {
    // H14: turn/start 与 turn/end 是同一轮的两个端点，只按 turn/end 计一次
    if (ev.type === "turn/end") u.turns++;
    else if (ev.type === "tool/call") u.toolCalls++;
    else if (ev.type === "tool/result") {
      const content = ev.data?.content || [];
      if (Array.isArray(content) && content.some((c) => c && c.isError === true)) u.toolErrors++;
    }
    walk(ev.data ?? ev);
  }
  return u;
}

function recentSessions(limit) {
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

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-usage] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/usage",
    description: "用量与成本面板",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("usage");
    },
  }));

  disposers.push(ext.registerStatusField({
    id: "usage-cost",
    order: 40,
    render(store) {
      const s = store.stats;
      if (!s) return "";
      const p = loadPricing();
      const cost = s.uncachedInput / 1e6 * p.input_per_mtok + s.cacheRead / 1e6 * p.cache_read_per_mtok + (s.decodeTokens ?? 0) / 1e6 * p.output_per_mtok;
      return `cost ${fmtUsd(cost)}`;
    },
  }));

  disposers.push(ext.registerPanel({
    id: "usage",
    title: "用量 / usage",
    async load(store) {
      const p = loadPricing();
      const lines = [];
      // 优先内核投影（sessionProjections → sessionStats + tokenUsage，web 同款数据源），
      // 投影不可用（服务未挂/会话未就绪）时回退核心 store.stats（事件聚合）。
      let s = null;
      try {
        const agents = ctx.get("agents");
        const proj = ctx.get("sessionProjections");
        const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
        if (parent && proj?.snapshot) {
          const values = proj.snapshot(parent.session)?.values ?? {};
          const stats = values.sessionStats ?? {};
          const usage = values.tokenUsage ?? {};
          s = {
            cacheRead: usage.cacheReadTokens ?? 0,
            uncachedInput: usage.uncachedInputTokens ?? 0,
            decodeTokens: usage.outputTokens ?? stats.decodeTokens ?? 0,
            turns: stats.turns ?? 0,
            steps: stats.steps ?? 0,
          };
        }
      } catch { s = null; }
      if (!s) s = store.stats || {};
      const totalIn = (s.cacheRead || 0) + (s.uncachedInput || 0);
      const hit = totalIn > 0 ? Math.round((s.cacheRead || 0) / totalIn * 100) : 0;
      const cur = {
        uncachedInput: s.uncachedInput || 0,
        cacheRead: s.cacheRead || 0,
        output: s.decodeTokens || 0,
      };
      lines.push(`当前会话（${store.meta?.sessionId?.slice(0, 20) ?? "?"}）`);
      lines.push(`  输入 ${(cur.uncachedInput / 1000).toFixed(1)}k 未缓存 + ${(cur.cacheRead / 1000).toFixed(1)}k 缓存读`);
      lines.push(`  输出 ${(cur.output / 1000).toFixed(1)}k | 缓存命中率 ${hit}%`);
      lines.push(`  估算成本 ${fmtUsd(costOf(cur, p))}（价格见 ~/.dsh/meter/pricing.json）`);
      lines.push(`  轮次 ${s.turns ?? 0} · 步骤 ${s.steps ?? 0}`);
      lines.push("");
      lines.push("近期会话（扫描 ~/.dsh/sessions，最多 12 个）：");
      const agg = { uncachedInput: 0, cacheRead: 0, output: 0 };
      let withUsage = 0;
      let scanned = 0;
      for (const s2 of recentSessions(12)) {
        scanned++;
        try {
          // H16: 每会话只解码前 64KB（近似聚合），不再全量解压整个文件
          const text = decodeSessionLog(readHead(s2.path));
          const u = usageFromEvents(parseEvents(text));
          agg.uncachedInput += u.uncachedInput;
          agg.cacheRead += u.cacheRead;
          agg.output += u.output;
          if (u.uncachedInput + u.cacheRead + u.output > 0) withUsage++;
        } catch { /* skip */ }
      }
      if (scanned === 0) {
        lines.push("  （无会话记录）");
      } else {
        lines.push(`  共 ${scanned} 会话，${withUsage} 个含 usage 数据（每会话仅解码前 64KB，近似值）`);
        lines.push(`  输入 ${(agg.uncachedInput / 1000).toFixed(1)}k + 缓存读 ${(agg.cacheRead / 1000).toFixed(1)}k，输出 ${(agg.output / 1000).toFixed(1)}k`);
        const aggHit = agg.uncachedInput + agg.cacheRead > 0 ? Math.round(agg.cacheRead / (agg.uncachedInput + agg.cacheRead) * 100) : 0;
        lines.push(`  聚合缓存命中率 ${aggHit}% | 估算成本 ${fmtUsd(costOf(agg, p))}`);
      }
      lines.push("");
      lines.push("提示: /meter 插件（dsh-meter）可出完整周报；/context 查看上下文占用");
      return { lines };
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

/** Tolerant line-based JSON parse (compact events may share a line). */
function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); continue; } catch { /* fall through */ }
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
  return events;
}

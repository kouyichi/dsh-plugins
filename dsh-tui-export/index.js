/**
 * dsh-tui-export — TUI brick: /export.
 *
 * Exports the CURRENT session to a markdown transcript under ~/.dsh/exports/.
 * Reads the session's own log (session.jsonl.zstd, multi-frame) via the same
 * tolerant decoder used by dsh-xray. Plain-text transcript: user messages,
 * assistant replies, tool call summaries, errors.
 *
 * @module dsh-tui-export
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-tui-export";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const EXPORTS_DIR = join(DSH_HOME, "exports");

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NOISE = ["<system-reminder>", "<system>", "The approval policy changed", "You are a coding agent"];

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

function collectText(v, out = []) {
  if (v == null) return out;
  if (typeof v === "string") { out.push(v); return out; }
  if (Array.isArray(v)) { for (const x of v) collectText(x, out); return out; }
  if (typeof v === "object") {
    if (typeof v.text === "string") out.push(v.text);
    for (const k of Object.keys(v)) {
      if (k === "type" || k === "role" || k === "name" || k === "id" || k === "ts" || k === "seq") continue;
      if (k === "content" || k === "text" || k === "message" || k === "data") collectText(v[k], out);
    }
  }
  return out;
}

function findSessionLog(sessionId) {
  if (!existsSync(SESSIONS_DIR)) return null;
  const target = String(sessionId || "");
  for (const ws of readdirSafe(SESSIONS_DIR)) {
    const wsDir = join(SESSIONS_DIR, ws);
    for (const s of readdirSafe(wsDir)) {
      if (!s.startsWith("session-")) continue;
      if (target && !s.includes(target.replace(/^session-/, ""))) continue;
      const log = join(wsDir, s, "session.jsonl.zstd");
      if (existsSync(log)) return log;
    }
  }
  return null;
}

function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}

/** 工具参数渲染：对象/数组用 JSON.stringify（G207 同步：避免 [object Object]）。 */
function fmtArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function renderTranscript(events, sessionId) {
  const out = [];
  out.push(`# 会话导出 ${sessionId}`);
  out.push("");
  for (const ev of events) {
    const type = ev.type;
    if (type === "user/message") {
      const texts = collectText(ev).map((t) => t.trim()).filter((t) => t && !NOISE.some((n) => t.startsWith(n)));
      if (texts.length) { out.push(`## 👤 ${texts[0]}`); out.push(""); }
    } else if (type === "assistant/message") {
      const texts = collectText(ev).map((t) => t.trim()).filter((t) => t && !t.startsWith("<"));
      if (texts.length) { out.push(texts.join("\n\n")); out.push(""); }
    } else if (type === "tool/call") {
      out.push(`- ⚙️ ${ev.data?.name}: \`${fmtArgs(ev.data?.arguments).slice(0, 200)}\``);
    } else if (type === "tool/result") {
      const content = ev.data?.content || [];
      if (Array.isArray(content)) {
        const bad = content.filter((c) => c && c.isError === true);
        if (bad.length) out.push(`  ❌ ${String(bad[0]?.text || bad[0]?.error || "").slice(0, 200)}`);
      }
    }
  }
  return out.join("\n");
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-export] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/export",
    description: "导出当前会话为 markdown",
    busySafe: true,
    async handler(full, ctl, store) {
      const sessionId = store.meta?.sessionId;
      const log = findSessionLog(sessionId);
      if (!log) {
        ctl.notice("error", "找不到当前会话日志（session 未落盘？）");
        return;
      }
      try {
        const events = parseEvents(decodeSessionLog(readFileSync(log)));
        const md = renderTranscript(events, sessionId);
        mkdirSync(EXPORTS_DIR, { recursive: true });
        // 本地时区时间戳（G202 同步：不用 UTC 的 toISOString），保持原命名风格
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const ts =
          `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
          `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const target = join(EXPORTS_DIR, `${basename(log).replace(".zstd", "")}-${ts}.md`);
        writeFileSync(target, md);
        ctl.notice("success", `已导出 ${(md.length / 1024).toFixed(1)} KB → ${target}`);
      } catch (err) {
        ctl.notice("error", `导出失败: ${err.message}`);
      }
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

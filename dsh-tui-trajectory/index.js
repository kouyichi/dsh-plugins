/**
 * dsh-tui-trajectory — TUI brick: /trajectory (extracted from the TUI core).
 *
 * Step-through of the current session: the panel reads store.get().events
 * (the TUI's own rendered event list — the brick gets the store via the
 * panel load() contract) and renders a compact per-entry timeline. Enter on
 * a row shows its full detail inline.
 *
 * @module dsh-tui-trajectory
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-tui-trajectory";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const SESSIONS_DIR = join(DSH_HOME, "sessions");
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解码 zstd 会话日志（多帧拼接），与 dsh-tui-usage 同款。 */
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

/** 按会话 id 定位日志文件：~/.dsh/sessions/<workspace>/<sessionId>/session.jsonl.zstd */
function findSessionLog(sessionId) {
  if (!sessionId || !existsSync(SESSIONS_DIR)) return null;
  for (const ws of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const log = join(SESSIONS_DIR, ws.name, sessionId, "session.jsonl.zstd");
    if (existsSync(log)) return log;
  }
  return null;
}

/**
 * P-04: 把会话文件里的原始事件归一化成面板同款 kind（与 dsh-tui-app
 * channel/events.js 的映射一致），合并 store.events 缺捕获的最新事件
 * （如最后一轮 assistant/message 与 turn-end）。callNames 用于跨事件
 * 还原 tool/call → tool/result 的名字。
 */
function normalizeRawEvent(ev, callNames) {
  const d = ev.data ?? {};
  switch (ev.type) {
    case "user/message": {
      if (d.source?.kind !== "user") return null;
      const text = (d.content ?? [])
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return text === "" ? null : { kind: "user", text };
    }
    case "assistant/chunk": {
      const c = d.chunk;
      if (c?.type === "text-delta" && c.text !== "") return { kind: "assistant-delta", text: c.text };
      if (c?.type === "reasoning-delta" && c.text !== "") return { kind: "assistant-delta", reasoning: c.text };
      return null;
    }
    case "assistant/message": {
      const text = (d.message?.content ?? [])
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return { kind: "assistant", text, id: d.message?.id };
    }
    case "tool/call": {
      const name = d.name;
      if (name !== undefined) callNames.set(d.callId, name);
      return { kind: "tool-start", id: d.callId, name, args: String(d.arguments ?? "").replace(/\s+/g, " ").trim().slice(0, 140) };
    }
    case "tool/result": {
      const name = callNames.get(d.message?.content?.[0]?.toolCallId) ?? d.name ?? "tool";
      if (d.error !== undefined) {
        return { kind: "tool-end", name, ok: false, preview: `${d.error.code ?? "error"}: ${d.error.message ?? "failed"}` };
      }
      const block = Array.isArray(d.message?.content) ? d.message.content[0] : d.message?.content;
      const raw = block?.type === "tool-result" ? block.content : block;
      let text;
      try { text = typeof raw === "string" ? raw : JSON.stringify(raw); } catch { text = String(raw); }
      text = text.replace(/\s+/g, " ").trim();
      return { kind: "tool-end", name, ok: true, preview: text.slice(0, 200) };
    }
    case "turn/start": return { kind: "turn-start" };
    case "turn/end": return { kind: "turn-end" };
    default: return null;
  }
}

/** 事件签名，用于 store.events 与文件事件去重。 */
function evSig(ev) {
  return `${ev.kind}|${ev.text ?? ""}|${ev.reasoning ?? ""}|${ev.name ?? ""}|${ev.args ?? ""}|${ev.preview ?? ""}|${ev.id ?? ""}|${ev.ok ?? ""}`;
}

/**
 * P-04: 合并 store.events 与当前会话文件尾部事件。
 * store.events 是 TUI 实时渲染的事件列表，最后一轮可能尚未捕获（批处理
 * 定时器未 flush 或面板在回合刚结束时打开）；文件里已持久化的事件补进来，
 * 已存在的按签名去重，幂等。
 */
function mergeFileEvents(storeEvents, sessionId) {
  const log = findSessionLog(sessionId);
  if (!log) return storeEvents;
  let text;
  try {
    // 单会话文件，全量解码可接受（多会话扫描才需要限制，见 usage H16）
    text = decodeSessionLog(readFileSync(log));
  } catch { return storeEvents; }
  const seen = new Set(storeEvents.map(evSig));
  const callNames = new Map();
  const extra = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    const norm = normalizeRawEvent(ev, callNames);
    if (!norm) continue;
    const s = evSig(norm);
    if (seen.has(s)) continue;
    seen.add(s);
    extra.push(norm);
  }
  return extra.length > 0 ? [...storeEvents, ...extra] : storeEvents;
}

/** P-04: load 与 confirm 共用同一份事件视图，保证序号空间一致。 */
function viewEvents(store) {
  return mergeFileEvents(store.events ?? [], store.meta?.sessionId);
}

function summarize(ev) {
  switch (ev.kind) {
    case "user": return `👤 ${String(ev.text ?? "").slice(0, 80)}`;
    case "assistant": return `🤖 ${String(ev.text ?? ev.reasoning ?? "").slice(0, 80)}`;
    // P-03: 实际事件 kind 是 tool-start/tool-end（非 tool/tool-result），补上图标
    case "tool-start": return `⚙️ ${ev.name ?? "?"} ${String(ev.args ?? "").slice(0, 60)}`;
    case "tool-end": return `↩ ${ev.ok === false ? "✗" : "✓"} ${String(ev.preview ?? ev.text ?? "").slice(0, 60)}`;
    case "turn-start": return `▶ 回合开始`;
    case "turn-end": return `■ 回合结束`;
    case "reasoning": return `🤔 ${String(ev.text ?? "").slice(0, 80)}`;
    case "notice": return `⚠ ${String(ev.text ?? "").slice(0, 80)}`;
    default: return `${ev.kind ?? "?"} ${String(ev.text ?? "").slice(0, 80)}`;
  }
}

/** P-03: 把 token 级 assistant-delta 流合并为消息级条目；合并出的 buf 必须带 kind: "assistant"（缺了会显示 "? 收到"）。 */
function collapseEvents(events) {
  const collapsed = [];
  let buf = null;
  for (const ev of events) {
    if (ev.kind === "assistant-delta") {
      if (!buf) { buf = { kind: "assistant", text: "", reasoning: "" }; collapsed.push(buf); }
      if (ev.text) buf.text += ev.text;
      if (ev.reasoning) buf.reasoning += ev.reasoning;
    } else {
      buf = null;
      collapsed.push(ev);
    }
  }
  return collapsed;
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-trajectory] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/trajectory",
    description: "工具调用轨迹",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("trajectory");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "trajectory",
    title: "轨迹 / trajectory",
    load(store) {
      // P-04: 合并 store.events 与会话文件尾部事件（补最后一轮），再折叠 delta 流
      const events = viewEvents(store);
      if (events.length === 0) {
        return { lines: ["当前会话还没有事件。", "", "提示: 发消息后本面板显示完整轨迹（含工具调用与思考）"] };
      }
      // Collapse the token-level assistant-delta stream into message-level
      // entries so the trajectory reads as steps, not text fragments.
      const collapsed = collapseEvents(events);
      const lines = [`当前会话 ${collapsed.length} 条事件（enter 看详情）`, ""];
      collapsed.slice(-100).forEach((ev, i) => {
        lines.push(`[${String(i + 1).padStart(3, " ")}] ${summarize(ev)}`);
      });
      return { lines };
    },
    confirm(line, ctl, store) {
      const m = line?.match(/^\[(\d+)\]\s+/);
      if (!m) return;
      const idx = parseInt(m[1], 10) - 1;
      // 与 load 同一份事件视图 + 折叠逻辑，保证序号空间一致
      const collapsed = collapseEvents(viewEvents(store));
      const ev = collapsed.slice(-100)[idx];
      if (!ev) return;
      const detail = ev.text ?? ev.reasoning ?? ev.args ?? ev.preview ?? JSON.stringify(ev).slice(0, 300);
      ctl.notice("info", `事件 ${idx + 1} 详情:\n${String(detail).slice(0, 1500)}`);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

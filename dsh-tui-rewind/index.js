/**
 * dsh-tui-rewind — TUI brick: double-Esc time travel + /rewind + fork.
 *
 * Ports ccch1mneyyy/dsh-TUI's "double-tap esc to rewind" (1877★) onto the
 * local brick seam (tuiExtensions) and the real dsh kernel fork API.
 *
 * Semantics (each rule traced to its source):
 *  - Picker lists the session's USER messages, newest first; Enter on a row
 *    opens a confirm menu (rewind | fork | back).
 *    Source: competitor src/components/RewindPicker.tsx (rows newest-first,
 *    confirm pane with the built-in conversation-only rewind as option zero).
 *  - Event order is `turn/start → user/message → … → turn/end`, so a
 *    message's own seq always sits INSIDE its turn; forking there hits the
 *    kernel's OPEN_TURN guard (SessionStore._forkSeed,
 *    @deepseek-ai/dsh-session lib/index.js:1869-1871).
 *    Source: competitor src/dsh-adapter/channel.ts:2097-2113 — walk backward
 *    from the message seq; first turn/start found ⇒ boundary = turnStart.seq-1
 *    ("rewind to just BEFORE the message's turn/start: the conversation
 *    restarts at that point and the message itself comes back into the input").
 *  - rewind ⇒ fork boundary = turnStart.seq - 1 (message NOT included; it is
 *    meant to be re-sent). fork ⇒ boundary = the message's turn/end (branch
 *    keeps the message and its reply).
 *  - The branch is created by the kernel's `sessions.fork(source, boundary)`
 *    which seeds a NEW live child session and writes header lineage
 *    `parentSession` + `seedLength` — the competitor's documented branch
 *    shape ("/rewind 产生的回溯分支…只写 parentSession 而不写 origin",
 *    docs/interaction.md:91). Kernel fork is the ONLY time-travel primitive:
 *    sessions are append-only, no truncate/rewind API exists anywhere in
 *    @deepseek-ai/dsh-session, dsh-agent, or dsh-agent-loop (grep-verified).
 *  - Local limitation (brick seam): the TUI core owns the agent handle and
 *    the input buffer (app closures), so the fork cannot be attached to the
 *    running agent and the message cannot be pushed back into the input.
 *    Continue path: `dsh --profile tui --resume <childId>` — the launcher
 *    documents this exact flow (dsh-tui-app/lib/startup.js:11). The brick
 *    flushes the child so the persistence layer materializes its log
 *    (PersistenceCoordinator.initFor snapshots the full log incl. seed
 *    events on session/created, dsh-session-persistence lib/index.js:1155-1168).
 *
 * Panel contract: plain-text lines (no ANSI), ↑↓ select / enter confirm /
 * esc close (ext-panel convention, dsh-tui-app/lib/components/ext-panel.js).
 *
 * @module dsh-tui-rewind
 */

export const name = "dsh-tui-rewind";
export const inject = ["tuiExtensions"];

const PANEL_ID = "rewind";

/** Module state survives between panel loads; rebuilt on every open. */
let pending = null;    // {seq, text, when, rewindBoundary, forkBoundary, canRewind, canFork}
let showActions = false; // load() renders the action menu iff true

/** Flat one-line preview of a message (newlines collapsed, capped). */
function preview(text, cap = 90) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

/** Join the text blocks of a kernel message event payload. */
function textOf(content) {
  return (content ?? [])
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** Extract the real user text of a user/message event (channel filter parity). */
function userText(data) {
  if (!data || typeof data !== "object") return "";
  if (data.source?.kind !== "user") return "";
  return (textOf(data.content) || textOf(data.message?.content) || "").trim();
}

/** 本地时区 HH:MM:SS（G202）；缺失/非法时间戳回退当前时间（G203）。 */
const hhmmss = (ms) => {
  const t = Number(ms);
  const d = new Date(Number.isFinite(t) ? t : Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * Locate the array index of an event by its seq. Events are traversed by
 * ARRAY POSITION, never by assuming seq === index (H22: seq may have gaps
 * or drift from the index).
 */
function indexOfSeq(events, seq) {
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq === seq) return i;
  }
  return -1;
}

/**
 * Walk backward from the message's array position (competitor
 * channel.ts:2102-2113): first turn/start ⇒ rewind boundary = turnStart.seq
 * - 1; first turn/end ⇒ boundary stays at the message seq (message between
 * turns — cannot happen with the local loop, kept for parity).
 */
function rewindBoundaryOf(events, msgSeq) {
  let boundary = msgSeq;
  const start = indexOfSeq(events, msgSeq);
  if (start < 0) return boundary;
  for (let i = start; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "turn/start") { boundary = ev.seq - 1; break; }
    if (ev.type === "turn/end") break;
  }
  return boundary;
}

/** Fork boundary that keeps the message: the turn/end closing its turn. */
function forkBoundaryOf(events, msgSeq) {
  const start = indexOfSeq(events, msgSeq);
  if (start < 0) return null;
  for (let i = start + 1; i < events.length; i++) {
    if (events[i].type === "turn/end") return events[i].seq;
    if (events[i].type === "turn/start") break; // next turn opened — no close
  }
  return null; // turn still open (only possible for a mid-flight last turn)
}

/** Index the current session's user messages newest-first. */
function collectMessages(store, sessionsSvc) {
  const out = [];
  const sess = sessionsSvc?.get?.(store?.meta?.sessionId);
  if (!sess || !Array.isArray(sess.events)) return { events: [], messages: [] };
  const events = sess.events;
  for (const ev of events) {
    if (ev.type !== "user/message") continue;
    const text = userText(ev.data);
    if (!text) continue;
    const rw = rewindBoundaryOf(events, ev.seq);
    const fk = forkBoundaryOf(events, ev.seq);
    out.push({
      seq: ev.seq,
      text,
      when: Number.isFinite(Number(ev.time)) ? Number(ev.time) : Date.now(), // G203 容错
      rewindBoundary: rw,
      canRewind: rw >= 0,
      forkBoundary: fk,
      canFork: fk !== null,
    });
  }
  out.reverse(); // newest first, like the competitor picker
  return { events, messages: out };
}

let sessionsSvc = null;

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-rewind] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  // Resolved lazily on every use: the sessions service must be live when the
  // panel loads / a fork runs, not necessarily when this brick activates.
  const getSessions = () => ctx.get("sessions");

  const disposers = [];

  const openPanel = (ctl) => {
    pending = null;
    showActions = false;
    ctl.openExtPanel(PANEL_ID);
  };

  disposers.push(ext.registerCommand({
    name: "/rewind",
    description: "时间回溯：回到历史消息继续或 fork 分支会话",
    busySafe: false, // rewind is a session-level operation — idle only
    handler(full, ctl) {
      openPanel(ctl);
    },
  }));

  // Double-Esc (input empty + idle + not vim — the app already gates this:
  // dsh-tui-app/lib/runtime/input.js:354-363).
  disposers.push(ext.addInputHook({
    onDoubleEsc: ({ ctl }) => {
      openPanel(ctl);
      // H01: 返回 true = 已消费 —— app 侧 ctl.doubleEsc 遇第一个 true 即短路；
      // history 砖的 onDoubleEsc 检测到 /rewind 已注册时会返回 false 让位。
      return true;
    },
  }));

  disposers.push(ext.registerPanel({
    id: PANEL_ID,
    title: "时间回溯 / rewind",
    load(store) {
      if (showActions && pending) {
        const p = pending;
        const lines = [];
        lines.push(`已选择 [${p.seq}] ${hhmmss(p.when)} ${preview(p.text, 70)}`);
        lines.push("");
        lines.push("[1] ⏪ rewind — 回退到此消息继续（fork 分支会话，消息不包含在内）");
        lines.push("[2] ⑂ fork — 分支会话从此消息继续（含该消息与回复）");
        lines.push("[3] ↩ 返回消息列表");
        lines.push("");
        lines.push("提示: 分支会话 = 内核 fork（parentSession 血缘）；原会话不修改（append-only）");
        return { lines };
      }
      const { events, messages } = collectMessages(store, getSessions()); // G201: 补 sessionsSvc 参数（列表为空的根因）
      if (events.length === 0) {
        return {
          lines: [
            "当前会话还没有事件。",
            "",
            "提示: 发消息后本面板可回到历史任意一条用户消息（双击 Esc / /rewind 打开）",
          ],
        };
      }
      if (messages.length === 0) {
        return { lines: ["（当前会话没有可回退的用户消息）"] };
      }
      const lines = [];
      lines.push(`当前会话 ${String(store?.meta?.sessionId ?? "?").slice(0, 20)} · ${messages.length} 条用户消息（enter 选择）`);
      lines.push("");
      for (const m of messages) {
        let row = `[${m.seq}] ${hhmmss(m.when)} ${preview(m.text)}`;
        if (!m.canRewind) row += " （会话首条之前无内容，不可 rewind）";
        else if (!m.canFork) row += " （该轮次尚未结束，不可 fork）";
        lines.push(row);
      }
      lines.push("");
      lines.push("提示: 双击 Esc 或 /rewind 打开本面板；rewind 回到消息之前，fork 保留消息与回复");
      return { lines };
    },
    confirm(line, ctl, store) {
      if (showActions && pending) {
        const m = line?.match(/^\[(\d)\]\s/);
        if (!m) return;
        if (m[1] === "3") {
          pending = null;
          showActions = false;
          ctl.openExtPanel(PANEL_ID);
          return;
        }
        const kind = m[1] === "1" ? "rewind" : "fork";
        const p = pending;
        pending = null;
        showActions = false;
        doFork(ctl, store, p, kind);
        return;
      }
      // list mode: "[<seq>] HH:MM:SS text"
      const m = line?.match(/^\s*\[(\d+)\]\s+\d\d:\d\d:\d\d\s/);
      if (!m) return;
      const seq = parseInt(m[1], 10);
      const { messages } = collectMessages(store, getSessions()); // G201: 同上
      const info = messages.find((x) => x.seq === seq);
      if (!info) return;
      pending = info;
      showActions = true;
      ctl.openExtPanel(PANEL_ID);
    },
  }));

  /**
   * Kernel-backed rewind/fork: sessions.fork(source, boundary) seeds a new
   * live child session through the closed-turn boundary, then we flush it so
   * the JSONL persistence layer materializes the branch log (resumable via
   * `dsh --profile tui --resume <childId>`).
   */
  function doFork(ctl, store, info, kind) {
    const sessions = getSessions(); // G201: 原来调用未定义的 nullishSessions()，改走懒加载的 getSessions
    const cur = sessions?.get?.(store?.meta?.sessionId);
    if (!sessions || !cur) {
      ctl.notice("error", "会话服务不可用（当前运行环境无 sessions 服务）");
      return;
    }
    const boundary = kind === "rewind" ? info.rewindBoundary : info.forkBoundary;
    if (boundary === null || boundary < 0) {
      ctl.notice("warning", `${kind === "rewind" ? "回退" : "fork"}不可用：该消息${kind === "rewind" ? "是会话首条（之前无内容）" : "所在轮次尚未结束"}`);
      return;
    }
    let child;
    try {
      child = sessions.fork(cur, boundary);
    } catch (err) {
      ctl.notice("error", `fork 失败: ${err.message}`);
      return;
    }
    // Persist the branch so it is resumable (flush = durability checkpoint).
    try {
      sessions.flush?.(child)?.catch?.((e) => ctl.notice("warning", `分支会话落盘失败: ${e.message}`));
    } catch (e) {
      ctl.notice("warning", `分支会话落盘失败: ${e.message}`);
    }
    ctl.closeExtPanel();
    const childId = child.id;
    const parentId = String(store?.meta?.sessionId ?? "?").slice(0, 12);
    const seedN = child.events?.length ?? 0;
    if (kind === "rewind") {
      ctl.notice("info",
        `⏪ 已回退到 ${hhmmss(info.when)} 的消息之前：分支会话 ${childId}（seedLength ${seedN}，父 ${parentId}）。` +
        `原消息未含在分支内，请手动重发：${preview(info.text, 50)}。` +
        `继续: 退出后 dsh --profile tui --resume ${childId}`);
    } else {
      ctl.notice("info",
        `⑂ 已从 ${hhmmss(info.when)} 的消息 fork 分支会话 ${childId}（seedLength ${seedN}，父 ${parentId}，含该消息与回复）。` +
        `继续: 退出后 dsh --profile tui --resume ${childId}`);
    }
  }

  ctx.effect(() => () => {
    pending = null;
    showActions = false;
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

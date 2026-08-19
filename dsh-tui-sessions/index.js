/**
 * dsh-tui-sessions — TUI brick: 会话工作流命令与 /resume 会话浏览器。
 *
 * 移植自 ccch1mneyyy/dsh-TUI（1.8k★）的会话工作流语义，按本机积木砖模式实现：
 *   /rename <新名>        重命名当前会话（session/title 事件写入会话日志）
 *   /clear                清空会话视图（只清显示，agent 历史与会话日志保留）
 *   /trace                事件级时间线面板（原始事件，含 delta/思考/工具事件）
 *   /workspace [resume|rename <名>|open <目标>]   工作区管理
 *   /resume [--all] [--sub] [关键词]              会话浏览器（跨项目/搜索/预览/折叠子代理）
 *
 * 语义来源（竞品源码，非推断）：
 *   - /rename:  src/screens/Chat.tsx case 'rename' → channel.renameSession
 *               （agent.session.append('session/title', {title})）；持久化会话改名
 *               用 src/dsh-adapter/compat/sessionLog.ts appendSessionTitle
 *               （追加一个 zstd 帧，seq = maxSeq+1，last-title-wins）。
 *   - /clear:   Chat.tsx case 'clear' → channel.clear()：只清视图行 + "Session
 *               cleared" 提示，会话保持持久化（/new 注释：非破坏性，/resume 可恢复）。
 *   - /trace:   Chat.tsx case 'trace' → openScene()（轨迹场景，会话事件时间线）。
 *   - /workspace: Chat.tsx case 'workspace' → resume（工作区选择器）/ rename（
 *               workspaceRegistry.setTitle）/ open（resolveWorkspace → 切换）。
 *   - /resume:  SessionBrowser.tsx：默认当前项目、MRU 排序、实时搜索、子代理默认
 *               折叠并在顶栏计数、Tab 预览尾部往来、Enter 恢复。
 *   - 摘要/标题: src/dsh-adapter/sessions/digest.ts（head 64KB + tail 128KB 定界
 *               窗口；标题分级: renamed > auto(provider) > 首条提示 > 目录名）。
 *   - 分类:     src/dsh-adapter/sessions/header.ts classify（origin==='subagent'
 *               是子代理运行；只写 parentSession 的是 fork）。
 *
 * 面板为纯文本 lines（无 ANSI），confirm 仅支持 Enter（↑↓ 导航、esc 关闭）——
 * 竞品的实时输入搜索/ctrl+a/ctrl+s 等按键折叠为本砖的命令行参数过滤
 * （/resume --all / --sub / 关键词），交互差异见报告。
 *
 * @module dsh-tui-sessions
 */

import {
  readFileSync, readdirSync, statSync, appendFileSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { join, basename, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

export const name = "dsh-tui-sessions";
export const inject = ["tuiExtensions"];

/** ESM import 提升坑：路径必须函数内现算（惰性 getter），不能顶层求值。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 头部窗口预算（竞品 digest.ts HEAD_WINDOW_BYTES）。 */
const HEAD_WINDOW_BYTES = 64 * 1024;
/** 尾部窗口预算（竞品 digest.ts TAIL_WINDOW_BYTES）。 */
const TAIL_WINDOW_BYTES = 128 * 1024;
/** 预览单条消息最长保留字符数（竞品 PREVIEW_CHARS）。 */
const PREVIEW_CHARS = 400;
/** 面板最多列出的会话行数（纯文本面板的展示上限）。 */
const MAX_ROWS = 200;

/* ------------------------------------------------------------------ *
 * 多帧 zstd 会话日志解码（同 dsh-tui-usage 的 decodeSessionLog）      *
 * ------------------------------------------------------------------ */

function decodeSessionLog(buf) {
  const chunks = [];
  let remaining = buf;
  let guard = 0;
  while (remaining.length > 0 && guard++ < 4096) {
    try {
      chunks.push(zstdDecompressSync(remaining));
    } catch {
      break; // 帧被窗口截断：保留已解出的完整帧
    }
    const idx = remaining.indexOf(ZSTD_MAGIC, 1);
    if (idx < 0) break;
    remaining = remaining.subarray(idx);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 尾部窗口可能从某个帧的中间开始：先定位第一个帧魔数再解。 */
function decodeTailWindow(buf) {
  const idx = buf.indexOf(ZSTD_MAGIC);
  if (idx < 0) return [];
  return decodeSessionLog(buf.subarray(idx));
}

/** 定界读取：head 窗口（文件头 64KB）+ tail 窗口（文件尾 128KB）。 */
function readWindows(path, size) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, HEAD_WINDOW_BYTES));
    readSync(fd, head, 0, head.length, 0);
    if (size <= HEAD_WINDOW_BYTES) return { head, whole: true, tail: undefined };
    const len = Math.min(size, TAIL_WINDOW_BYTES);
    const tail = Buffer.alloc(len);
    readSync(fd, tail, 0, len, size - len);
    return { head, whole: false, tail };
  } finally {
    closeSync(fd);
  }
}

/** 容错行级 JSON 解析（与 dsh-tui-usage 相同）。 */
function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
      continue;
    } catch {
      /* fall through */
    }
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
  return events;
}

/* ------------------------------------------------------------------ *
 * 会话摘要（竞品 digest.ts 的本地移植：标题/模型/首条提示/预览）      *
 * ------------------------------------------------------------------ */

function textOfContent(content) {
  if (typeof content === "string") {
    const t = content.trim();
    return t || undefined;
  }
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string" && block.text.trim().length > 0) return block.text.trim();
  }
  return undefined;
}

/** 是否人敲的 user 消息（竞品 isHumanSource：source 缺失也算人）。 */
function isHumanSource(source) {
  if (source === undefined || source === null) return true;
  if (typeof source !== "object") return false;
  return source.kind === "user";
}

/** 一行日志里的人话首条提示（user/message 或 agent/inbox/spliced 两种形态）。 */
function humanPrompt(line) {
  const data = line?.data;
  if (!data || typeof data !== "object") return undefined;
  if (line.type === "user/message") {
    return isHumanSource(data.source) ? textOfContent(data.content) : undefined;
  }
  if (line.type === "agent/inbox/spliced") {
    const inserted = data.inserted;
    if (!Array.isArray(inserted)) return undefined;
    for (const message of inserted) {
      if (!message || typeof message !== "object") continue;
      if (message.role !== "user" || !isHumanSource(message.source)) continue;
      const text = textOfContent(message.content);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/** session/title 事件 → {text, source: 'auto'|'renamed'}（竞品 titleOf）。 */
function titleOf(line) {
  if (line?.type !== "session/title") return undefined;
  const data = line.data;
  if (!data || typeof data !== "object") return undefined;
  const text = data.title;
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const source = data.source;
  const byProvider = source !== null && typeof source === "object" && source.kind === "provider";
  return { text: text.trim(), source: byProvider ? "auto" : "renamed" };
}

/** request/context 事件里的路由模型（竞品 modelOf）。 */
function modelOf(line) {
  if (line?.type !== "request/context") return undefined;
  const model = line.data?.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/** 子代理运行标签（subagent/descriptor）。 */
function labelOf(line) {
  if (line?.type !== "subagent/descriptor") return undefined;
  const label = line.data?.label;
  return typeof label === "string" && label.trim().length > 0 ? label.trim() : undefined;
}

/**
 * 定界窗口摘要：head（首条提示/首个标题/子代理标签）+ tail（最新标题/模型）。
 * 标题分级: renamed > auto > 首条提示摘录 > 目录名（fallback）。
 * 不可读的日志仍给出可用记录（目录名标题 + hasPrompt=true，竞品同款策略）。
 */
function digestSession(path, cwd) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return {
      title: { text: basename(cwd || "") || "?", source: "fallback" },
      hasPrompt: true, firstPrompt: undefined, model: undefined, label: undefined,
    };
  }
  let windows;
  try {
    windows = readWindows(path, size);
  } catch {
    return {
      title: { text: basename(cwd || "") || "?", source: "fallback" },
      hasPrompt: true, firstPrompt: undefined, model: undefined, label: undefined,
    };
  }
  const headLines = parseEvents(decodeSessionLog(windows.head));

  let prompt;
  let headTitle;
  let label;
  for (const line of headLines) {
    prompt ??= humanPrompt(line);
    headTitle ??= titleOf(line);
    label ??= labelOf(line);
  }
  // 窗口没盖住全文件 = 里面必然有对话（竞品 hasPrompt 判定）
  const hasPrompt = prompt !== undefined || !windows.whole;

  const tailLines = windows.tail === undefined ? headLines : parseEvents(decodeTailWindow(windows.tail));
  let tailTitle;
  let model;
  for (const line of tailLines) {
    const t = titleOf(line);
    if (t !== undefined) tailTitle = t;
    const route = modelOf(line);
    if (route !== undefined) model = route;
  }

  const resolved = tailTitle ?? headTitle ??
    (prompt === undefined ? undefined : { text: prompt, source: "prompt" });

  return {
    title: resolved ?? { text: basename(cwd || "") || "?", source: "fallback" },
    hasPrompt,
    firstPrompt: prompt,
    model,
    label,
  };
}

/** 尾部窗口的最后几轮往来（竞品 previewSession）。 */
function previewSession(path, limit) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size <= HEAD_WINDOW_BYTES) {
    // 小文件：头即尾，直接全解（定界窗口的 whole 分支）
    try {
      return collectPreview(parseEvents(decodeSessionLog(readFileSync(path))), limit);
    } catch {
      return [];
    }
  }
  try {
    const windows = readWindows(path, size);
    return collectPreview(parseEvents(decodeTailWindow(windows.tail)), limit);
  } catch {
    return [];
  }
}

function collectPreview(events, limit) {
  const entries = [];
  for (const line of events) {
    const data = line?.data;
    if (!data || typeof data !== "object") continue;
    if (line.type === "user/message") {
      if (!isHumanSource(data.source)) continue;
      const text = textOfContent(data.content);
      if (text !== undefined) entries.push({ role: "user", text: text.slice(0, PREVIEW_CHARS), at: line.time });
      continue;
    }
    if (line.type === "assistant/message") {
      const message = data.message;
      if (!message || typeof message !== "object") continue;
      const text = textOfContent(message.content);
      if (text !== undefined) entries.push({ role: "assistant", text: text.slice(0, PREVIEW_CHARS), at: line.time });
    }
  }
  return entries.slice(-limit);
}

/** 追加 session/title 事件到持久化会话日志（竞品 compat/sessionLog.ts 移植：
 * 新 zstd 帧 O_APPEND 追加，seq = maxSeq+1，last-title-wins，永不改写旧字节）。
 * maxSeq 只读尾部窗口（最后 APPEND_TAIL_BYTES 字节）——seq 随追加单调递增，
 * 最大 seq 必在文件尾部，无需全量读+解压。 */
const APPEND_TAIL_BYTES = 64 * 1024;

function appendSessionTitle(sessionId, title) {
  try {
    const file = findSessionLogFile(sessionId);
    if (!file) return "unavailable";
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return "unavailable";
    }
    let events = [];
    const tailBytes = Math.min(size, APPEND_TAIL_BYTES);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(tailBytes);
    readSync(fd, buf, 0, tailBytes, size - tailBytes);
    closeSync(fd);
    events = parseEvents(decodeTailWindow(buf));
    if (events.length === 0 && size > tailBytes) {
      // 极端情况：最后一帧大于窗口导致窗口内无完整帧魔数 → 回退全量读保 seq 正确
      events = parseEvents(decodeSessionLog(readFileSync(file)));
    }
    let maxSeq = -1;
    for (const event of events) {
      if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
    }
    const event = {
      type: "session/title",
      seq: maxSeq + 1,
      time: Date.now(),
      data: { title },
    };
    const frame = zstdCompressSync(Buffer.from(JSON.stringify(event) + "\n", "utf8"));
    appendFileSync(file, frame);
    return "appended";
  } catch {
    return "unavailable";
  }
}

/* ------------------------------------------------------------------ *
 * 会话枚举（竞品 sessions/list.ts + header.ts 的本地移植）            *
 * ------------------------------------------------------------------ */

/** 会话日志索引缓存：sessionId → 日志路径。listSessions 每会话调一次
 * findSessionLogFile，逐会话全目录扫描是 O(N×M)；改为单次 readdirSync 全扫建
 * Map 后 O(1) 复用。失效：sessions 根目录 mtime 变化（增删工作区/会话目录）+
 * TTL 兜底（子目录内新建会话不改根 mtime）。 */
let sessionLogIndexCache = undefined;
let sessionLogIndexToken = "";
let sessionLogIndexBuiltAt = 0;
const SESSION_INDEX_TTL_MS = 3000;

function buildSessionLogIndex() {
  const root = join(dshHome(), "sessions");
  let rootStat = undefined;
  try {
    rootStat = statSync(root);
  } catch {
    /* root 缺失 → 空索引 */
  }
  const token = rootStat ? `${rootStat.mtimeMs}:${rootStat.size}` : "missing";
  const now = Date.now();
  if (
    sessionLogIndexCache !== undefined &&
    sessionLogIndexToken === token &&
    now - sessionLogIndexBuiltAt < SESSION_INDEX_TTL_MS
  ) {
    return sessionLogIndexCache;
  }
  const index = new Map();
  if (rootStat) {
    let wsDirs = [];
    try {
      wsDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      /* keep empty */
    }
    for (const ws of wsDirs) {
      let dirs = [];
      try {
        dirs = readdirSync(join(root, ws.name), { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const d of dirs) {
        const p = join(root, ws.name, d.name, "session.jsonl.zstd");
        try {
          if (statSync(p).isFile()) index.set(d.name, p);
        } catch {
          /* skip */
        }
      }
    }
  }
  sessionLogIndexCache = index;
  sessionLogIndexToken = token;
  sessionLogIndexBuiltAt = now;
  return index;
}

/** 在 ~/.dsh/sessions/<workspace>/<id>/session.jsonl.zstd 里定位会话日志（走索引缓存）。 */
function findSessionLogFile(sessionId) {
  return buildSessionLogIndex().get(String(sessionId));
}

/** 分类（竞品 classify）：origin==='subagent' → 子代理运行；只写 parentSession
 * 的是 fork（rewind/模型切换的分支会话）；其余为根会话。 */
function classify(header) {
  if (header.origin === "subagent") {
    return { kind: "subagent", parent: header.parentSession, depth: header.delegationDepth ?? 1 };
  }
  if (header.parentSession !== undefined) return { kind: "fork", parent: header.parentSession };
  return { kind: "root" };
}

/** 摘要缓存：日志 append-only，size:mtime 不变即可复用派生结果（竞品
 * store.ts 的进程内简化版，不做磁盘索引）。上限 DIGEST_CACHE_MAX 条，
 * 超出按 LRU 淘汰最旧（Map 迭代序 = 插入序）。 */
const digestCache = new Map();
const DIGEST_CACHE_MAX = 200;

function digestCached(path, cwd) {
  try {
    const st = statSync(path);
    const token = `${st.size}:${st.mtimeMs}`;
    const hit = digestCache.get(path);
    if (hit && hit.token === token) {
      // LRU：命中即移到末尾（视为最新）
      digestCache.delete(path);
      digestCache.set(path, hit);
      return hit.value;
    }
    const value = digestSession(path, cwd);
    digestCache.set(path, { token, value });
    if (digestCache.size > DIGEST_CACHE_MAX) {
      const oldest = digestCache.keys().next().value;
      if (oldest !== undefined) digestCache.delete(oldest);
    }
    return value;
  } catch {
    return digestSession(path, cwd);
  }
}

function fileFacts(path) {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/** sessionPersistence.list() 兜底：直接扫描会话目录、只解首帧取 header。 */
function scanHeadersFallback() {
  const out = [];
  const root = join(dshHome(), "sessions");
  let wsDirs = [];
  try {
    wsDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const ws of wsDirs) {
    let dirs = [];
    try {
      dirs = readdirSync(join(root, ws.name), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = join(root, ws.name, d.name, "session.jsonl.zstd");
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      try {
        const fd = openSync(p, "r");
        const buf = Buffer.alloc(Math.min(st.size, HEAD_WINDOW_BYTES));
        readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        const firstLine = decodeSessionLog(buf).split("\n", 1)[0] ?? "";
        const h = JSON.parse(firstLine);
        if (h && typeof h.id === "string") {
          out.push({
            id: h.id,
            cwd: h.cwd,
            createdAt: h.createdAt,
            parentSession: h.parentSession,
            origin: h.origin,
            delegationDepth: h.delegationDepth,
            agentPreset: h.agentPreset,
          });
        }
      } catch {
        /* 首帧不可读的日志跳过 */
      }
    }
  }
  return out;
}

/**
 * 全量会话摘要：每个持久化会话一条完整记录（含子代理/空会话，如实标注）。
 * 排序: updatedAt desc → createdAt desc → id asc（竞品 listSummaries 同款全序）。
 */
async function listSessions(ctx) {
  const persistence = ctx.get("sessionPersistence");
  let headers = [];
  if (persistence?.list) {
    try {
      headers = await persistence.list();
    } catch {
      headers = [];
    }
  }
  if (!Array.isArray(headers) || headers.length === 0) headers = scanHeadersFallback();

  const children = new Map();
  for (const h of headers) {
    if (h?.origin === "subagent" && h.parentSession !== undefined) {
      children.set(h.parentSession, (children.get(h.parentSession) ?? 0) + 1);
    }
  }

  const out = [];
  for (const h of headers) {
    if (!h || typeof h.id !== "string") continue;
    const path = findSessionLogFile(h.id);
    const digest = path === undefined ? undefined : digestCached(path, h.cwd ?? "");
    const facts = path === undefined ? undefined : fileFacts(path);
    out.push({
      id: h.id,
      cwd: h.cwd ?? "",
      createdAt: typeof h.createdAt === "number" ? h.createdAt : 0,
      updatedAt: Math.max(facts?.mtimeMs ?? 0, typeof h.createdAt === "number" ? h.createdAt : 0),
      bytes: facts?.size,
      kind: classify(h),
      title: digest?.title ?? { text: basename(h.cwd ?? "") || h.id.slice(0, 8), source: "fallback" },
      hasPrompt: digest?.hasPrompt ?? true,
      firstPrompt: digest?.firstPrompt,
      model: digest?.model,
      label: digest?.label,
      childCount: children.get(h.id) ?? 0,
    });
  }

  out.sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      b.createdAt - a.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return out;
}

/* ------------------------------------------------------------------ *
 * 小工具                                                              *
 * ------------------------------------------------------------------ */

function relTime(ms) {
  if (!ms) return "?";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
}

function fmtBytes(bytes) {
  if (!bytes) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const TITLE_SOURCE_LABEL = {
  renamed: "手动",
  auto: "自动",
  prompt: "首条提示",
  fallback: "目录名",
};

function liveAgent(ctx) {
  try {
    const agents = ctx.get("agents");
    if (!agents) return undefined;
    return agents.currentInitiator?.() ?? agents.roots?.()?.[0];
  } catch {
    return undefined;
  }
}

function sameProjectPath(a, b) {
  if (!a || !b) return !a && !b;
  try {
    return resolve(a) === resolve(b);
  } catch {
    return a === b;
  }
}

/** /workspace open 的目标解析（竞品 workspaces.ts parseLocalWorkspaceReference）：
 * 绝对路径 / file:// URI / 相对当前 cwd；~ 与 ~/… 先展开为用户主目录。 */
function resolveWorkspaceRef(reference, cwd) {
  if (reference === "~") return homedir();
  if (reference.startsWith("~/") || reference.startsWith("~\\")) {
    return join(homedir(), reference.slice(2));
  }
  if (isAbsolute(reference)) return resolve(reference);
  try {
    const u = new URL(reference);
    if (u.protocol === "file:") return fileURLToPath(u);
  } catch {
    /* not a URI */
  }
  return resolve(cwd, reference);
}

/* ------------------------------------------------------------------ *
 * 面板级共享状态（模块内；confirm 需要与 load 同一份数据）             *
 * ------------------------------------------------------------------ */

let lastResumeList = [];
let lastTraceList = [];
let lastWorkspaceList = [];
// 面板 async load 竞态防护：load 开始时清空遗留列表并递增 loadSeq，列表就绪时
// 记 readySeq；confirm 校验两序号一致才读取，避免读到上一次打开遗留的旧列表。
let resumeLoadSeq = 0;
let resumeReadySeq = 0;
let workspaceLoadSeq = 0;
let workspaceReadySeq = 0;

/* ------------------------------------------------------------------ *
 * apply                                                               *
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-sessions] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  /* ---------- /rename ---------- */
  disposers.push(ext.registerCommand({
    name: "/rename",
    description: "重命名当前会话（写 session/title 事件）",
    busySafe: false, // 会向会话日志追加事件
    handler(full, ctl, store) {
      const title = full.slice("/rename".length).trim();
      const agent = liveAgent(ctx);
      const session = agent?.session;
      if (!title) {
        let cur = "（未命名）";
        try {
          const st = ctx.get("sessionTitle");
          const snap = session && st?.get ? st.get(session) : undefined;
          if (snap?.title) cur = snap.title;
        } catch {
          /* keep fallback */
        }
        ctl.notice(
          "info",
          `当前会话标题: ${cur}\n用法: /rename <新名>（标题写入会话日志的 session/title 事件；手动命名后自动生成不再覆盖）`
        );
        return;
      }
      if (session) {
        try {
          const st = ctx.get("sessionTitle");
          if (st?.rename) {
            // 内核服务：规范化 + source:{kind:"user"} 固定标题
            st.rename(session, title);
          } else {
            // 竞品同款：直接追加 {title} 事件
            session.append("session/title", { title });
          }
          ctl.notice("info", `已重命名: ${title}`);
        } catch (e) {
          ctl.notice("error", `重命名失败: ${e.message}`);
        }
        return;
      }
      // 会话不在 live store（极端情况）→ 直接向持久化日志追加一帧
      const id = store.meta?.sessionId;
      if (!id) {
        ctl.notice("error", "找不到当前会话");
        return;
      }
      const ok = appendSessionTitle(id, title);
      ctl.notice(
        ok === "appended" ? "info" : "error",
        ok === "appended" ? `已重命名（直接落盘）: ${title}` : "重命名失败: 会话日志不可读"
      );
    },
  }));

  /* ---------- /clear ---------- */
  disposers.push(ext.registerCommand({
    name: "/clear",
    description: "清空会话视图（agent 历史与日志保留）",
    busySafe: true,
    handler(full, ctl, store) {
      // 只清 events 视图，保留 stats（轮次/耗时/token 统计是累计指标，不应被清屏重置）
      store.set({
        events: [],
        lastAssistantId: null,
      });
      ctl.notice(
        "info",
        "会话视图已清空（/clear 只清屏幕显示；agent 历史与会话日志保留，/resume 可恢复）"
      );
    },
  }));

  /* ---------- /trace ---------- */
  disposers.push(ext.registerCommand({
    name: "/trace",
    description: "事件级时间线面板（原始事件，含 delta/思考/工具）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("trace");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "trace",
    title: "事件时间线 / trace",
    load(store) {
      const events = store.events ?? [];
      if (events.length === 0) {
        return {
          lines: [
            "当前会话还没有事件。",
            "",
            "提示: 发消息后本面板显示事件级时间线（不合并 token 流，逐条原始事件）",
          ],
        };
      }
      lastTraceList = events.slice(-150);
      const lines = [
        `事件时间线 / trace — ${events.length} 条原始事件（enter 看详情）`,
        "",
      ];
      lastTraceList.forEach((ev, i) => {
        lines.push(`[${String(i + 1).padStart(3, " ")}] ${summarizeTrace(ev)}`);
      });
      lines.push("");
      lines.push(
        "提示: /trajectory 是步骤级回放（合并 assistant-delta 为消息级步骤）；" +
        "/trace 是事件级原始时间线（每个 delta/思考/工具/通知逐条列出）"
      );
      return { lines };
    },
    confirm(line, ctl) {
      const m = line?.match(/^\[\s*(\d+)\]\s+/);
      if (!m) return;
      const ev = lastTraceList[parseInt(m[1], 10) - 1];
      if (!ev) return;
      ctl.closeExtPanel();
      const detail =
        ev.kind === "tool"
          ? `⚙ ${ev.name ?? "?"}\n参数: ${fmtArgs(ev.args).slice(0, 1200)}`
          : String(ev.text ?? ev.reasoning ?? ev.preview ?? JSON.stringify(ev)).slice(0, 1500);
      ctl.notice("info", `${ev.kind ?? "?"}\n${detail}`);
    },
  }));

  /* ---------- /workspace ---------- */
  disposers.push(ext.registerCommand({
    name: "/workspace",
    description: "工作区管理: resume | rename <名称> | open <路径|file://URI>",
    busySafe: true,
    handler(full, ctl, store) {
      const trimmed = full.slice("/workspace".length).trim();
      const separator = trimmed.search(/\s/);
      const sub = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
      const input = separator < 0 ? "" : trimmed.slice(separator).trim();
      if (sub === "") {
        ctl.notice(
          "info",
          "用法: /workspace resume | rename <名称> | open <目标>\n" +
          "  resume      列出工作区（enter 查看进入/恢复命令）\n" +
          "  rename <名> 重命名当前工作区（workspaceRegistry.setTitle）\n" +
          "  open <目标> 打开其它目录（绝对路径 / 相对路径 / file:// URI）"
        );
        return;
      }
      if (sub === "resume") {
        if (input.length > 0) {
          ctl.notice("warning", `用法: /workspace resume 不接受参数（多余参数将被忽略: ${truncate(input, 60)}）`);
          return;
        }
        ctl.openExtPanel("workspace");
        return;
      }
      if (sub === "rename") {
        if (input.length === 0) {
          ctl.notice("warning", "用法: /workspace rename <名称>");
          return;
        }
        renameWorkspace(ctx, ctl, store, input);
        return;
      }
      if (sub === "open") {
        if (input.length === 0) {
          ctl.notice("warning", "用法: /workspace open <绝对路径|相对路径|file://URI>");
          return;
        }
        const cwd = store.meta?.cwd ?? process.cwd();
        const target = resolveWorkspaceRef(input, cwd);
        ctl.notice(
          "info",
          `打开工作区: ${target}\n本 TUI 不支持原位切换 cwd —— 进入方式:\n  cd ${target} && dsh --profile tui`
        );
        return;
      }
      ctl.notice("error", `未知子命令: /workspace ${sub}（可用: resume | rename | open）`);
    },
  }));

  disposers.push(ext.registerPanel({
    id: "workspace",
    title: "工作区 / workspace",
    async load(store) {
      const seq = ++workspaceLoadSeq;
      lastWorkspaceList = []; // 竞态防护：加载开始时清空，加载期间 confirm 无数据可读
      const reg = ctx.get("workspaceRegistry");
      const cwd = store.meta?.cwd;
      const entries = [];
      if (reg?.list) {
        try {
          for (const w of reg.list()) {
            if (!w || typeof w.path !== "string") continue;
            entries.push({ path: w.path, title: typeof w.title === "string" && w.title ? w.title : basename(w.path), live: false });
          }
        } catch {
          /* registry 不可读时退化到当前目录 */
        }
      }
      if (cwd && !entries.some((e) => sameProjectPath(e.path, cwd))) {
        entries.push({ path: cwd, title: basename(cwd), live: true });
      }
      let sessions = [];
      try {
        sessions = await listSessions(ctx);
      } catch {
        /* 计数不可用不影响列表 */
      }
      lastWorkspaceList = [];
      const lines = [
        `工作区 / workspace — ${entries.length} 个（enter 查看进入与恢复命令）`,
        "",
      ];
      entries.forEach((e, i) => {
        const mine = sessions.filter((s) => s.cwd && sameProjectPath(s.cwd, e.path));
        const latest = mine.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        lastWorkspaceList.push({ ...e, count: mine.length, latest: latest?.id });
        lines.push(`[${String(i + 1).padStart(2, " ")}] ${e.title}${e.live ? "   ← 当前" : ""}`);
        lines.push(
          `      ${e.path} · ${mine.length} 个会话` +
          (latest ? ` · 最新 ${latest.id.replace(/^session-/, "").slice(0, 18)}` : "")
        );
      });
      workspaceReadySeq = seq; // 列表就绪后才能被 confirm 读取
      lines.push("");
      lines.push("提示: /workspace rename <名称> 重命名当前工作区；/workspace open <目标> 打开其它目录");
      return { lines };
    },
    confirm(line, ctl) {
      if (workspaceReadySeq !== workspaceLoadSeq) return; // 异步加载未完成，忽略过期列表
      const m = line?.match(/^\[\s*(\d+)\]\s+/);
      if (!m) return;
      const w = lastWorkspaceList[parseInt(m[1], 10) - 1];
      if (!w) return;
      ctl.closeExtPanel();
      const parts = [`进入工作区「${w.title}」 (${w.path})`, `  cd ${w.path} && dsh --profile tui`];
      if (w.latest) parts.push(`  或恢复最近会话: dsh --profile tui --resume ${w.latest}`);
      ctl.notice("info", parts.join("\n"));
    },
  }));

  /* ---------- /resume 会话浏览器 ---------- */
  disposers.push(ext.registerCommand({
    name: "/resume",
    description: "会话浏览器（跨项目/关键词过滤/预览/折叠子代理）",
    busySafe: true,
    handler(full, ctl, store) {
      const args = full.slice("/resume".length).trim();
      let q = "";
      let all = false;
      let sub = false;
      for (const tok of args.split(/\s+/)) {
        if (!tok) continue;
        if (tok === "--all" || tok === "-a") all = true;
        else if (tok === "--sub" || tok === "-s") sub = true;
        else q += (q ? " " : "") + tok;
      }
      store.set({ sessionsQuery: q, sessionsAll: all, sessionsSub: sub });
      ctl.openExtPanel("resume");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "resume",
    title: "会话浏览器 / resume",
    async load(store) {
      const seq = ++resumeLoadSeq;
      lastResumeList = []; // 竞态防护：加载开始时清空，加载期间 confirm 无数据可读
      let sessions;
      try {
        sessions = await listSessions(ctx);
      } catch (err) {
        return { lines: [`会话列表加载失败: ${err.message}`] };
      }
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return {
          lines: [
            "（没有任何已持久化的会话）",
            "",
            "提示: 发过消息的会话会持久化到 ~/.dsh/sessions/<工作区>/；子代理运行为 runId 目录，也在此列出",
          ],
        };
      }

      const q = String(store.sessionsQuery ?? "").trim().toLowerCase();
      const all = !!store.sessionsAll;
      const sub = !!store.sessionsSub;
      const curCwd = store.meta?.cwd;

      // 范围过滤：默认当前项目（竞品 SessionBrowser 默认 sameProject）
      let visible = sessions.filter((s) => all || sameProjectPath(s.cwd, curCwd));
      // 关键词过滤：标题/目录/模型/首条提示（竞品搜索面，本地无 git 分支字段）
      if (q) {
        visible = visible.filter((s) =>
          [s.title?.text, s.cwd, s.model, s.firstPrompt]
            .filter(Boolean)
            .some((t) => String(t).toLowerCase().includes(q))
        );
      }

      const roots = visible.filter((s) => s.kind.kind !== "subagent");
      const subagents = visible.filter((s) => s.kind.kind === "subagent");
      const hiddenSub = sub ? 0 : subagents.length;
      // 空会话（无对话内容）只计数不列出（竞品同款）
      const empties = visible.filter((s) => s.hasPrompt === false);

      // 折叠/展开子代理：展开时挂在父会话下缩进（竞品 ctrl+s 行为）
      const rows = [];
      if (sub) {
        const placed = new Set();
        for (const root of roots) {
          rows.push(root);
          const kids = subagents.filter((s) => s.kind.parent === root.id);
          for (const kid of kids) {
            rows.push(kid);
            placed.add(kid.id);
          }
        }
        for (const kid of subagents) {
          if (!placed.has(kid.id)) rows.push(kid); // 父不在列表（跨项目隐藏）→ 独立列出
        }
      } else {
        rows.push(...roots);
      }
      const listed = rows.filter((s) => s.hasPrompt !== false).slice(0, MAX_ROWS);

      lastResumeList = listed;
      resumeReadySeq = seq; // 列表就绪后才能被 confirm 读取
      const lines = [];
      lines.push(
        `会话浏览器 — 共 ${sessions.length} · 显示 ${listed.length}` +
        (hiddenSub > 0 ? ` · 子代理 ${hiddenSub} 个已折叠（--sub 展开）` : "") +
        (empties.length > 0 ? ` · 空会话 ${empties.length} 个不列出` : "")
      );
      lines.push(
        `范围: ${all ? "全部项目" : (curCwd ?? "?")}` +
        (q ? ` · 搜索: "${store.sessionsQuery}"` : "") +
        (sub ? " · 子代理: 展开" : "")
      );
      lines.push("");

      let lastGroup = undefined;
      listed.forEach((s, i) => {
        if (all) {
          const group = s.cwd || "（无 cwd）";
          if (group !== lastGroup) {
            lines.push(`── ${group} ──`);
            lastGroup = group;
          }
        }
        const isSub = s.kind.kind === "subagent";
        const title = (isSub ? "  └ " : "") + truncate((s.label ? `[${s.label}] ` : "") + (s.title?.text ?? s.id), 52);
        lines.push(`[${String(i + 1).padStart(3, " ")}] ${title}`);
        const facts = [
          isSub ? "子代理运行" : "",
          s.model,
          relTime(s.updatedAt),
          s.bytes !== undefined ? fmtBytes(s.bytes) : "",
          s.childCount > 0 ? `子代理×${s.childCount}` : "",
          s.firstPrompt ? `首条: ${truncate(s.firstPrompt.replace(/\s+/g, " "), 40)}` : "",
        ].filter(Boolean);
        lines.push(`      ${facts.join(" · ")}`);
      });

      lines.push("");
      lines.push("提示: /resume [--all] [--sub] [关键词] 重新过滤；enter 查看摘要与恢复命令；esc 关闭");
      return { lines };
    },
    confirm(line, ctl, store) {
      if (resumeReadySeq !== resumeLoadSeq) return; // 异步加载未完成，忽略过期列表
      const m = line?.match(/^\[\s*(\d+)\]\s+/);
      if (!m) return;
      const s = lastResumeList[parseInt(m[1], 10) - 1];
      if (!s) return;
      ctl.closeExtPanel();
      const parts = [
        `「${s.title?.text ?? s.id}」  [标题: ${TITLE_SOURCE_LABEL[s.title?.source] ?? s.title?.source ?? "?"}]`,
        `  恢复: dsh --profile tui --resume ${s.id}`,
        `  cwd: ${s.cwd || "（无）"}`,
      ];
      if (s.firstPrompt) parts.push(`  首条: ${truncate(s.firstPrompt.replace(/\s+/g, " "), 140)}`);
      const path = findSessionLogFile(s.id);
      const preview = path === undefined ? [] : previewSession(path, 3);
      if (preview.length > 0) {
        parts.push("  最近往来:");
        for (const p of preview) {
          parts.push(`    ${p.role === "user" ? "👤" : "🤖"} ${truncate(p.text.replace(/\s+/g, " "), 160)}`);
        }
      }
      const meta = [
        s.model ? `模型 ${s.model}` : "",
        s.bytes !== undefined ? `大小 ${fmtBytes(s.bytes)}` : "",
        `更新 ${relTime(s.updatedAt)}`,
        s.childCount > 0 ? `子代理 ×${s.childCount}` : "",
      ].filter(Boolean);
      if (meta.length > 0) parts.push(`  ${meta.join(" · ")}`);
      ctl.notice("info", parts.join("\n"));
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * 内部工具                                                             *
 * ------------------------------------------------------------------ */

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 工具参数渲染：对象/数组用 JSON.stringify 序列化，避免 String() 输出 [object Object]。 */
function fmtArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function summarizeTrace(ev) {
  const text = String(ev?.text ?? ev?.reasoning ?? ev?.args ?? ev?.preview ?? "");
  switch (ev?.kind) {
    case "user": return `user       ${text.slice(0, 80)}`;
    case "assistant": return `assistant  ${text.slice(0, 80)}`;
    case "assistant-delta": return `delta      ${ev.reasoning ? "🤔 " : ""}${text.slice(0, 70)}`;
    case "tool": return `tool       ${ev.name ?? "?"} ${fmtArgs(ev.args).slice(0, 60)}`;
    case "tool-result": return `tool-res   ${ev.ok === false ? "✗" : "✓"} ${String(ev.preview ?? ev.text ?? "").slice(0, 60)}`;
    case "reasoning": return `reasoning  ${text.slice(0, 70)}`;
    case "notice": return `notice     ${text.slice(0, 70)}`;
    default: return `${String(ev?.kind ?? "?").padEnd(10)} ${text.slice(0, 70)}`;
  }
}

/** /workspace rename 的实现（竞品 channel.renameWorkspace → workspaceService.rename）。 */
function renameWorkspace(ctx, ctl, store, title) {
  const cwd = store.meta?.cwd;
  if (!cwd) {
    ctl.notice("error", "找不到当前工作区（cwd）");
    return;
  }
  const reg = ctx.get("workspaceRegistry");
  if (!reg?.list || typeof reg?.create !== "function") {
    // 同步失败路径：注册表未挂载时立即报错（竞品本地兜底同款：throw
    // 'workspace registry is unavailable'）
    ctl.notice("error", "工作区注册表不可用（workspaceRegistry 未挂载），无法重命名");
    return;
  }
  Promise.resolve()
    .then(async () => {
      let found;
      try {
        found = reg.list().find((w) => w && typeof w.path === "string" && sameProjectPath(w.path, cwd));
      } catch {
        found = undefined;
      }
      const w = found ?? (await reg.create(cwd, title.trim()));
      if (typeof w?.setTitle !== "function") throw new Error("workspace 记录缺少 setTitle");
      await w.setTitle(title.trim());
      ctl.notice("info", `工作区已重命名: ${title.trim()}`);
    })
    .catch((e) => {
      ctl.notice("error", `重命名失败: ${e?.message ?? String(e)}`);
    });
}

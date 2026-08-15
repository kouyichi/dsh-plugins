/**
 * dsh-kanban — Hermes-style kanban board for DeepSeek Harness.
 *
 * Ports Hermes' kanban design (SQLite-backed durable task board shared across
 * sessions) onto dsh: columns, dependencies, assignees, a background
 * dispatcher, heartbeats, and execution by dsh subagents.
 *
 * Columns (Hermes COLUMN_META semantics):
 *   triage → todo → scheduled → ready → running → blocked → review → done (+archived)
 *
 * Dispatcher tick (every 60s):
 *   1. reclaim — running tasks with no heartbeat for STALE_MS are returned to
 *      ready (their run is marked reclaimed), like Hermes' stale reclaim.
 *   2. promote — todo tasks whose parent tasks (task_links) are all done are
 *      promoted to ready (Hermes dispatcher semantics).
 *   3. spawn — ready tasks are dispatched to dsh subagents (parent = most
 *      recently active root agent); on completion → done + summary,
 *      on failure → blocked + error.
 *
 * Heartbeat: any session/event activity refreshes the heartbeat of running
 * tasks (a working session means the worker is alive).
 *
 * Storage: ~/.dsh/kanban/kanban.db (SQLite, node:sqlite DatabaseSync).
 *
 * @module dsh-kanban
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const name = "dsh-kanban";
export const inject = ["tools", "skills", "subagents", "agents", "timer"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const KANBAN_DIR = join(DSH_HOME, "kanban");
const DB_PATH = join(KANBAN_DIR, "kanban.db");

const STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
const STATUS_LABEL = {
  triage: "待细化", todo: "待办", scheduled: "定时", ready: "就绪",
  running: "运行中", blocked: "阻塞", review: "审核", done: "完成", archived: "归档",
};
// Hermes kanban: dispatcher tick 60s, heartbeat ~60s, stale reclaim 4h.
const TICK_MS = 60 * 1000;
const HEARTBEAT_STALE_MS = 30 * 60 * 1000; // no activity for 30 min → reclaim

/* ------------------------------------------------------------------ */
/* db                                                                  */
/* ------------------------------------------------------------------ */

let db = null;

function getDb() {
  if (db) return db;
  mkdirSync(KANBAN_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      default_workdir TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id),
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'triage',
      priority INTEGER NOT NULL DEFAULT 0,
      assignee TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_links (
      parent_id TEXT NOT NULL REFERENCES tasks(id),
      child_id TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (parent_id, child_id)
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      kind TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      run_id TEXT,
      provider TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      outcome TEXT,
      summary TEXT,
      error TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id, status);
    CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);
  `);
  return db;
}

function now() { return Date.now(); }
function id(prefix) { return prefix + "_" + randomUUID().slice(0, 12); }
function cap(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function fmtTs(ts) { return ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—"; }

function pushEvent(taskId, kind, payload) {
  const d = getDb();
  d.prepare("INSERT INTO task_events (id, task_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id("e"), taskId, kind, JSON.stringify(payload || {}), now());
}

function getTask(taskId) {
  const d = getDb();
  const task = d.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return null;
  task.comments = d.prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at").all(taskId);
  task.events = d.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at").all(taskId);
  task.runs = d.prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at").all(taskId);
  task.parents = d.prepare("SELECT parent_id FROM task_links WHERE child_id = ?").all(taskId).map((r) => r.parent_id);
  task.children = d.prepare("SELECT child_id FROM task_links WHERE parent_id = ?").all(taskId).map((r) => r.child_id);
  return task;
}

function defaultBoard() {
  const d = getDb();
  return d.prepare("SELECT * FROM boards ORDER BY created_at LIMIT 1").get() || null;
}

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

function pickParent(agents, fallbackId) {
  const initiator = (agents && typeof agents.currentInitiator === "function" ? agents.currentInitiator() : undefined);
  const roots = (agents && typeof agents.roots === "function" ? agents.roots() : []);
  if (initiator) return initiator;
  if (fallbackId) {
    const found = roots.find((r) => String(r.id) === fallbackId);
    if (found) return found;
  }
  return roots[0] || null;
}

function buildDispatchPrompt(task) {
  const lines = [];
  lines.push("你被派发执行一个看板任务（dsh kanban dispatch）。");
  lines.push("");
  lines.push(`任务：${task.title}`);
  lines.push("");
  lines.push(`正文：${task.body || "（无）"}`);
  lines.push("");
  lines.push("要求：");
  lines.push("1. 在允许的工作区内完成任务。");
  lines.push("2. 完成后，用最终回复给出**结果摘要**（做了什么、产出在哪、验证结果）。");
  lines.push("3. 无法完成时，明确说明阻塞原因。");
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
  /** live runs: taskId -> {signal, run, seq} */
  const live = new Map();
  let lastActiveRootId = null;

  /* ---------- dispatch / settle ---------- */

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

  async function dispatchTask(taskId, extraInstructions) {
    const d = getDb();
    const task = getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "ready") throw new Error("只有 ready 状态的任务可以派发（当前 " + task.status + "）");
    if (live.has(taskId)) throw new Error("任务已在运行中");
    if (!subagents || !agents) throw new Error("当前 DSH 没有挂载 subagents/agents 服务");
    const parent = pickParent(agents, lastActiveRootId);
    if (!parent) throw new Error("没有存活的代理会话可用于派发（请先开启一个会话）");
    const provider = await pickProvider(subagents);
    const promptText = buildDispatchPrompt(task) + (extraInstructions ? `\n\n补充要求：${extraInstructions}` : "");
    const signal = new AbortController();
    const run = await subagents.start(provider, {
      label: "kanban: " + cap(task.title, 60),
      prompt: [{ type: "text", text: promptText }],
      parent,
      signal: signal.signal,
    });
    const seq = (task.runs.length || 0) + 1;
    const runId = "r_" + randomUUID().slice(0, 12);
    const stmt = d.prepare(
      "INSERT INTO task_runs (id, task_id, run_id, provider, status, started_at, heartbeat_at) VALUES (?, ?, ?, ?, 'running', ?, ?)"
    );
    stmt.run(runId, taskId, String(run.id), provider, now(), now());
    live.set(taskId, { signal, run, runId });
    d.prepare("UPDATE tasks SET status='running', updated_at=? WHERE id=?").run(now(), taskId);
    pushEvent(taskId, "dispatched", { provider, runId: String(run.id), seq });
    run.result.then((res) => settle(taskId, runId, res)).catch((err) => settleErr(taskId, runId, err));
    return { runId };
  }

  function settle(taskId, runId, result) {
    const d = getDb();
    const output = extractResultText(result);
    const summary = output ? cap(output, 4000) : "（子代理已完成，未产生文本输出）";
    d.prepare("UPDATE task_runs SET status='done', outcome='completed', summary=?, ended_at=?, heartbeat_at=? WHERE id=?")
      .run(summary, now(), now(), runId);
    d.prepare("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?").run(now(), now(), taskId);
    pushEvent(taskId, "completed", { summary: cap(summary, 500) });
    live.delete(taskId);
  }

  function settleErr(taskId, runId, err) {
    const d = getDb();
    const msg = String(err?.message || err).slice(0, 2000);
    d.prepare("UPDATE task_runs SET status='done', outcome='error', error=?, ended_at=?, heartbeat_at=? WHERE id=?")
      .run(msg, now(), now(), runId);
    d.prepare("UPDATE tasks SET status='blocked', updated_at=? WHERE id=?").run(now(), taskId);
    pushEvent(taskId, "blocked", { error: msg });
    live.delete(taskId);
  }

  function stopTask(taskId) {
    const d = getDb();
    const task = getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "running") throw new Error("任务未在运行");
    const entry = live.get(taskId);
    if (entry) {
      try { entry.signal.abort(); } catch { /* ignore */ }
      live.delete(taskId);
    }
    d.prepare("UPDATE task_runs SET status='done', outcome='terminated', ended_at=? WHERE id=?").run(now(), entry?.runId || "");
    d.prepare("UPDATE tasks SET status='ready', updated_at=? WHERE id=?").run(now(), taskId);
    pushEvent(taskId, "terminated", { by: "user" });
    return task;
  }

  /* ---------- dispatcher tick ---------- */

  async function tick() {
    const d = getDb();
    const t = now();

    // 1. Reclaim stale running tasks (heartbeat too old) → back to ready.
    const stale = d.prepare("SELECT task_id, id FROM task_runs WHERE status='running' AND heartbeat_at < ?").all(t - HEARTBEAT_STALE_MS);
    for (const r of stale) {
      d.prepare("UPDATE task_runs SET status='done', outcome='reclaimed', error='heartbeat lost', ended_at=? WHERE id=?").run(t, r.id);
      d.prepare("UPDATE tasks SET status='ready', updated_at=? WHERE id=?").run(t, r.task_id);
      pushEvent(r.task_id, "reclaimed", { reason: "heartbeat lost" });
      live.delete(r.task_id);
    }

    // 2. Promote todo tasks whose parents are all done → ready.
    const todos = d.prepare("SELECT id FROM tasks WHERE status='todo'").all();
    for (const row of todos) {
      const parents = d.prepare("SELECT parent_id FROM task_links WHERE child_id=?").all(row.id).map((p) => p.parent_id);
      if (parents.length === 0) continue;
      let allDone = true;
      for (const pid of parents) {
        const p = d.prepare("SELECT status FROM tasks WHERE id=?").get(pid);
        if (!p || p.status !== "done") { allDone = false; break; }
      }
      if (allDone) {
        d.prepare("UPDATE tasks SET status='ready', updated_at=? WHERE id=?").run(t, row.id);
        pushEvent(row.id, "promoted", { from: "todo", to: "ready" });
      }
    }

    // 3. Dispatch ready tasks (needs a live parent agent).
    const ready = d.prepare("SELECT id FROM tasks WHERE status='ready'").all();
    for (const row of ready) {
      if (live.has(row.id)) continue;
      const parent = pickParent(agents, lastActiveRootId);
      if (!parent) continue; // no live session right now — try next tick
      try {
        await dispatchTask(row.id, "");
      } catch (err) {
        ctx.logger.warn(`[dsh-kanban] auto-dispatch ${row.id} failed: ${err.message}`);
      }
    }
  }

  disposers.push(ctx.interval(TICK_MS, () => {
    tick().catch((err) => ctx.logger.warn(`[dsh-kanban] tick failed: ${err.message}`));
  }));

  // Heartbeat: any session activity refreshes running tasks.
  ctx.on("session/event", () => {
    const d = getDb();
    d.prepare("UPDATE task_runs SET heartbeat_at=? WHERE status='running'").run(now());
    if (agents && typeof agents.roots === "function") {
      const roots = agents.roots();
      if (roots.length > 0) lastActiveRootId = String(roots[roots.length - 1].id);
    }
  });

  /* ---------- tools ---------- */

  tools.register({
    name: "kanban_list_boards",
    description: "列出所有看板：slug、名称、各列任务数。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const d = getDb();
      const boards = d.prepare("SELECT * FROM boards ORDER BY created_at").all();
      if (boards.length === 0) return "还没有看板。用 kanban_create_board 创建第一个。";
      const lines = boards.map((b) => {
        const counts = {};
        for (const s of STATUSES) counts[s] = 0;
        const rows = d.prepare("SELECT status, COUNT(*) n FROM tasks WHERE board_id=? GROUP BY status").all(b.id);
        for (const r of rows) if (counts[r.status] !== undefined) counts[r.status] = r.n;
        const active = STATUSES.map((s) => `${STATUS_LABEL[s]} ${counts[s]}`).join(" / ");
        return `- ${b.name}（slug=${b.slug}，id=${b.id}）：${active}`;
      });
      return `看板列表（${boards.length}）：\n${lines.join("\n")}`;
    },
    presentCall: () => present("看板：列表", "kanban_list_boards"),

  });

  tools.register({
    name: "kanban_create_board",
    description: "创建新看板。slug 用于后续工具定位（省略自动由名称生成）。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "看板名称（必填）" },
        slug: { type: "string", description: "可选：slug（小写连字符，默认由名称生成）" },
        default_workdir: { type: "string", description: "可选：默认工作目录" },
      },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      const name = String(args.name || "").trim();
      if (!name) throw new Error("name 不能为空");
      const slug = String(args.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-") || ("board-" + randomUUID().slice(0, 6));
      const boardId = id("b");
      d.prepare("INSERT INTO boards (id, slug, name, default_workdir, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(boardId, slug, name, String(args.default_workdir || ""), now());
      return `已创建看板 ${name}（slug=${slug}，id=${boardId}）。`;
    },
    presentCall: (args) => present("看板：创建", args?.name || ""),

  });

  tools.register({
    name: "kanban_create_task",
    description: "在看板上创建任务卡片。status 默认 triage；需要派发前移到 ready（kanban_update_task）。priority 0-9。parent_ids 可选：父任务列表（本任务进入 todo 列，等父全部 done 后自动晋升 ready）。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务标题（必填）" },
        body: { type: "string", description: "任务正文/描述" },
        board: { type: "string", description: "看板 slug 或 id；省略用第一个看板" },
        status: { type: "string", enum: STATUSES.filter((s) => s !== "running"), description: "初始列，默认 triage" },
        priority: { type: "number", description: "0-9，越大越优先，默认 0" },
        assignee: { type: "string", description: "可选：负责人/模型名（留空跟随会话默认）" },
        parent_ids: { type: "array", items: { type: "string" }, description: "可选：父任务 id 列表（依赖）" },
      },
      required: ["title"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      const title = String(args.title || "").trim();
      if (!title) throw new Error("title 不能为空");
      let board = defaultBoard();
      if (args.board) board = d.prepare("SELECT * FROM boards WHERE slug=? OR id=?").get(String(args.board), String(args.board)) || null;
      if (!board) throw new Error("看板不存在（先 kanban_create_board，或指定 board）");
      const status = STATUSES.includes(args.status) && args.status !== "running" ? args.status : "triage";
      const taskId = id("t");
      d.prepare("INSERT INTO tasks (id, board_id, title, body, status, priority, assignee, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(taskId, board.id, title, String(args.body || ""), status, Math.max(0, Math.min(9, Number(args.priority) || 0)), String(args.assignee || ""), now(), now());
      pushEvent(taskId, "created", { status });
      const parents = Array.isArray(args.parent_ids) ? args.parent_ids.map(String) : [];
      for (const p of parents) {
        if (p === taskId) continue;
        d.prepare("INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)").run(p, taskId);
      }
      if (parents.length > 0 && status !== "todo") {
        d.prepare("UPDATE tasks SET status='todo', updated_at=? WHERE id=?").run(now(), taskId);
        pushEvent(taskId, "status", { from: status, to: "todo", reason: "有父依赖" });
      }
      return `已创建任务 ${taskId}「${title}」（看板 ${board.name}，列=${STATUS_LABEL[status]}${parents.length ? "，依赖 " + parents.length + " 个父任务" : ""}）。`;
    },
    presentCall: (args) => present("看板：创建任务", cap(args?.title || "", 40)),

  });

  tools.register({
    name: "kanban_list_tasks",
    description: "列出任务（紧凑视图）。可按 board/status/priority_min/assignee/query 过滤，limit 上限 200。",
    parameters: {
      type: "object",
      properties: {
        board: { type: "string", description: "看板 slug/id；省略用第一个看板" },
        status: { type: "string", enum: STATUSES, description: "可选：只看该列" },
        priority_min: { type: "number", description: "可选：优先级下限" },
        assignee: { type: "string", description: "可选：按负责人过滤" },
        query: { type: "string", description: "可选：标题/正文关键词" },
        limit: { type: "number", description: "默认 50，上限 200" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      let board = defaultBoard();
      if (args.board) board = d.prepare("SELECT * FROM boards WHERE slug=? OR id=?").get(String(args.board), String(args.board)) || null;
      if (!board) return "还没有看板。";
      const limit = Math.min(Number(args.limit) || 50, 200);
      let sql = "SELECT * FROM tasks WHERE board_id=?";
      const params = [board.id];
      if (args.status) { sql += " AND status=?"; params.push(String(args.status)); }
      if (args.assignee) { sql += " AND assignee=?"; params.push(String(args.assignee)); }
      if (args.query) { sql += " AND (title LIKE ? OR body LIKE ?)"; const q = `%${String(args.query)}%`; params.push(q, q); }
      sql += " ORDER BY priority DESC, created_at DESC LIMIT ?";
      params.push(limit);
      const rows = d.prepare(sql).all(...params);
      if (rows.length === 0) return `看板 ${board.name}：当前无符合条件的任务。`;
      const lines = rows.map((t) => {
        const parts = [`id=${t.id}`, STATUS_LABEL[t.status], `优先级=${t.priority}`];
        if (t.assignee) parts.push(`负责人=${t.assignee}`);
        if (t.status === "running") parts.push("运行中");
        return `- ${cap(t.title, 50)}（${parts.join("，")}）`;
      });
      return `看板 ${board.name} 任务（${rows.length} 张，最多列 ${limit}）：\n${lines.join("\n")}`;
    },
    presentCall: () => present("看板：任务列表", "kanban_list_tasks"),

  });

  tools.register({
    name: "kanban_get_task",
    description: "查看任务完整信息：标题/正文/状态/优先级/负责人/父依赖/子任务/评论/事件/运行记录（含摘要与错误）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const task = getTask(String(args.id));
      if (!task) throw new Error("任务不存在: " + args.id);
      const lines = [];
      lines.push(`任务 ${task.id}「${task.title}」`);
      lines.push(`状态: ${STATUS_LABEL[task.status]}（${task.status}）| 优先级: ${task.priority}${task.assignee ? " | 负责人: " + task.assignee : ""}`);
      lines.push(`看板: ${task.board_id} | 创建 ${fmtTs(task.created_at)}${task.completed_at ? " | 完成 " + fmtTs(task.completed_at) : ""}`);
      lines.push(`正文: ${task.body || "（无）"}`);
      if (task.parents.length) lines.push(`父依赖: ${task.parents.join(", ")}`);
      if (task.children.length) lines.push(`子任务: ${task.children.join(", ")}`);
      const comments = task.comments.slice(-10);
      lines.push(`评论（${task.comments.length} 条${comments.length < task.comments.length ? "，列最近 " + comments.length : ""}）:`);
      for (const c of comments) lines.push(`  - ${c.author} ${fmtTs(c.created_at)}: ${cap(c.body, 200)}`);
      if (comments.length === 0) lines.push("  （无）");
      const runs = task.runs.slice(-3);
      lines.push(`运行记录（${task.runs.length} 次${runs.length < task.runs.length ? "，列最近 " + runs.length : ""}）:`);
      for (const r of runs) {
        lines.push(`  - ${r.run_id || r.id} [${r.outcome || r.status}] ${fmtTs(r.started_at)}${r.ended_at ? " → " + fmtTs(r.ended_at) : ""}`);
        if (r.summary) lines.push(`    摘要: ${cap(r.summary, 300)}`);
        if (r.error) lines.push(`    错误: ${cap(r.error, 300)}`);
      }
      if (runs.length === 0) lines.push("  （尚未派发）");
      return lines.join("\n");
    },
    presentCall: (args) => present("看板：任务详情", args?.id || ""),

  });

  tools.register({
    name: "kanban_update_task",
    description: "更新任务：title/body/status（不能直接设 running，running 只能经派发）/priority/assignee。move 语义：从当前列移到目标列。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id" },
        title: { type: "string", description: "新标题" },
        body: { type: "string", description: "新正文" },
        status: { type: "string", enum: STATUSES.filter((s) => s !== "running"), description: "目标列" },
        priority: { type: "number", description: "新优先级 0-9" },
        assignee: { type: "string", description: "新负责人" },
      },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      const task = getTask(String(args.id));
      if (!task) throw new Error("任务不存在: " + args.id);
      const sets = [];
      const params = [];
      const changed = [];
      if (args.title !== undefined) { sets.push("title=?"); params.push(String(args.title).trim()); changed.push("title"); }
      if (args.body !== undefined) { sets.push("body=?"); params.push(String(args.body)); changed.push("body"); }
      if (args.priority !== undefined) { sets.push("priority=?"); params.push(Math.max(0, Math.min(9, Number(args.priority) || 0))); changed.push("priority"); }
      if (args.assignee !== undefined) { sets.push("assignee=?"); params.push(String(args.assignee)); changed.push("assignee"); }
      if (args.status !== undefined) {
        if (args.status === "running") throw new Error("running 列只能通过派发进入");
        if (task.status === "running" && args.status !== "running") {
          // moving a running task: stop it first (back to ready), then move.
          const entry = live.get(task.id);
          if (entry) { try { entry.signal.abort(); } catch { /* ignore */ } live.delete(task.id); }
          d.prepare("UPDATE task_runs SET status='done', outcome='terminated', ended_at=? WHERE id=?").run(now(), entry?.runId || "");
          pushEvent(task.id, "terminated", { by: "status-change" });
        }
        sets.push("status=?"); params.push(String(args.status)); changed.push("status");
      }
      if (sets.length === 0) return "没有要更新的字段。";
      sets.push("updated_at=?"); params.push(now());
      params.push(task.id);
      d.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...params);
      if (changed.includes("status")) pushEvent(task.id, "status", { from: task.status, to: args.status });
      else pushEvent(task.id, "edited", { fields: changed });
      return `已更新任务 ${task.id}：${changed.join("、")}。`;
    },
    presentCall: (args) => present("看板：更新任务", args?.id || ""),

  });

  tools.register({
    name: "kanban_add_comment",
    description: "给任务追加评论（面向人/记录进展）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" }, body: { type: "string", description: "评论内容" }, author: { type: "string", description: "可选：署名，默认 agent" } },
      required: ["id", "body"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      const task = getTask(String(args.id));
      if (!task) throw new Error("任务不存在: " + args.id);
      const commentId = id("c");
      d.prepare("INSERT INTO task_comments (id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(commentId, task.id, String(args.author || "agent"), String(args.body), now());
      pushEvent(task.id, "commented", { author: args.author || "agent" });
      return `已评论任务 ${task.id}（${commentId}）。`;
    },
    presentCall: (args) => present("看板：评论", args?.id || ""),

  });

  tools.register({
    name: "kanban_link",
    description: "建立/解除任务依赖：parent_id 完成后 child（todo 列）自动晋升 ready。unlink=true 解除。",
    parameters: {
      type: "object",
      properties: { parent_id: { type: "string", description: "父任务 id" }, child_id: { type: "string", description: "子任务 id" }, unlink: { type: "boolean", description: "true=解除依赖" } },
      required: ["parent_id", "child_id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      const p = getTask(String(args.parent_id));
      const c = getTask(String(args.child_id));
      if (!p) throw new Error("父任务不存在");
      if (!c) throw new Error("子任务不存在");
      if (args.unlink) {
        d.prepare("DELETE FROM task_links WHERE parent_id=? AND child_id=?").run(p.id, c.id);
        pushEvent(c.id, "unlinked", { parent: p.id });
        return `已解除依赖：${c.id} 不再依赖 ${p.id}。`;
      }
      if (p.id === c.id) throw new Error("任务不能依赖自己");
      d.prepare("INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)").run(p.id, c.id);
      pushEvent(c.id, "linked", { parent: p.id });
      if (c.status === "ready") {
        d.prepare("UPDATE tasks SET status='todo', updated_at=? WHERE id=?").run(now(), c.id);
        pushEvent(c.id, "status", { from: "ready", to: "todo", reason: "新增父依赖" });
      }
      return `已建立依赖：${c.id} 依赖 ${p.id}（父完成后自动晋升）。`;
    },
    presentCall: (args) => present("看板：依赖", `${args?.child_id} ← ${args?.parent_id}`),

  });

  tools.register({
    name: "kanban_dispatch_task",
    description: "把 ready 任务派发给子代理执行（异步）：任务转 running，完成后自动转 done 并回写结果摘要，失败转 blocked。instructions 可选补充本轮要求。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" }, instructions: { type: "string", description: "可选：补充要求" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const r = await dispatchTask(String(args.id), String(args.instructions || ""));
      return `已派发任务 ${args.id}（run=${r.runId}）。后台执行中：kanban_get_task id=${args.id} 查进度；完成/失败自动结算。`;
    },
    presentCall: (args) => present("看板：派发", args?.id || ""),

  });

  tools.register({
    name: "kanban_stop_task",
    description: "终止运行中的任务：子代理被中止，任务回到 ready，运行记录标 terminated。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const task = stopTask(String(args.id));
      return `已终止任务 ${task.id}（回 ready）。`;
    },
    presentCall: (args) => present("看板：停止", args?.id || ""),

  });

  tools.register({
    name: "kanban_delete_task",
    description: "删除任务（不可恢复；同时删除其评论/事件/运行记录/依赖关系）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const d = getDb();
      const task = getTask(String(args.id));
      if (!task) throw new Error("任务不存在: " + args.id);
      if (task.status === "running") throw new Error("运行中的任务不能删除：先 kanban_stop_task");
      for (const tbl of ["task_comments", "task_events", "task_runs"]) {
        d.prepare(`DELETE FROM ${tbl} WHERE task_id=?`).run(task.id);
      }
      d.prepare("DELETE FROM task_links WHERE parent_id=? OR child_id=?").run(task.id, task.id);
      d.prepare("DELETE FROM tasks WHERE id=?").run(task.id);
      return `已删除任务 ${task.id}「${task.title}」。`;
    },
    presentCall: (args) => present("看板：删除任务", args?.id || ""),

  });

  tools.register({
    name: "kanban_status",
    description: "看板插件状态：数据库位置、各列任务分布、运行中任务心跳、dispatcher 是否活跃。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const d = getDb();
      const boards = d.prepare("SELECT * FROM boards").all();
      const total = d.prepare("SELECT COUNT(*) n FROM tasks").get().n;
      const byStatus = {};
      for (const s of STATUSES) byStatus[s] = 0;
      for (const r of d.prepare("SELECT status, COUNT(*) n FROM tasks GROUP BY status").all()) byStatus[r.status] = r.n;
      const running = d.prepare("SELECT COUNT(*) n FROM task_runs WHERE status='running'").get().n;
      const stale = d.prepare("SELECT COUNT(*) n FROM task_runs WHERE status='running' AND heartbeat_at < ?").get(now() - HEARTBEAT_STALE_MS).n;
      const lines = [];
      lines.push(`看板数据库: ${DB_PATH}`);
      lines.push(`看板数: ${boards.length}；任务总数: ${total}`);
      lines.push(`分布: ${STATUSES.map((s) => `${STATUS_LABEL[s]} ${byStatus[s]}`).join(" / ")}`);
      lines.push(`运行中子代理: ${running}（心跳超时 ${stale}，超时 ${HEARTBEAT_STALE_MS / 60000} 分钟回收）`);
      lines.push(`dispatcher: 每 ${TICK_MS / 1000}s 一轮（回收过期 → 晋升 todo→ready → 自动派发 ready）`);
      return lines.join("\n");
    },
    presentCall: () => present("看板：状态", "kanban_status"),

  });

  /* ---------- runtime skill guide ---------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "kanban",
      description: "Hermes 风格看板：SQLite 持久任务板，多列流转 + 依赖晋升 + 后台 dispatcher 自动派发子代理执行。",
      whenToUse: "当任务多步骤、需要跟踪/派发/依赖管理、用户提到看板/任务板/kanban 时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "kanban 是持久化任务看板（SQLite，重启不丢）。列：triage(待细化) → todo(待办) → scheduled(定时) → ready(就绪) → running(运行中) → blocked(阻塞) → review(审核) → done(完成) / archived(归档)。",
        "",
        "## 核心机制",
        "",
        "- **依赖晋升**：todo 任务的父任务全部 done 后自动晋升 ready（dispatcher 每 60s）。",
        "- **自动派发**：ready 任务由 dispatcher 派给 dsh 子代理执行；完成→done+摘要回写，失败→blocked+错误。",
        "- **心跳回收**：运行中任务 30 分钟无任何会话活动即被回收回 ready（防假运行）。",
        "- **手动派发**：kanban_dispatch_task 立即派发（可带补充 instructions）。",
        "",
        "## 工具速览",
        "",
        "- 看板：kanban_create_board / kanban_list_boards",
        "- 任务：kanban_create_task（可带 parent_ids 依赖）/ kanban_list_tasks / kanban_get_task / kanban_update_task / kanban_delete_task",
        "- 依赖：kanban_link（父完成→子晋升）",
        "- 执行：kanban_dispatch_task / kanban_stop_task",
        "- 记录：kanban_add_comment",
        "- 状态：kanban_status",
        "",
        "## 标准工作流",
        "",
        "1. 多步骤任务先拆卡：kanban_create_task（验收目标写进 body，依赖关系用 parent_ids）。",
        "2. 需要派发时把任务移到 ready（kanban_update_task status=ready），dispatcher 自动派发；或 kanban_dispatch_task 立即派。",
        "3. 派发是异步的：用 kanban_get_task 查 run 的 summary/error，别干等。",
        "4. 完成/阻塞都有事件记录（kanban_get_task 的 events 部分）。",
        "",
        "## 注意",
        "",
        "- running 列只能通过派发进入，不能手动设置。",
        "- 一步能完成的小事不要建卡。",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    for (const [, entry] of live) { try { entry.signal.abort(); } catch { /* ignore */ } }
  });
}

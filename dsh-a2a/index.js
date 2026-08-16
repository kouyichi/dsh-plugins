/**
 * dsh-a2a — native A2A (Agent-to-Agent, v1.0) server for DeepSeek Harness.
 *
 * Port of the Hermes A2A platform plugin concept onto dsh: the plugin starts
 * an HTTP JSON-RPC endpoint (default 127.0.0.1:9917) that speaks the A2A v1.0
 * protocol, so other agents (Hermes, custom clients, A2A-compatible tools)
 * can call THIS dsh as a remote agent:
 *
 *   tasks/send   {id, message:{role,parts:[{type:"text",text}]}} → Task
 *   tasks/get    {id} → Task
 *   tasks/cancel {id} → Task
 *   tasks/list   {sessionId?} → {tasks:[...]}
 *   agent/get    → AgentCard (capabilities + auth info)
 *
 * Each task runs in a freshly created dsh agent; the final assistant message
 * becomes the completed task's artifact. Optional bearer-token auth via
 * DSH_A2A_TOKEN (or config). Tasks are in-memory (lost on restart).
 *
 * This closes a real ecosystem gap: as of 2026-08-16 no third-party A2A
 * server exists for dsh (official examples cover ACP and JSON-RPC only).
 *
 * @module dsh-a2a
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-a2a";
export const inject = ["tools", "skills", "agents"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const A2A_DIR = join(DSH_HOME, "a2a");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9917;
const MAX_BODY = 4 * 1024 * 1024;

const now = () => Date.now();

/* ------------------------------------------------------------------ */
/* plugin state                                                        */
/* ------------------------------------------------------------------ */

function makeTaskStore() {
  const tasks = new Map();
  return {
    tasks,
    put(t) { tasks.set(t.id, t); return t; },
    get(id) { return tasks.get(id); },
    list() { return [...tasks.values()]; },
  };
}

const STATUS = {
  submitted: "submitted",
  working: "working",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
};

function taskStatus(state, message) {
  const s = { state, timestampMs: now() };
  if (message) s.message = message;
  return s;
}

function artifactText(text) {
  return { artifacts: [{ name: "result", parts: [{ type: "text", text }] }] };
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** A2A error codes (spec): -32000 invalid params etc.; use JSON-RPC range. */
const ERR = { INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

function buildAgentCard(host, port, authRequired) {
  return {
    name: "dsh (DeepSeek Harness)",
    description: "dsh agent exposed via the dsh-a2a plugin (A2A v1.0)",
    url: `http://${host}:${port}`,
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    ...(authRequired ? { securitySchemes: { bearer: { type: "bearer" } } } : {}),
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
  };
}

export function apply(ctx) {
  const tools = ctx.get("tools");
  const agents = ctx.get("agents");
  const disposers = [];
  const store = makeTaskStore();

  let server = null;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let token = process.env.DSH_A2A_TOKEN || "";

  /* -------- task execution -------- */

  async function runTask(task, parts) {
    const text = (parts || []).filter((p) => p?.type === "text").map((p) => p.text || "").join("\n").trim();
    if (!text) throw { code: ERR.INVALID_PARAMS, message: "message.parts must include at least one text part" };
    task.status = taskStatus(STATUS.working);
    task.message = task.message || {};
    let handle;
    try {
      if (!agents) throw new Error("agents 服务不可用");
      const defaultModel = ctx.get("agentDefaultModel");
      const selection = defaultModel?.currentSelection ? defaultModel.currentSelection() : undefined;
      const agentOptions = selection?.provider && selection?.model
        ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
        : undefined;
      const { SessionId } = await import("@deepseek-ai/dsh-session");
      const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
      handle = await agents.create({
        sessionId: SessionId(`session-a2a-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup: async (agentCtx) => {
          if (selection?.provider && selection?.model) {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 });
          }
          try {
            const presets = agentCtx.get("agentPresets");
            if (presets && typeof presets.mount === "function") await presets.mount(agentCtx);
          } catch { /* absent in headless */ }
        },
      });
      const { agent, dispose } = handle;
      let finalText = "";
      const onEvent = (_s, event) => {
        if (event?.type === "assistant/message") {
          const texts = [];
          const walk = (v) => {
            if (v == null) return;
            if (typeof v === "string") { texts.push(v); return; }
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (typeof v === "object") {
              if (typeof v.text === "string") texts.push(v.text);
              for (const k of Object.keys(v)) {
                if (k === "type" || k === "role" || k === "name") continue;
                if (k === "content" || k === "text" || k === "message" || k === "data") walk(v[k]);
              }
            }
          };
          walk(event.data?.message);
          const meaningful = texts.filter((t) => t.trim() && !t.startsWith("<"));
          if (meaningful.length) finalText = meaningful.join("\n").slice(-16000);
        }
      };
      agent.ctx.on("session/event", onEvent);
      const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
      await agent.whenIdle();
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      await agent.whenIdle();
      agent.ctx.off("session/event", onEvent);
      try { await ctx.get("sessions").flush(agent.session); } catch { /* ignore */ }
      dispose();
      task.status = taskStatus(STATUS.completed);
      task.artifacts = [{ name: "result", parts: [{ type: "text", text: finalText || "（无文本输出）" }] }];
    } catch (err) {
      if (handle) { try { handle.dispose(); } catch { /* ignore */ } }
      task.status = taskStatus(STATUS.failed, String(err?.message || err).slice(0, 2000));
    }
    return task;
  }

  /* -------- request handling -------- */

  async function handleRequest(req, res) {
    // auth
    if (token) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(jsonRpcError(null, -32001, "unauthorized"));
        return;
      }
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(jsonRpcError(null, ERR.INVALID_REQUEST, "invalid JSON"));
        return;
      }
      const method = parsed.method;
      const params = parsed.params || {};
      const id = parsed.id;
      let result;
      try {
        switch (method) {
          case "tasks/send": {
            const taskId = String(params.id || `task-${randomUUID().slice(0, 8)}`);
            const sessionId = String(params.sessionId || `session-${randomUUID().slice(0, 8)}`);
            const task = store.put({
              id: taskId,
              sessionId,
              status: taskStatus(STATUS.submitted),
              metadata: params.metadata || {},
              message: params.message || {},
            });
            // run async; response carries the submitted task
            runTask(task, params.message?.parts).catch(() => { /* status recorded inside */ });
            result = { jsonrpc: "2.0", id, result: publicTask(task) };
            break;
          }
          case "tasks/get": {
            const task = store.get(String(params.id));
            if (!task) throw { code: -32602, message: `task not found: ${params.id}` };
            result = { jsonrpc: "2.0", id, result: publicTask(task) };
            break;
          }
          case "tasks/cancel": {
            const task = store.get(String(params.id));
            if (!task) throw { code: -32602, message: `task not found: ${params.id}` };
            if (task.status.state === "submitted" || task.status.state === "working") {
              task.status = taskStatus(STATUS.canceled, "canceled by client");
            }
            result = { jsonrpc: "2.0", id, result: publicTask(task) };
            break;
          }
          case "tasks/list": {
            const tasks = store.list().map(publicTask);
            result = { jsonrpc: "2.0", id, result: { tasks } };
            break;
          }
          case "agent/get": {
            result = { jsonrpc: "2.0", id, result: buildAgentCard(host, port, !!token) };
            break;
          }
          default:
            throw { code: ERR.METHOD_NOT_FOUND, message: `method not found: ${method}` };
        }
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(jsonRpcError(id, err.code || ERR.INTERNAL, err.message || String(err)));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
  }

  function publicTask(t) {
    const out = { id: t.id, sessionId: t.sessionId, status: t.status };
    if (t.artifacts) out.artifacts = t.artifacts;
    if (t.metadata) out.metadata = t.metadata;
    if (t.message) out.message = t.message;
    return out;
  }

  function startServer({ host: h, port: p, requireToken }) {
    if (server) return { alreadyRunning: true, host, port, token };
    host = h || host;
    port = Number(p) || port;
    if (requireToken !== undefined) token = requireToken ? token || randomUUID().slice(0, 12) : "";
    return new Promise((resolve, reject) => {
      server = createServer(handleRequest);
      server.on("error", (err) => { server = null; reject(err); });
      server.listen(port, host, () => {
        mkdirSync(A2A_DIR, { recursive: true });
        writeFileSync(join(A2A_DIR, "endpoint.json"), JSON.stringify({ host, port, token: token ? "**set**" : null, started_at: now() }, null, 2));
        ctx.logger.info(`[dsh-a2a] listening on http://${host}:${port}${token ? " (bearer auth)" : ""}`);
        resolve({ host, port, token });
      });
    });
  }

  function stopServer() {
    if (!server) return false;
    return new Promise((resolve) => {
      server.close(() => { server = null; resolve(true); });
      server = null;
      resolve(true);
    });
  }

  /* -------- tools -------- */

  tools.register({
    name: "a2a_status",
    description: "A2A 服务状态：监听地址/端口、认证、任务数、最近任务。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const tasks = store.list();
      const lines = [];
      lines.push(`A2A server: ${server ? `运行中 http://${host}:${port}` : "未启动（a2a_start 启动）"}`);
      lines.push(`认证: ${token ? "Bearer token 已设置" : "无（本机信任网络）"}`);
      lines.push(`任务: ${tasks.length} 个（内存态，重启清空）`);
      for (const t of tasks.slice(-5)) {
        lines.push(`- ${t.id}: ${t.status.state}${t.status.message ? " " + String(t.status.message).slice(0, 60) : ""}`);
      }
      if (tasks.length) lines.push(`用 a2a_tasks 查看全部；其他 agent 通过 POST http://${host}:${port} 调用 tasks/send 等方法。`);
      return lines.join("\n");
    },
    presentCall: () => present("A2A：状态", "a2a_status"),
  });

  tools.register({
    name: "a2a_start",
    description: "启动 A2A JSON-RPC 服务器（默认 127.0.0.1:9917）。port/host 可指定；require_token=true 时若无 DSH_A2A_TOKEN 环境变量则自动生成并显示。启动后其他 agent（如 Hermes）可配置 A2A client 调用本 dsh。",
    parameters: {
      type: "object",
      properties: {
        port: { type: "number", description: "监听端口（默认 9917）" },
        host: { type: "string", description: "监听地址（默认 127.0.0.1）" },
        require_token: { type: "boolean", description: "要求 Bearer token（默认读环境变量 DSH_A2A_TOKEN，未设则自动生成）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const r = await startServer({ host: args.host, port: args.port, requireToken: args.require_token });
      const lines = [];
      lines.push(`A2A server: http://${r.host}:${r.port}${r.alreadyRunning ? "（已在运行）" : "（已启动）"}`);
      lines.push(`AgentCard: GET/POST / agent/get`);
      lines.push(`方法: tasks/send | tasks/get | tasks/cancel | tasks/list | agent/get`);
      if (r.token) lines.push(`Bearer token: ${r.token}`);
      lines.push("");
      lines.push(`示例（curl）：curl -s -X POST http://${r.host}:${r.port} -H 'content-type: application/json' ${r.token ? "-H 'authorization: Bearer " + r.token + "' " : ""}-d '{"jsonrpc":"2.0","id":1,"method":"tasks/send","params":{"id":"t1","message":{"role":"user","parts":[{"type":"text","text":"运行 echo hello"}]}}}'`);
      return lines.join("\n");
    },
    presentCall: () => present("A2A：启动", "a2a_start"),
  });

  tools.register({
    name: "a2a_stop",
    description: "停止 A2A 服务器（已有任务状态保留在内存）。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const stopped = await stopServer();
      return stopped ? "A2A server 已停止。" : "A2A server 未在运行。";
    },
    presentCall: () => present("A2A：停止", "a2a_stop"),
  });

  tools.register({
    name: "a2a_tasks",
    description: "列出 A2A 收到的任务与状态（含消息与产物摘要）。",
    parameters: { type: "object", properties: { limit: { type: "number", description: "默认 20" } }, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const tasks = store.list().slice(-(Number(args.limit) || 20));
      if (tasks.length === 0) return "暂无 A2A 任务。";
      const lines = [];
      for (const t of tasks) {
        lines.push(`- ${t.id} [${t.status.state}] ${new Date(t.status.timestampMs).toISOString().slice(0, 19).replace("T", " ")}`);
        const msgText = (t.message?.parts || []).filter((p) => p?.type === "text").map((p) => p.text).join(" ").slice(0, 100);
        if (msgText) lines.push(`  消息: ${msgText}`);
        const art = (t.artifacts || []).map((a) => (a.parts || []).map((p) => p.text || "").join(" ").slice(0, 150)).join(" ");
        if (art) lines.push(`  产物: ${art}`);
        if (t.status.message) lines.push(`  状态消息: ${String(t.status.message).slice(0, 150)}`);
      }
      return `A2A 任务（${tasks.length} 个）：\n${lines.join("\n")}`;
    },
    presentCall: () => present("A2A：任务", "a2a_tasks"),
  });

  /* -------- auto start -------- */
  if (process.env.DSH_A2A_AUTOSTART === "1") {
    startServer({}).catch((err) => ctx.logger.warn(`[dsh-a2a] autostart failed: ${err.message}`));
  }

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "a2a",
      description: "A2A 服务：把 dsh 暴露为 A2A v1.0 agent（tasks/send 等 JSON-RPC 方法），供 Hermes 等其他 agent 调用。",
      whenToUse: "当需要让其他 agent 直接调用本 dsh、跨 agent 协作、或调试 A2A 连接时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "dsh-a2a 启动一个 HTTP JSON-RPC 端点（A2A v1.0），让其他 agent 通过 tasks/send 调用本 dsh 执行任务。",
        "",
        "## 使用",
        "",
        "1. `a2a_start` 启动（默认 127.0.0.1:9917；require_token=true 加 Bearer 认证）",
        "2. 其他 agent 配置 A2A client 指向 http://127.0.0.1:9917，调 tasks/send",
        "3. `a2a_status` / `a2a_tasks` 查看；`a2a_stop` 停止",
        "",
        "## 注意",
        "",
        "- 任务与状态是内存态，重启 dsh 后清空",
        "- 认证 token 优先读环境变量 DSH_A2A_TOKEN",
        "- 每个任务独立 agent 执行（会话落盘 ~/.dsh/sessions/ 可审计）",
      ],
    }));
  }

  ctx.effect(() => () => {
    if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

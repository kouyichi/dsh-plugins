/**
 * dsh-cron — persistent background scheduled agent jobs for DeepSeek Harness.
 *
 * The official dsh-schedule seam is session-local reminder tooling (schedule_
 * create/list/delete fire a reminder INTO one session). dsh-cron is different:
 * durable cross-session JOBS that run a full agent turn in a freshly created
 * agent, persist results to a job log, and survive restarts (Hermes cron +
 * Kimi built-in CronCreate/CronList/CronDelete pattern).
 *
 *   cron_add     — register a job (name + prompt + every_min)
 *   cron_list    — list jobs with next-run times
 *   cron_remove  — delete a job
 *   cron_run     — run a job now (manual trigger)
 *   cron_logs    — read job run history
 *   cron_status  — plugin status (store path, pending jobs, last runs)
 *
 * Dispatcher: every 30s (ctx.interval, requires "timer" inject) the plugin
 * checks due jobs and executes each via a dedicated agent created through the
 * agents service (installModelSelection + agentPresets.mount when present) —
 * no live conversation needed. Sessions of cron agents persist under
 * ~/.dsh/sessions/ as normal evidence.
 *
 * Storage: ~/.dsh/cron/jobs.json + ~/.dsh/cron/logs.jsonl
 *
 * @module dsh-cron
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-cron";
export const inject = ["tools", "skills", "agents", "timer"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const CRON_DIR = join(DSH_HOME, "cron");
const JOBS_FILE = join(CRON_DIR, "jobs.json");
const LOGS_FILE = join(CRON_DIR, "logs.jsonl");

const TICK_MS = 30 * 1000;

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

function ensureDirs() { mkdirSync(CRON_DIR, { recursive: true }); }

function loadJobs() {
  ensureDirs();
  try { return JSON.parse(readFileSync(JOBS_FILE, "utf8")); } catch { return []; }
}

function saveJobs(jobs) {
  ensureDirs();
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function appendLog(entry) {
  ensureDirs();
  appendFileSync(LOGS_FILE, JSON.stringify(entry) + "\n");
}

function readLogs(limit = 100) {
  ensureDirs();
  if (!existsSync(LOGS_FILE)) return [];
  return readFileSync(LOGS_FILE, "utf8").split("\n").filter(Boolean).slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const now = () => Date.now();
const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "—";
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

/* ------------------------------------------------------------------ */
/* agent creation (per-run, no live conversation needed)               */
/* ------------------------------------------------------------------ */

async function createRunnerAgent(ctx, agents) {
  const defaultModel = ctx.get("agentDefaultModel");
  const selection = defaultModel?.currentSelection ? defaultModel.currentSelection() : undefined;
  const agentOptions = selection?.provider && selection?.model
    ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    : undefined;

  // Late imports keep the plugin loadable even if a dependency is missing.
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");

  const handle = await agents.create({
    sessionId: SessionId(`session-cron-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions,
    setup: async (agentCtx) => {
      if (selection?.provider && selection?.model) {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
      }
      try {
        const presets = agentCtx.get("agentPresets");
        if (presets && typeof presets.mount === "function") await presets.mount(agentCtx);
      } catch { /* presets seam absent (headless) — global layer tools still work */ }
    },
  });
  return handle;
}

/** Run one job: create agent, submit prompt, wait idle, harvest final text. */
async function runJobOnce(ctx, agents, job) {
  const startedAt = now();
  let handle;
  try {
    handle = await createRunnerAgent(ctx, agents);
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
        if (meaningful.length) finalText = meaningful.join("\n").slice(-4000);
      }
    };
    const unsubEvents = agent.ctx.on("session/event", onEvent);
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    await agent.whenIdle();
    agent.followup(createUserMessage({ content: [{ type: "text", text: `【cron 任务 ${job.name}】\n${job.prompt}\n\n完成后给出简短结果摘要。` }], source: { kind: "user" } }));
    await agent.whenIdle();
    agent.cancel({ kind: "interrupted" });
    await ctx.get("sessions").flush(agent.session);
    if (typeof unsubEvents === "function") unsubEvents();
    dispose();
    return { ok: true, text: finalText || "（无文本输出）", durationMs: now() - startedAt };
  } catch (err) {
    if (handle) { try { handle.dispose(); } catch { /* ignore */ } }
    return { ok: false, text: "", durationMs: now() - startedAt, error: String(err?.message || err).slice(0, 2000) };
  }
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const agents = ctx.get("agents");
  const disposers = [];
  let running = new Set(); // job ids currently executing

  async function executeJob(job) {
    if (running.has(job.id)) return "already running";
    running.add(job.id);
    try {
      if (!agents) throw new Error("agents 服务不可用（cron 需要 dsh-agent）");
      const res = await runJobOnce(ctx, agents, job);
      appendLog({
        ts: now(), job_id: job.id, job_name: job.name, ok: res.ok,
        duration_ms: res.durationMs, summary: cap(res.text || res.error || "", 800),
      });
      return res;
    } catch (err) {
      appendLog({ ts: now(), job_id: job.id, job_name: job.name, ok: false, duration_ms: 0, summary: cap(String(err?.message || err), 800) });
      return { ok: false, error: String(err?.message || err) };
    } finally {
      running.delete(job.id);
    }
  }

  /* -------- background dispatcher -------- */
  disposers.push(ctx.interval(TICK_MS, () => {
    const jobs = loadJobs();
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (running.has(job.id)) continue;
      if (job.next_run_at && job.next_run_at > now()) continue;
      // due: execute async, do not block the tick
      executeJob(job).then((res) => {
        const all = loadJobs();
        const j = all.find((x) => x.id === job.id);
        if (j) {
          j.last_run_at = now();
          j.next_run_at = now() + Math.max(1, Number(j.every_min) || 60) * 60000;
          j.runs = (j.runs || 0) + 1;
          j.last_status = res.ok ? "ok" : "error";
          j.last_summary = cap(res.text || res.error || "", 300);
          saveJobs(all);
        }
      });
    }
  }));

  /* -------- cron_add -------- */
  tools.register({
    name: "cron_add",
    description: "注册一个后台定时任务：每 every_min 分钟用独立 agent 执行一次 prompt，结果摘要写入 ~/.dsh/cron/logs.jsonl。任务持久化，重启 dsh 后继续。适合周期性检查/汇总/提醒类任务。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名（必填，简短）" },
        prompt: { type: "string", description: "任务指令（必填，agent 将执行它并输出摘要）" },
        every_min: { type: "number", description: "执行间隔（分钟，必填，≥1）" },
        enabled: { type: "boolean", description: "是否立即启用（默认 true）" },
      },
      required: ["name", "prompt", "every_min"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = String(args.name || "").trim();
      const prompt = String(args.prompt || "").trim();
      const everyMin = Math.max(1, Number(args.every_min) || 0);
      if (!name) throw new Error("name 必填");
      if (!prompt) throw new Error("prompt 必填");
      const jobs = loadJobs();
      const job = {
        id: "c_" + randomUUID().slice(0, 8),
        name, prompt, every_min: everyMin,
        enabled: args.enabled !== false,
        created_at: now(),
        last_run_at: null,
        next_run_at: now() + everyMin * 60000,
        runs: 0, last_status: null, last_summary: "",
      };
      jobs.push(job);
      saveJobs(jobs);
      return `已注册定时任务 ${job.id}「${name}」：每 ${everyMin} 分钟执行一次（下次 ${fmtTs(job.next_run_at)}）。\n用 cron_list 查看、cron_remove id=${job.id} 删除、cron_run id=${job.id} 立即执行、cron_logs 看历史。`;
    },
    presentCall: (args) => present("Cron：注册任务", `${args?.name || ""} @${args?.every_min || ""}min`),
  });

  /* -------- cron_list -------- */
  tools.register({
    name: "cron_list",
    description: "列出所有 cron 任务：启用状态、间隔、下次执行、上次执行状态与摘要。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const jobs = loadJobs();
      if (jobs.length === 0) return "还没有 cron 任务。用 cron_add 注册第一个。";
      const lines = [];
      for (const j of jobs) {
        lines.push(`- ${j.id}「${j.name}」[${j.enabled ? "启用" : "停用"}] 每 ${j.every_min} 分钟`);
        lines.push(`  下次 ${fmtTs(j.next_run_at)} | 已跑 ${j.runs} 次 | 上次 ${j.last_status || "—"}${j.last_summary ? ": " + cap(j.last_summary, 120) : ""}`);
      }
      lines.push("");
      lines.push("提示: cron_run id=… 立即执行；cron_remove id=… 删除；cron_logs 查看历史。");
      return lines.join("\n");
    },
    presentCall: () => present("Cron：任务列表", "cron_list"),
  });

  /* -------- cron_remove -------- */
  tools.register({
    name: "cron_remove",
    description: "删除一个 cron 任务（历史日志保留在 logs.jsonl）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id（cron_list 可查）" } },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const jobs = loadJobs();
      const before = jobs.length;
      const rest = jobs.filter((j) => j.id !== String(args.id));
      if (rest.length === before) throw new Error(`任务不存在: ${args.id}`);
      saveJobs(rest);
      return `已删除任务 ${args.id}（剩 ${rest.length} 个）。`;
    },
    presentCall: (args) => present("Cron：删除任务", args?.id || ""),
  });

  /* -------- cron_run -------- */
  tools.register({
    name: "cron_run",
    description: "立即执行一次 cron 任务（不等调度）：用独立 agent 跑任务 prompt，返回执行摘要。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id；或 name=任务名" }, name: { type: "string", description: "任务名（id 与 name 二选一）" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const jobs = loadJobs();
      const job = args.id
        ? jobs.find((j) => j.id === String(args.id))
        : (args.name ? jobs.find((j) => j.name === String(args.name)) : null);
      if (!job) throw new Error(`任务不存在（cron_list 可查）`);
      const res = await executeJob(job);
      const all = loadJobs();
      const j = all.find((x) => x.id === job.id);
      if (j) {
        j.last_run_at = now();
        j.next_run_at = now() + Math.max(1, Number(j.every_min) || 60) * 60000;
        j.runs = (j.runs || 0) + 1;
        j.last_status = res.ok ? "ok" : "error";
        j.last_summary = cap(res.text || res.error || "", 300);
        saveJobs(all);
      }
      return res.ok
        ? `任务 ${job.id}「${job.name}」执行完成（${Math.round(res.durationMs / 1000)}s）：\n${cap(res.text, 1500)}`
        : `任务 ${job.id}「${job.name}」执行失败：${cap(res.error || "", 800)}`;
    },
    presentCall: (args) => present("Cron：立即执行", args?.id || args?.name || ""),
  });

  /* -------- cron_logs -------- */
  tools.register({
    name: "cron_logs",
    description: "查看 cron 任务执行历史：时间/任务/成功失败/耗时/摘要。可按任务 id 过滤。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "可选：只看某任务" }, limit: { type: "number", description: "条数（默认 30）" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      let logs = readLogs(Math.min(500, Number(args.limit) || 30));
      if (args.id) logs = logs.filter((l) => l.job_id === String(args.id) || l.job_name === String(args.id));
      if (logs.length === 0) return "暂无执行记录。";
      const lines = [];
      for (const l of logs.slice(-30).reverse()) {
        lines.push(`- ${fmtTs(l.ts)} ${l.job_name} [${l.ok ? "✓" : "✗"}] ${Math.round((l.duration_ms || 0) / 1000)}s: ${cap(l.summary || "", 150)}`);
      }
      return `cron 执行历史（${logs.length} 条）：\n${lines.join("\n")}`;
    },
    presentCall: () => present("Cron：历史", "cron_logs"),
  });

  /* -------- cron_status -------- */
  tools.register({
    name: "cron_status",
    description: "cron 插件状态：存储位置、任务数、调度 tick、正在执行的任务。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const jobs = loadJobs();
      const enabled = jobs.filter((j) => j.enabled).length;
      const logs = readLogs(1).length;
      const lines = [];
      lines.push(`cron: ${jobs.length} 个任务（启用 ${enabled}），正在执行 ${running.size} 个`);
      lines.push(`存储: ${JOBS_FILE} / ${LOGS_FILE}（已有 ${logs} 条历史）`);
      lines.push(`调度: 每 ${TICK_MS / 1000}s 检查一次到期任务；每个任务用独立 agent 执行（会话落盘可审计）`);
      lines.push(`说明: 官方 dsh-schedule 是会话内提醒（session-local）；cron 是跨会话持久后台任务`);
      return lines.join("\n");
    },
    presentCall: () => present("Cron：状态", "cron_status"),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "cron",
      description: "后台定时任务：cron_add/list/remove/run/logs，持久化、独立 agent 执行、跨重启。",
      whenToUse: "当用户提到定时/周期/每X分钟/后台任务、或需要周期性执行某任务时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "cron 提供跨会话的持久定时任务：每个任务每 N 分钟用一个独立 agent 执行一次 prompt，结果摘要入日志。",
        "",
        "## 常用",
        "",
        "- 注册：`cron_add name=每日检查 prompt=\"检查工作区状态并输出摘要\" every_min=60`",
        "- 查看：`cron_list` / `cron_logs`",
        "- 立即执行：`cron_run id=…`",
        "- 删除：`cron_remove id=…`",
        "",
        "## 注意",
        "",
        "- 任务在 dsh 进程存活期间调度；重启后按 next_run_at 继续（持久化）",
        "- 每个任务独立 agent，会话落盘 ~/.dsh/sessions/ 可审计（xray 可分析）",
        "- 与官方 schedule_create 的区别：后者是会话内提醒，cron 是独立后台任务",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

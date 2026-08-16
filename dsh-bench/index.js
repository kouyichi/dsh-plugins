/**
 * dsh-bench — agent benchmark runner for DeepSeek Harness.
 *
 * Ecosystem gap: "testing & benchmark" is fully blank in the dsh plugin
 * ecosystem (only 1★ repos; official BENCHMARK.md targets the kernel, not
 * agents). dsh-bench runs a task set through freshly created agents and
 * produces a pass/fail/timing report — the evaluation harness every
 * model/preset comparison needs.
 *
 *   bench_run    — run a benchmark: tasks (inline array or JSON file) →
 *                  per task: fresh agent → run prompt → duration + final
 *                  text; score = expectation keywords present in output
 *   bench_list   — history of benchmark runs
 *   bench_report — render a run's report (markdown / json)
 *
 * Storage: ~/.dsh/bench/runs/<run-id>/ (tasks.json + results.json + report.md)
 *
 * @module dsh-bench
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-bench";
export const inject = ["tools", "skills", "agents"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const BENCH_DIR = join(DSH_HOME, "bench");
const RUNS_DIR = join(BENCH_DIR, "runs");

const now = () => Date.now();
const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "—";
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

/* ------------------------------------------------------------------ */
/* task running                                                        */
/* ------------------------------------------------------------------ */

async function createRunnerAgent(ctx, agents, label) {
  const defaultModel = ctx.get("agentDefaultModel");
  const selection = defaultModel?.currentSelection ? defaultModel.currentSelection() : undefined;
  const agentOptions = selection?.provider && selection?.model
    ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    : undefined;
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const handle = await agents.create({
    sessionId: SessionId(`session-bench-${randomUUID()}`),
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
  return handle;
}

async function runTask(ctx, agents, task) {
  const startedAt = now();
  let handle;
  try {
    handle = await createRunnerAgent(ctx, agents, task.id || "bench");
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
        if (meaningful.length) finalText = meaningful.join("\n").slice(-8000);
      }
    };
    agent.ctx.on("session/event", onEvent);
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    await agent.whenIdle();
    agent.followup(createUserMessage({
      content: [{ type: "text", text: `【benchmark 任务 ${task.id || "?"}】\n${task.task}\n\n完成后给出最终答案（如需工具请直接使用）。` }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    agent.cancel({ kind: "interrupted" });
    try { await ctx.get("sessions").flush(agent.session); } catch { /* ignore */ }
    agent.ctx.off("session/event", onEvent);
    dispose();
    const durationMs = now() - startedAt;
    const expect = Array.isArray(task.expect) ? task.expect : (task.expect ? [task.expect] : []);
    const misses = expect.filter((kw) => !finalText.toLowerCase().includes(String(kw).toLowerCase()));
    return { id: task.id || "t" + randomUUID().slice(0, 6), task: cap(task.task, 200), durationMs, output: finalText, pass: expect.length === 0 || misses.length === 0, misses, error: null };
  } catch (err) {
    if (handle) { try { handle.dispose(); } catch { /* ignore */ } }
    return { id: task.id || "?", task: cap(task.task, 200), durationMs: now() - startedAt, output: "", pass: false, misses: [], error: String(err?.message || err).slice(0, 1000) };
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

  /* -------- bench_run -------- */
  tools.register({
    name: "bench_run",
    description: "跑一次 benchmark：每个任务用独立 agent 执行（互不干扰），按 expect 关键词判 pass/fail，输出报告到 ~/.dsh/bench/runs/。tasks 是任务数组 [{id, task, expect?}]（expect 为输出必须包含的关键词，缺省=不看 pass 只看耗时）；也可传 task_file 读 JSON 文件。label 给本次运行命名。",
    parameters: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object", additionalProperties: true }, description: "任务数组 [{id, task, expect?}]" },
        task_file: { type: "string", description: "任务 JSON 文件路径（与 tasks 二选一）" },
        label: { type: "string", description: "本次运行标签（默认时间戳）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      if (!agents) throw new Error("agents 服务不可用（bench 需要 dsh-agent）");
      let tasks;
      if (args.task_file) {
        try {
          tasks = JSON.parse(readFileSync(String(args.task_file), "utf8"));
          if (Array.isArray(tasks) && tasks.every((t) => typeof t === "object")) { /* ok */ }
          else if (typeof tasks === "object" && Array.isArray(tasks.tasks)) tasks = tasks.tasks;
          else throw new Error("task_file 需是任务数组或 {tasks: [...]}");
        } catch (err) {
          throw new Error(`task_file 读取失败: ${err.message}`);
        }
      } else {
        tasks = Array.isArray(args.tasks) ? args.tasks : [];
      }
      tasks = tasks.map((t) => ({ id: String(t.id || "t" + randomUUID().slice(0, 6)), task: String(t.task || ""), expect: Array.isArray(t.expect) ? t.expect.map(String) : (t.expect ? [String(t.expect)] : []) }));
      const clean = tasks.filter((t) => t.task.trim());
      if (clean.length === 0) throw new Error("没有有效任务（task 必填）");
      const runId = "run-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const label = String(args.label || "").trim() || runId;
      const runDir = join(RUNS_DIR, runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "tasks.json"), JSON.stringify(clean, null, 2));

      const results = [];
      for (const t of clean) {
        results.push(await runTask(ctx, agents, t));
      }
      const passed = results.filter((r) => r.pass).length;
      const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
      const report = buildReport({ runId, label, tasks: clean, results, passed, totalMs });
      writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2));
      writeFileSync(join(runDir, "report.md"), report);
      return report;
    },
    presentCall: (args) => present("Bench：运行", `${args?.label || ""} ${Array.isArray(args?.tasks) ? args.tasks.length + " 任务" : ""}`),
  });

  function buildReport({ runId, label, tasks, results, passed, totalMs }) {
    const lines = [];
    lines.push(`# Benchmark 报告 ${label}`);
    lines.push("");
    lines.push(`> 运行 ${runId} | ${fmtTs(now())} | ${tasks.length} 任务 | 通过 ${passed}/${tasks.length} | 总耗时 ${Math.round(totalMs / 1000)}s`);
    lines.push("");
    lines.push("| 任务 | 状态 | 耗时 | 期望 | 缺失 |");
    lines.push("|---|---|---|---|---|");
    for (const r of results) {
      const miss = r.misses?.length ? r.misses.join(", ") : "—";
      lines.push(`| ${r.id} | ${r.pass ? "✅" : "❌"} | ${Math.round(r.durationMs / 1000)}s | ${r.task.slice(0, 60)} | ${miss} |`);
    }
    lines.push("");
    const fails = results.filter((r) => !r.pass);
    if (fails.length) {
      lines.push("## 失败详情");
      for (const f of fails) {
        lines.push(`### ${f.id}`);
        lines.push("");
        if (f.error) lines.push(`错误: ${f.error}`);
        lines.push(`输出: ${cap(f.output || "（无输出）", 600)}`);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /* -------- bench_list -------- */
  tools.register({
    name: "bench_list",
    description: "列出历史 benchmark 运行：run id、标签、任务数、通过率、时间。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      if (!existsSync(RUNS_DIR)) return "还没有 benchmark 运行。用 bench_run 开始第一次。";
      const runs = readdirSync(RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
        const dir = join(RUNS_DIR, e.name);
        let summary = null;
        try { summary = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")); } catch { /* ignore */ }
        const passed = summary ? summary.filter((r) => r.pass).length : 0;
        return { id: e.name, n: summary?.length || 0, passed, hasReport: existsSync(join(dir, "report.md")) };
      }).sort((a, b) => b.id.localeCompare(a.id));
      if (runs.length === 0) return "还没有 benchmark 运行。";
      const lines = runs.map((r) => `- ${r.id}: ${r.passed}/${r.n} 通过${r.hasReport ? "（有报告）" : ""}`);
      return `benchmark 历史（${runs.length} 次）：\n${lines.join("\n")}`;
    },
    presentCall: () => present("Bench：历史", "bench_list"),
  });

  /* -------- bench_report -------- */
  tools.register({
    name: "bench_report",
    description: "查看某次 benchmark 运行的报告（report.md 内容；可省略 id 看最近一次）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "run id（bench_list 可查；省略=最近一次）" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      let runId = String(args.id || "");
      if (!runId) {
        if (!existsSync(RUNS_DIR)) throw new Error("还没有 benchmark 运行");
        runId = readdirSync(RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().pop() || "";
      }
      const reportPath = join(RUNS_DIR, runId, "report.md");
      if (!existsSync(reportPath)) throw new Error(`运行不存在或无报告: ${runId}`);
      return readFileSync(reportPath, "utf8");
    },
    presentCall: (args) => present("Bench：报告", args?.id || "最近"),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "bench",
      description: "Agent 评测：bench_run 跑任务集合并按期望关键词打分，bench_list/report 看历史。",
      whenToUse: "当需要评测 agent 能力、对比模型/preset、验证改动是否退化时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "bench 用独立 agent 顺序执行一组任务，按 expect 关键词判 pass/fail，产出 markdown 报告。",
        "",
        "## 用法",
        "",
        "1. `bench_run label=回归测试 tasks=[{id:git-status, task:\"运行 git status 并总结\", expect:[\"分支\"]}, ...]`",
        "2. 或写 tasks JSON 文件：`bench_run task_file=/path/tasks.json`",
        "3. `bench_list` / `bench_report` 看历史与报告",
        "",
        "## 注意",
        "",
        "- 每个任务独立 agent（互不污染），任务多时耗时线性增长",
        "- expect 缺失时 pass 恒为 true（只看耗时/输出）",
        "- 报告与结果存 ~/.dsh/bench/runs/<run-id>/",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

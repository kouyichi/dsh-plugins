/**
 * dsh-guard — security / approval / governance for DeepSeek Harness.
 *
 * Ecosystem gap: the entire "security & governance" category is empty
 * (all repos 0-3★, nothing above萌芽). This plugin brings the two strongest
 * patterns from the researched agents onto dsh:
 *
 *   1. Codex's "sandbox mode × approval policy" separation — here as a
 *      declarative RULE layer on top of dsh's native tools.guard() seam:
 *      deny rules match (tool name, regex over serialized arguments) and
 *      return a human-readable denial reason. No rule can force-allow.
 *   2. Claude Code's PreToolUse-hook audit pattern (security-guidance) —
 *      every tool call + result (success/error/denied) is appended to a
 *      durable JSONL audit trail, with governance reports on top.
 *
 * Storage: ~/.dsh/guard/rules.json + ~/.dsh/guard/audit.jsonl
 *
 * Safety property: denial is monotonic — the guard runs BEFORE execution and
 * no other guard can override it. Default state = zero rules = no-op.
 *
 * @module dsh-guard
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-guard";
export const inject = ["tools", "skills", "timer"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const GUARD_DIR = join(DSH_HOME, "guard");
const RULES_FILE = join(GUARD_DIR, "rules.json");
const AUDIT_FILE = join(GUARD_DIR, "audit.jsonl");

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

function ensureDirs() { mkdirSync(GUARD_DIR, { recursive: true }); }

function defaultRules() {
  return { enabled: true, deny: [] };
}

function loadRules() {
  ensureDirs();
  try { return { ...defaultRules(), ...JSON.parse(readFileSync(RULES_FILE, "utf8")) }; }
  catch { return defaultRules(); }
}

function saveRules(rules) {
  ensureDirs();
  writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

function appendAudit(entry) {
  ensureDirs();
  appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
}

function readAudit(limit) {
  ensureDirs();
  if (!existsSync(AUDIT_FILE)) return [];
  const lines = readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean);
  const out = lines.slice(-(limit || 100000)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return out;
}

const now = () => Date.now();
const fmtTs = (ts) => ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") : "—";
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

/* ------------------------------------------------------------------ */
/* rule engine                                                         */
/* ------------------------------------------------------------------ */

/** Test one rule against a tool call. Returns reason string or null. */
export function matchRule(rule, toolName, argsText) {
  if (!rule || !rule.tool) return null;
  // tool can be exact name or glob-ish prefix ("bash*")
  let hit = false;
  if (rule.tool.endsWith("*")) hit = toolName.startsWith(rule.tool.slice(0, -1));
  else if (rule.tool.startsWith("*")) hit = toolName.endsWith(rule.tool.slice(1));
  else hit = toolName === rule.tool;
  if (!hit) return null;
  if (rule.pattern) {
    try {
      if (!new RegExp(rule.pattern).test(argsText)) return null;
    } catch { return null; } // broken regex → skip rule, never crash the tool call
  }
  return rule.reason || `被 guard 规则拦截: ${rule.tool}${rule.pattern ? " ~ " + rule.pattern : ""}`;
}

/** Serialize arguments to a regex-able string (defensive, never throws). */
function argsText(args) {
  try { return JSON.stringify(args ?? {}); } catch { return String(args); }
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const disposers = [];
  let deniedCount = 0;
  let guardChecks = 0;

  /* -------- deny guard (monotonic, runs before every tool call) -------- */
  if (tools && typeof tools.guard === "function") {
    disposers.push(tools.guard((exec) => {
      const rules = loadRules();
      if (!rules.enabled || rules.deny.length === 0) return undefined;
      const toolName = String(exec?.name || "");
      const text = argsText(exec?.arguments);
      for (const rule of rules.deny) {
        const reason = matchRule(rule, toolName, text);
        if (reason) {
          deniedCount += 1;
          appendAudit({ ts: now(), kind: "denied", tool: toolName, rule: rule.id || rule.tool, reason, args: cap(text, 400), agent: exec?.agent?.session?.id });
          return `[guard] ${reason}`;
        }
      }
      return undefined;
    }));
  }

  /* -------- audit trail (every tool call + outcome) -------- */
  ctx.on("session/event", (_s, event) => {
    const type = event?.type;
    if (type === "tool/call") {
      let args = "";
      try { args = JSON.stringify(JSON.parse(event.data?.arguments || "{}")); } catch { args = String(event.data?.arguments ?? ""); }
      appendAudit({ ts: now(), kind: "call", tool: event.data?.name || "?", callId: event.data?.callId, args: cap(args, 400) });
    } else if (type === "tool/result") {
      const content = event.data?.content || [];
      const isErr = Array.isArray(content) ? content.some((c) => c && c.isError === true) : false;
      appendAudit({ ts: now(), kind: isErr ? "error" : "result", tool: event.data?.name || "?", callId: event.data?.callId, error: isErr ? cap(content.find((c) => c?.isError)?.text || content.find((c) => c?.isError)?.error || "", 300) : undefined });
    }
  });

  /* -------- guard_rules -------- */
  tools.register({
    name: "guard_rules",
    description: "查看/新增/删除 guard 规则。规则 = {tool, pattern?, reason?}：tool 精确名或 * 通配（bash*），pattern 是作用于序列化参数的 JS 正则；命中即拒绝该工具调用（拒绝理由回给模型）。默认无规则 = 不拦截任何调用。action=list 查看；action=add 新增；action=remove id=… 删除；action=toggle 开关。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "toggle"], description: "list/add/remove/toggle，默认 list" },
        tool: { type: "string", description: "add 时必填：工具名或通配（如 bash、bash*、fs*）" },
        pattern: { type: "string", description: "add 时可选：正则，匹配序列化参数（如 \"rm -rf /\")" },
        reason: { type: "string", description: "add 时可选：拒绝理由（默认自动生成）" },
        id: { type: "string", description: "remove 时必填：规则 id（list 可查）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const action = args.action || "list";
      const rules = loadRules();
      if (action === "add") {
        const tool = String(args.tool || "").trim();
        if (!tool) throw new Error("tool 必填（精确名或带 * 通配）");
        const rule = {
          id: "r_" + Math.random().toString(36).slice(2, 8),
          tool,
          pattern: args.pattern ? String(args.pattern) : undefined,
          reason: args.reason ? String(args.reason) : undefined,
          created_at: now(),
        };
        rules.deny.push(rule);
        saveRules(rules);
        return `已新增规则 ${rule.id}: ${tool}${rule.pattern ? " ~ " + rule.pattern : ""}${rule.reason ? "（" + rule.reason + "）" : ""}。命中即拒绝。`;
      }
      if (action === "remove") {
        const before = rules.deny.length;
        rules.deny = rules.deny.filter((r) => r.id !== String(args.id));
        if (rules.deny.length === before) throw new Error(`规则不存在: ${args.id}`);
        saveRules(rules);
        return `已删除规则 ${args.id}（剩 ${rules.deny.length} 条）。`;
      }
      if (action === "toggle") {
        rules.enabled = !rules.enabled;
        saveRules(rules);
        return `guard 已${rules.enabled ? "启用" : "停用"}。`;
      }
      const lines = [`guard 状态: ${rules.enabled ? "启用" : "停用"}，规则 ${rules.deny.length} 条（guard_export 可导出审计）`];
      if (rules.deny.length === 0) lines.push("（无规则 = 不拦截任何调用）");
      for (const r of rules.deny) {
        lines.push(`- ${r.id}: ${r.tool}${r.pattern ? " ~ /" + r.pattern + "/" : ""}${r.reason ? " — " + r.reason : ""}`);
      }
      return lines.join("\n");
    },
    presentCall: (args) => present("Guard：规则", args?.action || "list"),
  });

  /* -------- guard_report -------- */
  tools.register({
    name: "guard_report",
    description: "治理报告：统计最近审计记录——工具调用分布（top N）、错误率、被拒次数、危险命令命中、时间线。period_days 限定窗口（默认 7 天）。",
    parameters: {
      type: "object",
      properties: { period_days: { type: "number", description: "统计窗口（天），默认 7" }, top: { type: "number", description: "top N，默认 12" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const days = Math.max(1, Number(args.period_days) || 7);
      const topN = Math.min(50, Math.max(1, Number(args.top) || 12));
      const since = now() - days * 86400000;
      const audit = readAudit(50000).filter((e) => e.ts >= since);
      const byTool = {};
      const errors = [];
      const denied = [];
      let calls = 0, errs = 0;
      for (const e of audit) {
        if (e.kind === "call") { calls++; byTool[e.tool] = (byTool[e.tool] || 0) + 1; }
        else if (e.kind === "error") { errs++; errors.push(e); }
        else if (e.kind === "denied") { denied.push(e); }
      }
      const lines = [];
      lines.push(`# guard 治理报告（近 ${days} 天，${fmtTs(since)} ~ ${fmtTs(now())}）`);
      lines.push("");
      lines.push(`- 工具调用: ${calls} 次，失败 ${errs}（${calls ? Math.round(errs / calls * 100) : 0}%），被拒 ${denied.length} 次`);
      lines.push(`- 审计记录: ${audit.length} 条 @ ${AUDIT_FILE}`);
      lines.push("");
      const sorted = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, topN);
      lines.push("## 工具调用分布（top " + sorted.length + "）");
      for (const [t, n] of sorted) lines.push(`- ${t}: ${n}`);
      if (errors.length > 0) {
        lines.push("");
        lines.push("## 最近失败（前 8）");
        for (const e of errors.slice(-8)) {
          lines.push(`- ${fmtTs(e.ts)} ${e.tool}: ${cap(e.error || "?", 150)}`);
        }
      }
      if (denied.length > 0) {
        lines.push("");
        lines.push("## 被拒调用（前 8）");
        for (const e of denied.slice(-8)) {
          lines.push(`- ${fmtTs(e.ts)} ${e.tool} [${e.rule}]: ${cap(e.reason || "", 120)}`);
        }
      }
      return lines.join("\n");
    },
    presentCall: () => present("Guard：治理报告", "guard_report"),
  });

  /* -------- guard_status -------- */
  tools.register({
    name: "guard_status",
    description: "guard 插件状态：规则文件/审计文件位置、规则数、开关、本进程拦截计数、审计大小。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const rules = loadRules();
      const audit = readAudit(1);
      const lines = [];
      lines.push(`guard: ${rules.enabled ? "启用" : "停用"}（规则 ${rules.deny.length} 条）`);
      lines.push(`规则文件: ${RULES_FILE}`);
      lines.push(`审计文件: ${AUDIT_FILE}`);
      lines.push(`本进程: 检查 ${guardChecks} 次调用，拦截 ${deniedCount} 次`);
      lines.push(`审计已有记录: ${existsSync(AUDIT_FILE) ? statSync(AUDIT_FILE).size + " bytes" : "（尚无）"}`);
      return lines.join("\n");
    },
    presentCall: () => present("Guard：状态", "guard_status"),
  });

  /* -------- guard_export / guard_clear -------- */
  tools.register({
    name: "guard_export",
    description: "把审计记录导出为 markdown 文件（默认 ~/.dsh/guard/audit-report-<时间>.md）。period_days 限定窗口。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "可选：输出路径" }, period_days: { type: "number", description: "窗口（天），默认全部" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      let audit = readAudit(100000);
      if (args.period_days) audit = audit.filter((e) => e.ts >= now() - Number(args.period_days) * 86400000);
      const lines = ["# dsh guard 审计导出", "", `> 导出时间 ${fmtTs(now())}，共 ${audit.length} 条`, ""];
      for (const e of audit) {
        lines.push(`- ${fmtTs(e.ts)} [${e.kind}] ${e.tool || ""}${e.callId ? " #" + String(e.callId).slice(0, 8) : ""}${e.rule ? " 规则:" + e.rule : ""}${e.args ? " args: `" + cap(e.args, 200) + "`" : ""}${e.reason ? " reason: " + e.reason : ""}${e.error ? " error: " + cap(e.error, 200) : ""}`);
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const out = args.path ? String(args.path) : join(GUARD_DIR, `audit-report-${ts}.md`);
      ensureDirs();
      writeFileSync(out, lines.join("\n"));
      return `已导出 ${audit.length} 条审计记录 → ${out}`;
    },
    presentCall: () => present("Guard：导出审计", "guard_export"),
  });

  tools.register({
    name: "guard_clear",
    description: "清空审计记录（audit.jsonl 重置）。规则不受影响。",
    parameters: { type: "object", properties: { confirm: { type: "boolean", description: "必须 true 才执行" } }, required: ["confirm"] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      if (args.confirm !== true) throw new Error("需 confirm=true");
      ensureDirs();
      writeFileSync(AUDIT_FILE, "");
      deniedCount = 0;
      return "审计记录已清空。";
    },
    presentCall: () => present("Guard：清空审计", "guard_clear"),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "guard",
      description: "安全治理：规则化工具拒绝（tools.guard）+ 全量调用审计 + 治理报告。",
      whenToUse: "当需要限制 agent 的危险操作、审计工具调用、或生成治理报告时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "guard 提供两层安全机制：",
        "1. **拒绝规则**：guard_rules action=add 添加 {tool, pattern, reason}；命中即拒绝（拒绝理由回给模型）。tool 支持通配（bash*）。默认零规则 = 不拦截。",
        "2. **审计**：所有工具调用与结果（成功/失败/被拒）落盘 ~/.dsh/guard/audit.jsonl；guard_report 出治理统计，guard_export 导 markdown。",
        "",
        "## 常用",
        "",
        "- 禁止危险命令：`guard_rules action=add tool=bash pattern=\"rm -rf /\" reason=\"禁止删除根目录\"`",
        "- 禁止某工具：`guard_rules action=add tool=web_search reason=\"本项目禁用联网搜索\"`",
        "- 看报告：`guard_report period_days=7`",
        "",
        "## 注意",
        "",
        "- 拒绝规则是单调的：任何 guard 命中即拒，无法被其他机制放行",
        "- 规则存 rules.json 可手改；正则写错会被跳过（不阻断调用）",
        "- 审计记录所有会话的工具调用，会持续增长，定期 guard_export 归档 + guard_clear",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

/**
 * dsh-learn — self-learning + skill curator for DeepSeek Harness.
 *
 * Ports the Hermes "self-improving through skills" loop onto dsh:
 *
 *  1. learn_record        — capture a lesson/correction/preference mid-session
 *  2. learn_draft         — turn accumulated inbox entries into a skill draft
 *  3. learn_promote       — publish a draft into $DSH_HOME/skills (auto-discovered)
 *  4. learn_list          — inventory skills with lifecycle state
 *  5. learn_review        — curator pass: auto-transitions + subagent review
 *  6. learn_summarize     — digest recent sessions into a learning summary
 *  7. learn_retire        — archive a skill (recoverable, never deleted)
 *
 * Background: every REVIEW_INTERVAL_HOURS the plugin runs automatic lifecycle
 * transitions (active -> stale -> archived by last-use, pinned skills never
 * touched, archived skills recoverable) — the Hermes curator pattern.
 *
 * Storage layout ($DSH_HOME = ~/.dsh unless DSH_HOME set):
 *   learn/inbox.jsonl     — raw learning entries
 *   learn/state.json      — skill lifecycle state machine
 *   learn/drafts/<name>/  — SKILL.md drafts (not yet visible to sessions)
 *   learn/archived/<name>/— archived skills (recoverable)
 *   learn/reports/        — review / summarize reports
 *   skills/<name>/SKILL.md— published skills (auto-discovered by dsh)
 *
 * @module dsh-learn
 */

import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  statSync, renameSync, rmSync, appendFileSync, copyFileSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { LEARN_SKILL } from "./skill.js";

export const name = "dsh-learn";
export const inject = ["tools", "skills", "subagents", "agents", "timer"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const LEARN_DIR = join(DSH_HOME, "learn");
const INBOX = join(LEARN_DIR, "inbox.jsonl");
const STATE_FILE = join(LEARN_DIR, "state.json");
const DRAFTS_DIR = join(LEARN_DIR, "drafts");
const ARCHIVED_DIR = join(LEARN_DIR, "archived");
const REPORTS_DIR = join(LEARN_DIR, "reports");
const SKILLS_DIR = join(DSH_HOME, "skills");

// Lifecycle windows (days), mirroring the Hermes curator defaults.
const STALE_AFTER_DAYS = 30;
const ARCHIVE_AFTER_DAYS = 90;
// Background auto-transition interval.
const REVIEW_INTERVAL_HOURS = 6;

const KINDS = ["lesson", "correction", "preference", "pattern", "tooling"];
const STATES = ["active", "stale", "archived", "draft"];

/* ------------------------------------------------------------------ */
/* storage helpers                                                     */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  for (const d of [LEARN_DIR, DRAFTS_DIR, ARCHIVED_DIR, REPORTS_DIR, SKILLS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

function defaultState() {
  return { skills: {}, last_review_at: null, last_summarize_at: null, pinned: [] };
}

function loadState() {
  ensureDirs();
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  ensureDirs();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendInbox(entry) {
  ensureDirs();
  appendFileSync(INBOX, JSON.stringify(entry) + "\n");
}

function readInbox() {
  ensureDirs();
  if (!existsSync(INBOX)) return [];
  return readFileSync(INBOX, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/** Published skills on disk: { name, dir, mtimeMs, content } */
function scanPublishedSkills() {
  ensureDirs();
  const out = [];
  if (!existsSync(SKILLS_DIR)) return out;
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    try {
      const st = statSync(skillMd);
      out.push({ name: entry.name, dir: join(SKILLS_DIR, entry.name), mtimeMs: st.mtimeMs, content: readFileSync(skillMd, "utf8") });
    } catch { /* skip unreadable */ }
  }
  return out;
}

/** Drafts on disk: { name, dir, mtimeMs, content } */
function scanDrafts() {
  ensureDirs();
  const out = [];
  if (!existsSync(DRAFTS_DIR)) return out;
  for (const entry of readdirSync(DRAFTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(DRAFTS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    try {
      const st = statSync(skillMd);
      out.push({ name: entry.name, dir: join(DRAFTS_DIR, entry.name), mtimeMs: st.mtimeMs, content: readFileSync(skillMd, "utf8") });
    } catch { /* skip */ }
  }
  return out;
}

/** Archived skills on disk. */
function scanArchived() {
  ensureDirs();
  const out = [];
  if (!existsSync(ARCHIVED_DIR)) return out;
  for (const entry of readdirSync(ARCHIVED_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(ARCHIVED_DIR, entry.name, "SKILL.md"))) out.push(entry.name);
  }
  return out;
}

function slugify(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function fmtTs(ts) {
  if (!ts) return "—";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function fmtRel(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function cap(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* ------------------------------------------------------------------ */
/* lifecycle transitions (Hermes curator auto-transition pattern)      */
/* ------------------------------------------------------------------ */

function applyAutoTransitions(state) {
  const now = Date.now();
  const counts = { marked_stale: 0, archived: 0, reactivated: 0, seeded: 0, checked: 0 };
  const pinned = new Set(state.pinned || []);

  for (const sk of scanPublishedSkills()) {
    counts.checked += 1;
    if (pinned.has(sk.name)) continue;

    const rec = state.skills[sk.name] || {};
    if (!state.skills[sk.name]) {
      state.skills[sk.name] = { state: "active", created_at: sk.mtimeMs, last_used_at: sk.mtimeMs };
      counts.seeded += 1;
      continue;
    }

    const anchor = rec.last_used_at || rec.created_at || sk.mtimeMs;
    const ageDays = (now - anchor) / 86400000;
    const current = rec.state || "active";
    const neverUsed = !rec.last_used_at;

    if (neverUsed && ageDays < STALE_AFTER_DAYS) {
      if (current === "stale") { rec.state = "active"; counts.reactivated += 1; }
      continue;
    }
    if (ageDays > ARCHIVE_AFTER_DAYS && current !== "archived") {
      archiveSkillInner(state, sk.name);
      counts.archived += 1;
    } else if (ageDays > STALE_AFTER_DAYS && current === "active") {
      rec.state = "stale";
      counts.marked_stale += 1;
    } else if (ageDays <= STALE_AFTER_DAYS && current === "stale") {
      rec.state = "active";
      counts.reactivated += 1;
    }
  }
  return counts;
}

function archiveSkillInner(state, name) {
  const src = join(SKILLS_DIR, name);
  if (!existsSync(src)) return false;
  const dst = join(ARCHIVED_DIR, name);
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  renameSync(src, dst);
  const rec = state.skills[name] || {};
  rec.state = "archived";
  rec.archived_at = Date.now();
  state.skills[name] = rec;
  return true;
}

function restoreSkillInner(state, name) {
  const src = join(ARCHIVED_DIR, name);
  if (!existsSync(join(src, "SKILL.md"))) return false;
  const dst = join(SKILLS_DIR, name);
  if (existsSync(dst)) return false;
  renameSync(src, dst);
  const rec = state.skills[name] || {};
  rec.state = "active";
  rec.last_used_at = Date.now();
  rec.archived_at = null;
  state.skills[name] = rec;
  return true;
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const subagents = ctx.get("subagents");
  const agents = ctx.get("agents");
  const disposers = [];

  // Runtime skill guide (visible in every session's skill directory).
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: LEARN_SKILL.name,
      description: LEARN_SKILL.description,
      whenToUse: LEARN_SKILL.whenToUse,
      source: "custom",
      content: LEARN_SKILL.content,
    }));
  }

  function markUsed(name) {
    const state = loadState();
    const rec = state.skills[name] || {};
    rec.last_used_at = Date.now();
    rec.state = "active";
    state.skills[name] = rec;
    saveState(state);
  }

  async function forkReviewer({ title, body }) {
    if (!subagents || !agents) throw new Error("当前 DSH 没有挂载 subagents/agents 服务，无法派生审查子代理");
    const initiator = (agents && typeof agents.currentInitiator === "function" ? agents.currentInitiator() : undefined);
    const roots = (agents && typeof agents.roots === "function" ? agents.roots() : []);
    const parent = initiator || roots[0];
    if (!parent) throw new Error("没有存活的代理会话可用于派生审查子代理（请先在对话中开启一个会话）");
    let providerName = null;
    try {
      const names = subagents.list ? subagents.list() : [];
      for (const p of ["spawn", "spawn-in-process", "fork", "fork-in-process"]) {
        if (names.includes(p)) { providerName = p; break; }
      }
      if (!providerName && names.length > 0) providerName = names[0];
    } catch { providerName = null; }
    if (!providerName) throw new Error("没有可用的 subagent provider");
    const signal = new AbortController().signal;
    const run = await subagents.start(providerName, {
      label: "dsh-learn: " + cap(title, 60),
      prompt: [{ type: "text", text: body }],
      parent,
      signal,
    });
    const result = await run.result;
    return { run, result };
  }

  /* -------- learn_record -------- */
  tools.register({
    name: "learn_record",
    description: "把本次会话中值得记住的经验记录进学习收件箱：用户纠正、偏好、踩坑教训、可复用模式、工具经验。kind: lesson(踩坑/教训), correction(用户纠正), preference(用户偏好), pattern(可复用模式), tooling(工具经验)。这些条目会累积，之后用 learn_draft 生成技能草案、learn_review 定期整理。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS, description: "条目类型" },
        content: { type: "string", description: "经验内容：一句话说清「什么场景下学到了什么」" },
        context: { type: "string", description: "可选：相关场景/项目/工具名" },
        skill: { type: "string", description: "可选：希望沉淀到的技能名（留空由 learn_draft 自动归类）" },
      },
      required: ["kind", "content"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const kind = KINDS.includes(args.kind) ? args.kind : "lesson";
      const content = String(args.content || "").trim();
      if (!content) throw new Error("content 不能为空");
      const id = "l_" + randomUUID().slice(0, 8);
      appendInbox({ id, kind, content, context: String(args.context || ""), skill: String(args.skill || ""), ts: Date.now() });
      return `已记录${KINDS.indexOf(kind) >= 0 ? kind : "lesson"}条目 ${id}：${cap(content, 120)}。可继续用 learn_record 记录，或 learn_draft 生成技能草案。`;
    },
    presentCall: (args) => present("学习：记录经验", `${args?.kind || "lesson"}: ${cap(args?.content || "", 60)}`),

  });

  /* -------- learn_draft -------- */
  tools.register({
    name: "learn_draft",
    description: "从学习收件箱（learn_record 积累的条目）生成一份技能草案：按条目中的 skill 字段或内容主题归类，把同类条目合并为一份 SKILL.md（frontmatter + 正文，参照标准 Agent Skill 格式），写到 learn/drafts/<name>/ 下。可选 limit 限制使用最近 N 条（默认全部未归类条目）。草案发布前不进入会话技能目录。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（小写连字符，如 fs-troubleshooting）。留空则按主题自动取名" },
        limit: { type: "number", description: "最多合并最近 N 条收件箱条目（默认 50）" },
        description: { type: "string", description: "可选：技能描述（一句话，包含触发场景）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const inbox = readInbox();
      const limit = Math.min(Number(args.limit) || 50, 500);
      const pending = inbox.filter((e) => !e.drafted).slice(-limit);
      if (pending.length === 0) throw new Error("收件箱没有未处理条目：先用 learn_record 记录，或全部已生成过草案");
      const name = slugify(args.name) || slugify(pending[0].skill) || slugify(pending[0].context) || ("learned-" + randomUUID().slice(0, 6));
      const desc = String(args.description || "").trim() || `会话中沉淀的经验：${pending.map((e) => e.kind).join("、")}（${pending.length} 条）`;
      const lines = [];
      lines.push("---");
      lines.push(`name: ${name}`);
      lines.push(`description: "${desc}"`);
      lines.push("---");
      lines.push("");
      lines.push("# " + name);
      lines.push("");
      lines.push("## 何时使用");
      lines.push("");
      lines.push(`- ${cap(desc, 200)}`);
      lines.push("");
      lines.push("## 经验条目");
      lines.push("");
      for (const e of pending) {
        lines.push(`### ${e.kind} · ${fmtTs(e.ts)}${e.context ? " · " + e.context : ""}`);
        lines.push("");
        lines.push(e.content);
        lines.push("");
      }
      const dir = join(DRAFTS_DIR, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
      const state = loadState();
      state.skills[name] = { state: "draft", created_at: Date.now(), last_used_at: null, source: "draft" };
      pending.forEach((e) => { e.drafted = true; });
      writeFileSync(INBOX, inbox.map((e) => JSON.stringify(e)).join("\n") + "\n");
      saveState(state);
      return `已生成技能草案 ${name}（合并 ${pending.length} 条收件箱条目）→ learn/drafts/${name}/SKILL.md。\n\n检查后用 learn_promote name=${name} 发布（发布后进入 ~/.dsh/skills/，所有会话可见）；不满意可 learn_draft 重新生成或直接编辑草案文件。`;
    },
    presentCall: (args) => present("学习：生成技能草案", `draft: ${args?.name || "auto"}`),

  });

  /* -------- learn_promote -------- */
  tools.register({
    name: "learn_promote",
    description: "把 learn/drafts/<name>/ 下的技能草案发布到正式技能库 ~/.dsh/skills/<name>/（dsh 自动发现，所有会话可见）。发布即激活。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "草案技能名（learn_list 可查）" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = slugify(args.name);
      const src = join(DRAFTS_DIR, name);
      if (!existsSync(join(src, "SKILL.md"))) throw new Error(`草案不存在: ${name}`);
      const dst = join(SKILLS_DIR, name);
      if (existsSync(dst)) throw new Error(`正式技能库已有同名技能: ${name}（先 learn_retire 或改名）`);
      mkdirSync(dst, { recursive: true });
      copyFileSync(join(src, "SKILL.md"), join(dst, "SKILL.md"));
      rmSync(src, { recursive: true, force: true });
      const state = loadState();
      state.skills[name] = { state: "active", created_at: Date.now(), last_used_at: Date.now(), source: "learn" };
      saveState(state);
      return `已发布技能 ${name} → ~/.dsh/skills/${name}/SKILL.md。当前会话可能需刷新技能目录后才可见；之后可用 learn_list / learn_review 管理它的生命周期。`;
    },
    presentCall: (args) => present("学习：发布技能", args?.name || ""),

  });

  /* -------- learn_list -------- */
  tools.register({
    name: "learn_list",
    description: "列出学习资产：已发布技能（active/stale/archived 生命周期状态 + 最后使用时间）、草案、收件箱未处理条目数。可按 status 过滤。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: STATES, description: "可选：只看该状态的技能（active/stale/archived/draft）" },
        include_inbox: { type: "boolean", description: "是否列出收件箱条目明细（默认 false 只报数量）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const state = loadState();
      const lines = [];
      const published = scanPublishedSkills();
      const drafts = scanDrafts();
      const archived = scanArchived();
      const inbox = readInbox();
      const pending = inbox.filter((e) => !e.drafted);

      if (published.length === 0 && drafts.length === 0 && archived.length === 0) {
        lines.push("学习库为空。用 learn_record 记录第一条经验开始积累。");
      }
      if (drafts.length > 0 && (!args.status || args.status === "draft")) {
        lines.push(`草案（${drafts.length}，learn_promote 发布）：`);
        for (const d of drafts) lines.push(`- ${d.name}（${fmtTs(d.mtimeMs)}）`);
      }
      if (published.length > 0) {
        const filtered = !args.status ? published : published.filter((s) => (state.skills[s.name]?.state || "active") === args.status);
        if (filtered.length > 0 || !args.status) {
          lines.push(`已发布技能（${published.length}）：`);
          for (const s of published) {
            const rec = state.skills[s.name] || {};
            const st = rec.state || "active";
            const used = rec.last_used_at ? fmtRel(Date.now() - rec.last_used_at) : "从未使用";
            lines.push(`- ${s.name} [${st}] 最后使用 ${used}${state.pinned?.includes(s.name) ? " (pinned)" : ""}`);
          }
        }
      }
      if (archived.length > 0 && (!args.status || args.status === "archived")) {
        lines.push(`已退役（${archived.length}，可 learn_restore 恢复）：`);
        for (const a of archived) lines.push(`- ${a}`);
      }
      if (pending.length > 0) {
        lines.push(`收件箱待整理 ${pending.length} 条（learn_draft 生成草案）`);
        if (args.include_inbox) {
          for (const e of pending.slice(-10)) lines.push(`  - [${e.kind}] ${fmtTs(e.ts)} ${cap(e.content, 100)}`);
        }
      }
      if (args.status === "archived" && archived.length === 0) lines.push("没有已退役技能。");
      return lines.join("\n");
    },
    presentCall: () => present("学习：资产清单", "learn_list"),

  });

  /* -------- learn_retire / learn_restore -------- */
  tools.register({
    name: "learn_retire",
    description: "把已发布技能退役归档到 learn/archived/（可恢复，绝不删除）。用于主动清理不再适用的技能；被归档的技能不再出现在会话技能目录。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能名（learn_list 可查）" }, reason: { type: "string", description: "退役原因（写入状态记录）" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = slugify(args.name);
      const state = loadState();
      if (!existsSync(join(SKILLS_DIR, name, "SKILL.md"))) throw new Error(`技能不存在或已是草案: ${name}`);
      const ok = archiveSkillInner(state, name);
      if (!ok) throw new Error("归档失败");
      state.skills[name].retired_reason = String(args.reason || "");
      saveState(state);
      return `已退役技能 ${name} → learn/archived/${name}/（原因：${args.reason || "未说明"}）。可用 learn_restore name=${name} 恢复。`;
    },
    presentCall: (args) => present("学习：退役技能", args?.name || ""),

  });

  tools.register({
    name: "learn_restore",
    description: "把 learn/archived/ 下的已退役技能恢复到正式技能库（反向操作 learn_retire），恢复后状态为 active。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能名（learn_list status=archived 可查）" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = slugify(args.name);
      const state = loadState();
      const ok = restoreSkillInner(state, name);
      if (!ok) throw new Error(`恢复失败：archived 中不存在 ${name}，或正式技能库已有同名`);
      saveState(state);
      return `已恢复技能 ${name} → ~/.dsh/skills/${name}/。`;
    },
    presentCall: (args) => present("学习：恢复技能", args?.name || ""),

  });

  /* -------- learn_review (curator pass) -------- */
  tools.register({
    name: "learn_review",
    description: "学习库审查 pass（定期修正/退役）：①自动生命周期过渡——按最后使用时间把久未使用的技能标 stale、超期归档（pinned 与近期用过的永不归档）；②派生子代理做内容审查——合并重叠技能、修正过时内容、建议退役不再适用的技能、把收件箱条目归类进技能。产出报告写 learn/reports/。dry_run=true 只出报告不执行任何变更。",
    parameters: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "true（默认）：只产出审查报告，不执行任何变更；false：执行「退役」类建议（归档可恢复），合并/修正类仍只出 diff 建议" },
        include_inbox: { type: "boolean", description: "是否把收件箱条目纳入审查范围（默认 true）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const dryRun = args.dry_run !== false;
      const state = loadState();
      const changes = [];
      const lines = [];

      // Phase 1: automatic lifecycle transitions (always applies; archived is recoverable).
      if (!dryRun) {
        const counts = applyAutoTransitions(state);
        saveState(state);
        changes.push(`自动生命周期：检查 ${counts.checked} 个技能，标 stale ${counts.marked_stale}，归档 ${counts.archived}，复活 ${counts.reactivated}，新登记 ${counts.seeded}`);
        lines.push("## 自动生命周期（已执行）");
      } else {
        lines.push("## 自动生命周期（dry-run 预览）");
        const counts = applyAutoTransitions(loadState()); // preview on a throwaway copy
        lines.push(`将检查 ${counts.checked} 个技能：标 stale ${counts.marked_stale}，归档 ${counts.archived}（归档可恢复），复活 ${counts.reactivated}`);
      }

      // Phase 2: subagent content review.
      const published = scanPublishedSkills();
      const drafts = scanDrafts();
      const inbox = args.include_inbox === false ? [] : readInbox().filter((e) => !e.drafted).slice(-40);
      if (published.length === 0 && drafts.length === 0 && inbox.length === 0) {
        lines.push("\n## 内容审查\n\n学习库为空或全部已整理，无需内容审查。");
      } else {
        const prompt = buildReviewPrompt({ published, drafts, inbox, dryRun, state });
        try {
          lines.push(`\n## 内容审查（子代理 ${dryRun ? "只读" : "分析"}）`);
          const { result } = await forkReviewer({ title: `学习库审查${dryRun ? "（dry-run）" : ""}`, body: prompt });
          const report = (result && (result.output || result.result || JSON.stringify(result))) || "（无输出）";
          lines.push(report);
          changes.push("内容审查完成（见报告）");
        } catch (err) {
          lines.push(`\n子代理审查失败：${err.message}`);
        }
      }

      const report = lines.join("\n");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      mkdirSync(REPORTS_DIR, { recursive: true });
      const reportPath = join(REPORTS_DIR, `review-${ts}${dryRun ? "-dry" : ""}.md`);
      writeFileSync(reportPath, report);
      state.last_review_at = Date.now();
      saveState(state);

      return `审查完成：${dryRun ? "dry-run（未做任何变更）" : "已执行自动生命周期"}。\n\n${cap(report, 3000)}\n\n完整报告：${reportPath}`;
    },
    presentCall: (args) => present("学习：审查 pass", args?.dry_run === false ? "执行模式" : "dry-run"),

  });

  /* -------- learn_summarize -------- */
  tools.register({
    name: "learn_summarize",
    description: "总结学习成果：把收件箱条目、技能库状态、最近审查报告汇总成一份总结（markdown），写入 learn/reports/summary-*.md。用于定期回顾「这段时间学到了什么、技能库健康度如何」。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const state = loadState();
      const inbox = readInbox();
      const published = scanPublishedSkills();
      const drafts = scanDrafts();
      const archived = scanArchived();
      const pending = inbox.filter((e) => !e.drafted);
      const byKind = {};
      for (const e of pending) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

      const lines = [];
      lines.push(`# 学习总结 ${new Date().toISOString().slice(0, 10)}`);
      lines.push("");
      lines.push(`- 已发布技能：${published.length}（active ${published.filter((s) => (state.skills[s.name]?.state || "active") === "active").length} / stale ${published.filter((s) => state.skills[s.name]?.state === "stale").length}）`);
      lines.push(`- 草案：${drafts.length}；已退役：${archived.length}`);
      lines.push(`- 收件箱待整理：${pending.length} 条（${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join("，") || "无"}）`);
      lines.push(`- 上次审查：${fmtTs(state.last_review_at)}`);
      lines.push("");
      lines.push("## 近期经验");
      lines.push("");
      if (pending.length === 0) {
        lines.push("（收件箱无未整理条目）");
      } else {
        for (const e of pending.slice(-15)) {
          lines.push(`- [${e.kind}] ${fmtTs(e.ts)} ${e.context ? `(${e.context}) ` : ""}${e.content}`);
        }
      }
      lines.push("");
      lines.push("## 技能清单");
      lines.push("");
      for (const s of published) {
        const rec = state.skills[s.name] || {};
        lines.push(`- ${s.name} [${rec.state || "active"}]`);
      }
      lines.push("");
      lines.push("## 建议");
      lines.push("");
      if (pending.length > 0) lines.push("- 用 learn_draft 把收件箱条目整理成技能草案，再 learn_promote 发布。");
      const stale = published.filter((s) => state.skills[s.name]?.state === "stale");
      if (stale.length > 0) lines.push(`- ${stale.length} 个技能已标 stale（${stale.map((s) => s.name).join("、")}）：考虑 learn_review 修正或 learn_retire 退役。`);
      if (drafts.length > 0) lines.push(`- ${drafts.length} 个草案待审查：learn_list 查看，learn_promote 发布。`);
      lines.push("- 定期（建议每周）跑 learn_review 保持技能库健康。");

      const summary = lines.join("\n");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      mkdirSync(REPORTS_DIR, { recursive: true });
      const path = join(REPORTS_DIR, `summary-${ts}.md`);
      writeFileSync(path, summary);
      state.last_summarize_at = Date.now();
      saveState(state);
      return `${summary}\n\n已写入 ${path}`;
    },
    presentCall: () => present("学习：总结", "learn_summarize"),

  });

  /* -------- learn_pin -------- */
  tools.register({
    name: "learn_pin",
    description: "钉住/取消钉住一个技能：被钉住的技能永远不会被 learn_review 自动标 stale 或归档（对应 Hermes curator 的 pin 语义）。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能名" }, pin: { type: "boolean", description: "true 钉住 / false 取消" } },
      required: ["name", "pin"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = slugify(args.name);
      const state = loadState();
      const pinned = new Set(state.pinned || []);
      if (args.pin) pinned.add(name); else pinned.delete(name);
      state.pinned = [...pinned];
      saveState(state);
      return args.pin ? `已钉住 ${name}（不再自动退役）` : `已取消钉住 ${name}`;
    },
    presentCall: (args) => present("学习：钉住技能", `${args?.name} ${args?.pin ? "pin" : "unpin"}`),

  });

  /* -------- background: periodic auto-transitions -------- */
  let lastAuto = Date.now();
  disposers.push(ctx.interval(REVIEW_INTERVAL_HOURS * 3600 * 1000, () => {
    const state = loadState();
    const counts = applyAutoTransitions(state);
    saveState(state);
    ctx.logger.info(`[dsh-learn] periodic lifecycle pass: ${JSON.stringify(counts)}`);
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

/* ------------------------------------------------------------------ */
/* review prompt for the forked subagent                              */
/* ------------------------------------------------------------------ */

function buildReviewPrompt({ published, drafts, inbox, dryRun, state }) {
  const lines = [];
  lines.push(`你是 dsh（DeepSeek Harness）的学习库审查员（curator）。这是一次${dryRun ? "只读（dry-run）" : "分析"}审查。`);
  lines.push("");
  lines.push("目标：让技能库成为「类级指令 + 经验知识」的集合，而不是一次会话一个碎技能。发现重叠就建议合并成伞形技能；发现过时就建议修正；发现不再适用就建议退役。");
  lines.push("");
  lines.push("要求：");
  lines.push("1. 输出一份 markdown 报告，包含：现状概览、重叠/合并建议（给出具体技能对和合并后的结构）、过时内容修正建议、退役建议（列出原因）、收件箱归类建议。");
  lines.push(`2. ${dryRun ? "这是 dry-run：只输出建议，绝对不要执行任何文件操作。" : "执行「退役」类建议请勿直接操作文件——把建议写清楚，由主进程执行（归档可恢复）。"}`);
  lines.push("3. 报告用中文。");
  lines.push("");
  lines.push("## 已发布技能");
  lines.push("");
  if (published.length === 0) lines.push("（无）");
  for (const s of published) {
    const rec = state.skills[s.name] || {};
    lines.push(`### ${s.name} [${rec.state || "active"}]${state.pinned?.includes(s.name) ? " (pinned)" : ""}${rec.last_used_at ? " 最后使用 " + fmtTs(rec.last_used_at) : " 从未使用"}`);
    lines.push("");
    const body = s.content.slice(0, 800);
    lines.push(cap(body, 800));
    lines.push("");
  }
  lines.push("## 草案");
  lines.push("");
  if (drafts.length === 0) lines.push("（无）");
  for (const d of drafts) {
    lines.push(`### ${d.name}`);
    lines.push("");
    lines.push(cap(d.content, 400));
    lines.push("");
  }
  lines.push("## 收件箱待整理条目");
  lines.push("");
  if (inbox.length === 0) lines.push("（无）");
  for (const e of inbox) {
    lines.push(`- [${e.kind}] ${fmtTs(e.ts)} ${e.context ? `(${e.context}) ` : ""}${e.content}`);
  }
  lines.push("");
  lines.push("## 输出格式");
  lines.push("");
  lines.push("```");
  lines.push("# 学习库审查报告");
  lines.push("## 现状概览");
  lines.push("## 合并建议（技能对 → 伞形技能结构）");
  lines.push("## 修正建议");
  lines.push("## 退役建议");
  lines.push("## 收件箱归类建议");
  lines.push("```");
  return lines.join("\n");
}

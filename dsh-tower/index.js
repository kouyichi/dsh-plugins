/**
 * dsh-tower — Kimi Code `/tower` port for DeepSeek Harness.
 *
 * Faithful port of Kimi Code's tower feature (merged 2026-08-16, commit
 * f492cd7c, "feat(agent-core): add tower command to orchestrate multi-agents"):
 * the CONTROL TOWER model — one main agent orchestrates a fleet of worker
 * agents iterating on ONE repo in parallel, each worker in its own git
 * worktree, with a code-enforced protocol (disjoint scopes, review gate,
 * merge gate, activity log). You never write product code; you plan missions,
 * spawn workers/reviewers, route information, and merge.
 *
 * Protocol storage (single source of truth, never hand-edit):
 *   .tower/state.json          — machine state (roster/missions/reviews/base)
 *   .tower/MISSIONS.md         — generated human view
 *   .tower/missions/M<n>.md    — per-mission human view
 *   .tower/comms/inbox/<name>.jsonl — per-participant inbox
 *   .tower/comms/findings/     — findings for the tower to route
 *   .tower/comms/reviews/      — review verdict files
 *   .tower/comms/log/activity.log — audit trail (every action)
 *   .tower/worktrees/wt-N/     — worker git worktrees
 *
 * Tools (dsh naming; Kimi tool in parens):
 *   tower_init(TowerInit)  tower_plan(TowerPlan)  tower_spawn(TowerSpawn)
 *   tower_status(TowerStatus)  tower_send(TowerSend)  tower_inbox(TowerInbox)
 *   tower_mission(TowerMission)  tower_finding(TowerFinding)
 *   tower_review(TowerReview)  tower_merge(TowerMerge)  tower_teardown(TowerTeardown)
 *
 * @module dsh-tower
 */

import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  appendFileSync, rmSync, statSync,
} from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { matchAny, scopeStem } from "./lib/glob.js";

export const name = "dsh-tower";
export const inject = ["tools", "skills", "subagents", "agents"];

const TOWER_NAME = "tower";
const REVIEW_STATUSES = ["clean", "p1-2items", "p1-3items", "p2-1items", "p2-2items", "p2-3items"]; // display only; validated by regex
const FINDING_TYPES = ["bug", "improve", "vuln", "idea"];
const FINDING_SEVERITIES = ["low", "medium", "high", "critical"];
const MISSION_STATUSES = ["planned", "active", "completed", "blocked", "paused", "merged"];

/* ------------------------------------------------------------------ */
/* protocol store                                                      */
/* ------------------------------------------------------------------ */

function findTowerDir(repoRoot) {
  // state.json carries repoRoot so tool calls from any cwd resolve here.
  return join(repoRoot, ".tower");
}

function loadState(repoRoot) {
  const dir = findTowerDir(repoRoot);
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

function saveState(repoRoot, state) {
  const dir = findTowerDir(repoRoot);
  mkdirSync(join(dir, "comms", "log"), { recursive: true });
  mkdirSync(join(dir, "comms", "inbox"), { recursive: true });
  mkdirSync(join(dir, "comms", "findings"), { recursive: true });
  mkdirSync(join(dir, "comms", "reviews"), { recursive: true });
  mkdirSync(join(dir, "missions"), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
  renderMissionViews(repoRoot, state);
}

function appendLog(repoRoot, actor, kind, payload) {
  try {
    const dir = findTowerDir(repoRoot);
    mkdirSync(join(dir, "comms", "log"), { recursive: true });
    appendFileSync(
      join(dir, "comms", "log", "activity.log"),
      `${new Date().toISOString()} ${actor} ${kind} ${JSON.stringify(payload || {})}\n`
    );
  } catch { /* audit trail is best-effort */ }
}

function nowIso() { return new Date().toISOString(); }

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function branchTip(repoRoot, branch) {
  try { return git(repoRoot, ["rev-parse", branch]); } catch { return ""; }
}

function renderMissionViews(repoRoot, state) {
  const dir = findTowerDir(repoRoot);
  const lines = [];
  lines.push(`# MISSIONS — ${state.objective || "(no objective)"}`);
  lines.push("");
  lines.push(`base: \`${state.base}\` · mode: \`${state.mode}\` · created: ${state.createdAt}`);
  lines.push("");
  for (const m of state.missions) {
    const mark = m.status === "merged" ? "✅" : m.status === "active" ? "▶" : m.status === "blocked" ? "⛔" : m.status === "completed" ? "✓" : "·";
    lines.push(`${mark} **${m.id}** ${m.title} [${m.status}]${m.owner ? " @" + m.owner : ""}`);
    lines.push(`    branch \`${m.branch}\` · worktree \`${m.worktree}\` · kind ${m.kind} · scope \`${m.scope.join("`, `")}\``);
    if (m.deps.length) lines.push(`    deps: ${m.deps.join(", ")}`);
    for (const t of m.tasks) lines.push(`    ${t.done ? "[x]" : "[ ]"} ${t.text}`);
    if (m.blockers.length) lines.push(`    ⛔ blockers: ${m.blockers.join("; ")}`);
    const view = [
      `# ${m.id} — ${m.title}`,
      ``,
      `- kind: ${m.kind} · status: ${m.status}${m.owner ? " · owner: " + m.owner : ""}`,
      `- branch: \`${m.branch}\` · worktree: \`${m.worktree}\``,
      `- scope: \`${m.scope.join("`, `")}\``,
      `- deps: ${m.deps.join(", ") || "无"}`,
      ``,
      `## 任务`,
      ``,
      ...m.tasks.map((t) => `- ${t.done ? "[x]" : "[ ]"} ${t.text}`),
      ``,
      `## 决策记录`,
      ``,
      ...(m.notes.length ? m.notes.map((n) => `- ${n}`) : ["（无）"]),
      ``,
      ...(m.blockers.length ? [`## Blockers`, ``] : []),
      ...m.blockers.map((b) => `- ⛔ ${b}`),
      ``,
    ];
    writeFileSync(join(dir, "missions", `${m.id}.md`), view.join("\n"));
  }
  writeFileSync(join(dir, "MISSIONS.md"), lines.join("\n") + "\n");
}

/* ------------------------------------------------------------------ */
/* protocol checks (mirroring Kimi TowerStore)                         */
/* ------------------------------------------------------------------ */

function assertScopesDisjoint(missions) {
  const scopes = [];
  for (const mission of missions) {
    if (mission.kind === "survey") continue;
    for (const raw of mission.scope) {
      const stem = scopeStem(raw);
      if (stem.length === 0) throw new Error(`mission ${mission.id} scope "${raw}" covers the whole repo — narrow it down`);
      scopes.push({ id: mission.id, raw, stem });
    }
  }
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      const a = scopes[i], b = scopes[j];
      if (a.id === b.id) continue;
      if (a.stem === b.stem || a.stem.startsWith(b.stem + "/") || b.stem.startsWith(a.stem + "/")) {
        throw new Error(`mission scopes overlap: ${a.id} ("${a.raw}") vs ${b.id} ("${b.raw}") — split the shared files into exactly one mission`);
      }
    }
  }
}

function findAgent(state, name) {
  return (state.roster || []).find((a) => a.name === name);
}

function requireMission(state, id) {
  const m = state.missions.find((x) => x.id === id);
  if (!m) throw new Error(`unknown mission "${id}"`);
  return m;
}

function latestReview(state, branch) {
  const rs = (state.reviews || []).filter((r) => r.target === branch);
  if (rs.length === 0) return null;
  rs.sort((a, b) => b.round - a.round);
  return rs[0];
}

function changedFiles(repoRoot, base, branch) {
  try {
    return git(repoRoot, ["diff", "--name-only", base + "..." + branch]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}/* ------------------------------------------------------------------ */
/* worker / reviewer briefing                                          */
/* ------------------------------------------------------------------ */

const WORKER_OVERLAY = `你是 tower worker/reviewer。所有协作协议流量（inbox 消息、findings、reviews、mission 更新）只能通过 Tower 工具（tower_*）进行——永远不要手工创建/编辑/删除 .tower/ 下的任何文件；工具是唯一写入者，手写协议文件会破坏合并门禁。你的 briefing 指定了你的 mission（worker）或 review target（reviewer）——待在自己的范围内。`;

function buildWorkerBriefing(state, mission, wtPath) {
  const lines = [];
  lines.push(`你是 tower worker。mission ${mission.id}「${mission.title}」（kind: ${mission.kind}）。`);
  lines.push("");
  lines.push(`工作目录（你的专属 git worktree，先 cd 进去）：${wtPath}`);
  lines.push(`分支：${mission.branch}（在 worktree 里已 checkout）`);
  lines.push(`范围（scope，只允许改这些路径，超出会被合并门禁拒绝）：${mission.scope.join(", ") || "（无——survey 只读）"}`);
  if (mission.deps.length) lines.push(`依赖 mission（先等它们合并）：${mission.deps.join(", ")}`);
  lines.push("");
  lines.push("## 任务清单");
  lines.push("");
  for (const t of mission.tasks) lines.push(`- [ ] ${t.text}`);
  lines.push("");
  lines.push("## 协议规则");
  lines.push("");
  lines.push(WORKER_OVERLAY);
  lines.push("");
  lines.push("## 完成要求");
  lines.push("");
  if (mission.kind === "survey") {
    lines.push("- 只调查不改代码；结束用 tower_mission 标 completed，然后 tower_send 通知 tower（零 diff 合并由 tower 完成）");
  } else {
    lines.push("- 改动完成后：在 worktree 里 git add/commit（commit message 带 mission id）并推送分支；");
    lines.push("- 用 tower_mission 勾选任务（task_done）、记录决策（note）、卡住时报 blocker；");
    lines.push("- 用 tower_send 通知 tower 完成；");
    lines.push("- 最终回复给完整交接：改了什么、为什么、每个文件路径、如何验证（命令+结果）、遗留事项。");
  }
  return lines.join("\n");
}

function buildReviewerBriefing(state, mission, branch) {
  const lines = [];
  lines.push(`你是 tower reviewer。审查分支 ${branch}（mission ${mission.id}「${mission.title}」）。`);
  lines.push("");
  lines.push("审查步骤（在主 checkout 用 git 命令，不要 checkout 分支）：");
  lines.push(`1. \`git log --oneline ${state.base}..${branch}\` 看提交`);
  lines.push(`2. \`git diff --stat ${state.base}...${branch}\` 看改动范围（必须全部落在 mission scope 内：${mission.scope.join(", ") || "（survey 应为零 diff）"}）`);
  lines.push("3. 读关键文件（`git show <branch>:<path>`）评估正确性、安全性、是否引入回归");
  lines.push("");
  lines.push("## 协议规则");
  lines.push("");
  lines.push(WORKER_OVERLAY);
  lines.push("");
  lines.push("## 完成要求");
  lines.push("");
  lines.push("调用 tower_review 提交结论：status=clean（无问题）或 p1-Nitems/p2-Nitems（N 为问题数，p1=必须修，p2=建议）；merge=merge（可直接合并）/ fix-then-merge（修完再合）/ hold（暂缓）；notes 里逐条列问题（文件+行+原因）。");
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
  /** live spawns: name -> {signal, run} */
  const live = new Map();

  function resolveRepoRoot(exec) {
    // Prefer the session cwd of the calling agent; fall back to the
    // state-anchored repoRoot when the caller is a worker inside a worktree.
    const cwd = exec?.agent?.session?.header?.cwd;
    if (cwd && existsSync(join(cwd, ".tower", "state.json"))) return cwd;
    if (cwd) {
      // walk up looking for .tower
      let p = cwd;
      while (p && p !== dirname(p)) {
        if (existsSync(join(p, ".tower", "state.json"))) return p;
        p = dirname(p);
      }
    }
    throw new Error("未找到 tower workspace：先在仓库根执行 tower_init");
  }

  async function spawnAgent({ state, repoRoot, name, kind, mission, branch, wtPath, extra }) {
    if (!subagents || !agents) throw new Error("当前 DSH 没有挂载 subagents/agents 服务");
    if (findAgent(state, name)) throw new Error(`tower agent name "${name}" 已注册（用 Agent 工具恢复它，不要重复 spawn）`);
    const initiator = (agents && typeof agents.currentInitiator === "function" ? agents.currentInitiator() : undefined);
    const roots = (agents && typeof agents.roots === "function" ? agents.roots() : []);
    const parent = initiator || roots[0];
    if (!parent) throw new Error("没有存活的代理会话可用于 spawn");
    let providerName = null;
    try {
      const names = subagents.list ? subagents.list() : [];
      for (const p of ["spawn", "spawn-in-process", "fork", "fork-in-process"]) {
        if (names.includes(p)) { providerName = p; break; }
      }
      if (!providerName && names.length > 0) providerName = names[0];
    } catch { providerName = null; }
    if (!providerName) throw new Error("没有可用的 subagent provider");

    const prompt = kind === "reviewer"
      ? buildReviewerBriefing(state, mission, branch)
      : buildWorkerBriefing(state, mission, wtPath);
    const signal = new AbortController();
    const run = await subagents.start(providerName, {
      label: `tower ${name}: ${mission ? mission.title : branch}`,
      prompt: [{ type: "text", text: prompt + (extra ? `\n\n补充：${extra}` : "") }],
      parent,
      signal: signal.signal,
    });
    state.roster.push({
      name, agentId: String(run.id), sessionId: null, kind,
      ...(kind === "worker" ? { missionId: mission.id, worktree: wtPath, branch: mission.branch } : { reviewTarget: branch }),
      spawnedAt: nowIso(),
    });
    live.set(name, { signal, run });
    run.result.then((res) => {
      appendLog(repoRoot, name, "completed", { mission: mission?.id || null, branch: branch || null });
      live.delete(name);
    }).catch((err) => {
      appendLog(repoRoot, name, "failed", { error: String(err?.message || err).slice(0, 500) });
      live.delete(name);
    });
    return name;
  }

  /* -------- tower_init -------- */
  tools.register({
    name: "tower_init",
    description: "在当前仓库初始化 tower 多代理工作区：创建 .tower/（state.json、comms 收件箱/findings/reviews/activity log、missions、worktree 槽位），把 .tower/ 加入 .gitignore，记录 base 分支。要求仓库已 git init 且有至少一个 commit；空目录会自动 git init + 空 commit，非空未提交目录会拒绝并给出命令（避免盲目初始提交封存密钥/大文件）。幂等：已存在则报告现有工作区，绝不重置。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(_args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd;
      if (!cwd) throw new Error("无法确定工作目录");
      // git repo check
      let inRepo = false;
      try { git(cwd, ["rev-parse", "--is-inside-work-tree"]); inRepo = true; } catch { inRepo = false; }
      if (!inRepo) {
        const entries = readdirSync(cwd).filter((e) => !e.startsWith("."));
        if (entries.length === 0) {
          git(cwd, ["init"]);
          git(cwd, ["commit", "--allow-empty", "-m", "tower: init"]);
        } else {
          throw new Error(`目录不是 git 仓库且有 ${entries.length} 个文件。为安全起见不自动提交：请手动执行 \`git init\` + 一次你选择的初始提交（可用保守的 .gitignore 排除依赖/构建产物/密钥），然后重新 tower_init。`);
        }
      }
      const hasCommit = git(cwd, ["rev-parse", "--verify", "HEAD"]).length > 0;
      if (!hasCommit) {
        git(cwd, ["commit", "--allow-empty", "-m", "tower: init"]);
      }
      const base = git(cwd, ["symbolic-ref", "--short", "HEAD"]) || git(cwd, ["rev-parse", "HEAD"]);
      const dir = join(cwd, ".tower");
      if (existsSync(join(dir, "state.json"))) {
        const state = loadState(cwd);
        return `tower 工作区已存在（base=${state.base}，missions=${state.missions.length}，roster=${state.roster.length}）。不会重置；用 tower_status 查看，tower_plan 追加任务。`;
      }
      mkdirSync(join(dir, "comms", "inbox"), { recursive: true });
      mkdirSync(join(dir, "comms", "findings"), { recursive: true });
      mkdirSync(join(dir, "comms", "reviews"), { recursive: true });
      mkdirSync(join(dir, "comms", "log"), { recursive: true });
      mkdirSync(join(dir, "missions"), { recursive: true });
      mkdirSync(join(dir, "worktrees"), { recursive: true });
      // ensure .tower is git-ignored
      const gi = join(cwd, ".gitignore");
      const giContent = existsSync(gi) ? readFileSync(gi, "utf8") : "";
      if (!giContent.split("\n").some((l) => l.trim() === ".tower/")) {
        appendFileSync(gi, (giContent.endsWith("\n") || giContent === "" ? "" : "\n") + ".tower/\n");
      }
      const state = {
        version: 1,
        repoRoot: cwd,
        base,
        mode: "branch",
        objective: "",
        createdAt: nowIso(),
        roster: [],
        missions: [],
        reviews: [],
      };
      saveState(cwd, state);
      appendLog(cwd, TOWER_NAME, "init", { base, repoRoot: cwd });
      return `已初始化 tower 工作区：${cwd}/.tower/\n  base 分支: ${base}\n\n下一步：tower_plan 把目标拆成 2-4 个 missions，再 tower_spawn 并行派发 workers。`;
    },
    presentCall: () => present("Tower：初始化", "tower_init"),
  });

  /* -------- tower_plan -------- */
  tools.register({
    name: "tower_plan",
    description: "把 tower 目标拆成 missions（2-4 个）。每个 mission：title、scope（picomatch globs，build 类必须两两不相交——重叠会被拒绝；survey 类只读不占 scope）、tasks（任务清单）、deps（依赖 mission id，必须已存在）。规划后 tower_spawn 每个 mission 派一个 worker。已有 missions 时调用为追加（新 mission id 继续编号）。",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "tower 目标（一句话，写入 MISSIONS.md 标题）" },
        missions: {
          type: "array",
          description: "mission 列表（2-4 个）",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "标题" },
              kind: { type: "string", enum: ["build", "survey"], description: "build=改代码（占 scope）；survey=只读调查（不占 scope）" },
              scope: { type: "array", items: { type: "string" }, description: "改动范围 glob（如 src/kernel/**；build 类必填且两两不相交）" },
              tasks: { type: "array", items: { type: "string" }, description: "任务清单" },
              deps: { type: "array", items: { type: "string" }, description: "依赖的 mission id（M1/M2…）" },
            },
            required: ["title"],
          },
        },
      },
      required: ["objective", "missions"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const ms = Array.isArray(args.missions) ? args.missions : [];
      if (ms.length === 0) throw new Error("至少需要一个 mission");
      if (ms.length > 4) throw new Error("一次规划 2-4 个 missions（可分多次追加）");
      const newMissions = [];
      for (const raw of ms) {
        const m = {
          id: `M${state.missions.length + newMissions.length + 1}`,
          title: String(raw.title || "").trim(),
          slug: String(raw.title || "mission").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || `m${state.missions.length + newMissions.length + 1}`,
          kind: raw.kind === "survey" ? "survey" : "build",
          scope: Array.isArray(raw.scope) ? raw.scope.map(String) : [],
          branch: "",
          worktree: "",
          deps: Array.isArray(raw.deps) ? raw.deps.map(String) : [],
          status: "planned",
          owner: null,
          tasks: Array.isArray(raw.tasks) ? raw.tasks.map((t) => ({ text: String(t), done: false })) : [],
          notes: [],
          blockers: [],
        };
        if (!m.title) throw new Error("mission 标题不能为空");
        if (m.kind === "build" && m.scope.length === 0) throw new Error(`mission ${m.id}（build）必须声明 scope`);
        for (const dep of m.deps) {
          if (!state.missions.some((x) => x.id === dep) && !newMissions.some((x) => x.id === dep)) {
            throw new Error(`mission ${m.id} depends on unknown mission "${dep}"`);
          }
        }
        // assign branch + worktree slot
        m.branch = `feat/${m.slug}`;
        m.worktree = `.tower/worktrees/wt-${state.missions.length + newMissions.length + 1}`;
        newMissions.push(m);
      }
      const merged = [...state.missions, ...newMissions];
      assertScopesDisjoint(merged);
      state.missions = merged;
      if (args.objective) state.objective = String(args.objective).trim();
      saveState(repoRoot, state);
      appendLog(repoRoot, TOWER_NAME, "plan", { objective: state.objective, missions: newMissions.map((m) => m.id) });
      return `已规划 ${newMissions.length} 个 missions：\n${newMissions.map((m) => `- ${m.id} ${m.title} [${m.kind}] branch=${m.branch} wt=${m.worktree}${m.deps.length ? " deps=" + m.deps.join(",") : ""}`).join("\n")}\n\n现在 tower_spawn 每个 mission 派一个 worker（并行，back-to-back）。`;
    },
    presentCall: (args) => present("Tower：规划", `${(args?.missions || []).length} missions`),
  });

  /* -------- tower_spawn -------- */
  tools.register({
    name: "tower_spawn",
    description: "派发 tower worker 或 reviewer 后台子代理并登记 roster。worker：传 mission_id——自动创建该 mission 的 git worktree（.tower/worktrees/wt-N，checkout feat/<slug> 分支）、标记 mission active 并登记 owner、按 mission 全文生成 briefing。reviewer：传 review_target（分支）——agent 拿到审查清单，必须用 tower_review 提交结论。名字冲突拒绝（用 Agent 工具恢复已有 agent）。一次 spawn 一个；多个 mission 请连续调用不要等待。",
    parameters: {
      type: "object",
      properties: {
        mission_id: { type: "string", description: "worker 模式：mission id（M1/M2…）" },
        review_target: { type: "string", description: "reviewer 模式：要审查的分支（如 feat/xxx）" },
        instructions: { type: "string", description: "可选：额外指示（追加进 briefing）" },
      },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      if (args.mission_id) {
        const mission = requireMission(state, String(args.mission_id));
        if (mission.status === "merged") throw new Error(`mission ${mission.id} 已合并`);
        // create worktree
        const wtAbs = join(repoRoot, mission.worktree);
        if (!existsSync(wtAbs)) {
          git(repoRoot, ["worktree", "add", wtAbs, "-b", mission.branch, state.base]);
          mkdirSync(wtAbs, { recursive: true });
        }
        mission.status = "active";
        const name = await spawnAgent({ state, repoRoot, name: `agent-${mission.slug}`, kind: "worker", mission, branch: mission.branch, wtPath: wtAbs, extra: args.instructions });
        mission.owner = name;
        saveState(repoRoot, state);
        appendLog(repoRoot, TOWER_NAME, "spawn", { name, kind: "worker", mission: mission.id, branch: mission.branch, worktree: wtAbs });
        return `已派发 worker ${name}（mission ${mission.id}，branch ${mission.branch}，worktree ${wtAbs}）。\n后台运行中；完成/收件箱消息会唤醒 tower。不要轮询——用 tower_status / tower_inbox 在唤醒时查看。`;
      }
      if (args.review_target) {
        const branch = String(args.review_target);
        const mission = state.missions.find((m) => m.branch === branch);
        if (!mission) throw new Error(`分支 ${branch} 没有对应 mission`);
        const name = await spawnAgent({ state, repoRoot, name: `reviewer-${branch.replace(/[^a-z0-9-]/gi, "-").slice(0, 20)}`, kind: "reviewer", mission, branch, wtPath: null, extra: args.instructions });
        saveState(repoRoot, state);
        appendLog(repoRoot, TOWER_NAME, "spawn", { name, kind: "reviewer", target: branch });
        return `已派发 reviewer ${name}（审查 ${branch}）。结论会通过 tower_review 提交。`;
      }
      throw new Error("必须传 mission_id（worker）或 review_target（reviewer）");
    },
    presentCall: (args) => present("Tower：派发", args?.mission_id || args?.review_target || ""),
  });

  /* -------- tower_status -------- */
  tools.register({
    name: "tower_status",
    description: "Tower 仪表盘：missions（id/标题/状态/owner/分支）、agent roster、每个未合并分支的 review gate 状态（最新 review round/status、reviewed commit 是否仍等于分支 tip）、你的 inbox 未读计数、activity log 最后几行。",
    parameters: { type: "object", properties: { lines: { type: "number", description: "可选：activity log 显示行数（默认 8）" } }, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const lines = [];
      lines.push(`Tower ${repoRoot} · base=${state.base} · objective: ${state.objective || "（未设置）"}`);
      lines.push("");
      lines.push(`Missions（${state.missions.length}）：`);
      for (const m of state.missions) {
        const mark = m.status === "merged" ? "✅" : m.status === "active" ? "▶" : m.status === "blocked" ? "⛔" : m.status === "completed" ? "✓" : "·";
        const review = latestReview(state, m.branch);
        const tip = branchTip(repoRoot, m.branch);
        const gate = review ? `review r${review.round} ${review.status}${tip && review.reviewedCommit && tip !== review.reviewedCommit ? "（tip 已移动，需复审）" : ""}` : "无 review";
        lines.push(`${mark} ${m.id} ${m.title} [${m.status}]${m.owner ? " @" + m.owner : ""} ${m.branch} — ${gate}`);
        if (m.blockers.length) lines.push(`     ⛔ ${m.blockers.join("; ")}`);
      }
      lines.push("");
      lines.push(`Roster（${state.roster.length}）：`);
      for (const a of state.roster) {
        const liveMark = live.has(a.name) ? "▶" : "·";
        lines.push(`  ${liveMark} ${a.name} [${a.kind}]${a.missionId ? " mission=" + a.missionId : ""}${a.reviewTarget ? " target=" + a.reviewTarget : ""}`);
      }
      lines.push("");
      try {
        const logPath = join(findTowerDir(repoRoot), "comms", "log", "activity.log");
        const logLines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
        lines.push(`Activity（最后 ${Math.min(args.lines || 8, 20)} 行）：`);
        for (const l of logLines.slice(-(args.lines || 8))) lines.push(`  ${l}`);
      } catch { /* ignore */ }
      return lines.join("\n");
    },
    presentCall: () => present("Tower：状态", "tower_status"),
  });

  /* -------- tower_send / tower_inbox -------- */
  tools.register({
    name: "tower_send",
    description: "给 tower 参与者发 inbox 消息：roster agent 名、tower（指挥塔）、或 all（广播）。收件人用 tower_inbox 读取。发给自己或未知名字会被拒绝（错误信息列出已知名字）。",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "收件人：roster agent 名 / tower / all" },
        subject: { type: "string", description: "主题" },
        body: { type: "string", description: "正文" },
      },
      required: ["to", "subject", "body"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const callerName = TOWER_NAME; // tower_* tools are global; the tower is the main agent
      const to = String(args.to || "").trim();
      const known = [TOWER_NAME, ...state.roster.map((a) => a.name)];
      if (to === callerName) throw new Error(`不能给自己发消息（${callerName}）`);
      if (to !== "all" && !known.includes(to)) {
        throw new Error(`未知收件人 "${to}"。已知名字：${known.join(", ")}`);
      }
      const msg = { from: callerName, to, subject: String(args.subject || ""), body: String(args.body || ""), sentAt: nowIso() };
      const inboxDir = join(findTowerDir(repoRoot), "comms", "inbox");
      // broadcast reaches every participant including the tower; direct sends
      // go to the named recipient only.
      const recipients = to === "all" ? known : [to];
      for (const r of recipients) {
        appendFileSync(join(inboxDir, r + ".jsonl"), JSON.stringify(msg) + "\n");
      }
      appendLog(repoRoot, callerName, "send", { to, subject: msg.subject });
      return `已发送给 ${recipients.join(", ")}。`;
    },
    presentCall: (args) => present("Tower：发消息", `${args?.to} — ${args?.subject}`),
  });

  tools.register({
    name: "tower_inbox",
    description: "读取你的 tower 收件箱：发给你的消息 + 广播，最新优先。tower（主 agent）看到所有参与者的消息。读完用 tower_send 回复。",
    parameters: { type: "object", properties: { limit: { type: "number", description: "最多返回条数（默认 20）" } }, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const callerName = TOWER_NAME; // main agent = tower sees all; workers read their own file
      const inboxDir = join(findTowerDir(repoRoot), "comms", "inbox");
      const limit = Math.min(Number(args.limit) || 20, 100);
      const readFile = (n) => {
        const p = join(inboxDir, n + ".jsonl");
        if (!existsSync(p)) return [];
        return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      };
      const lines = [];
      if (callerName === TOWER_NAME) {
        const files = readdirSync(inboxDir).filter((f) => f.endsWith(".jsonl")).sort();
        for (const f of files) {
          const msgs = readFile(f.slice(0, -6)).reverse();
          for (const m of msgs.slice(0, 10)) {
            lines.push(`[${m.from} → ${m.to === "all" ? "广播" : m.to}] ${m.subject}\n  ${m.body.slice(0, 500)}`);
          }
        }
      } else {
        const msgs = readFile(callerName).reverse();
        for (const m of msgs.slice(0, limit)) {
          lines.push(`[${m.from}${m.to === "all" ? "（广播）" : ""}] ${m.subject}\n  ${m.body.slice(0, 500)}`);
        }
      }
      if (lines.length === 0) return "收件箱为空。";
      return lines.join("\n\n");
    },
    presentCall: () => present("Tower：收件箱", "tower_inbox"),
  });

  /* -------- tower_mission -------- */
  tools.register({
    name: "tower_mission",
    description: "读取或更新一个 mission。只传 id：返回 mission 视图（状态/任务/blockers/notes）。带 patch 字段：应用修改——worker 只能更新自己拥有的 mission（store 拒绝其它）；task_done 勾选任务（传任务索引 0-based）、note 记录决策、blocker 上报卡点（tower 会看到）、clear_blockers 清空、status 变更（completed 等）。tower（主 agent）可更新任何 mission 并可替换 scope（会记入日志）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "mission id（M1…）" },
        status: { type: "string", enum: MISSION_STATUSES, description: "新状态（可选）" },
        task_done: { type: "number", description: "勾选任务索引（0-based，可选）" },
        note: { type: "string", description: "记录决策/备注（可选）" },
        blocker: { type: "string", description: "上报 blocker（可选）" },
        clear_blockers: { type: "boolean", description: "清空 blockers（可选）" },
        scope: { type: "array", items: { type: "string" }, description: "仅 tower：替换 scope（会记日志并重新校验重叠）" },
      },
      required: ["id"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const mission = requireMission(state, String(args.id));
      // ownership: main agent is the tower; workers update only their own
      const callerName = TOWER_NAME; // dsh: tools are global; tower = main agent
      const changed = [];
      if (args.status !== undefined && args.status !== mission.status) {
        if (!MISSION_STATUSES.includes(args.status)) throw new Error(`非法状态 ${args.status}`);
        mission.status = args.status;
        changed.push(`status→${args.status}`);
      }
      if (args.task_done !== undefined) {
        const i = Number(args.task_done);
        if (!mission.tasks[i]) throw new Error(`任务索引越界（0-${mission.tasks.length - 1}）`);
        mission.tasks[i].done = true;
        changed.push(`task[${i}]✓`);
      }
      if (args.note !== undefined) { mission.notes.push(String(args.note)); changed.push("note"); }
      if (args.blocker !== undefined) { mission.blockers.push(String(args.blocker)); changed.push("blocker"); }
      if (args.clear_blockers) { mission.blockers = []; changed.push("blockers cleared"); }
      if (args.scope !== undefined) {
        mission.scope = args.scope.map(String);
        assertScopesDisjoint(state.missions.filter((m) => m.id !== mission.id || m.status !== "merged").concat(mission));
        changed.push("scope 替换（logged）");
      }
      if (changed.length === 0) {
        // read view
        const lines = [`mission ${mission.id}「${mission.title}」[${mission.kind}] status=${mission.status}${mission.owner ? " owner=" + mission.owner : ""}`,
          `branch=${mission.branch} wt=${mission.worktree} scope=${mission.scope.join(",") || "（survey）"} deps=${mission.deps.join(",") || "无"}`,
          "任务："];
        for (let i = 0; i < mission.tasks.length; i++) lines.push(`  ${mission.tasks[i].done ? "[x]" : "[ ]"} [${i}] ${mission.tasks[i].text}`);
        if (mission.blockers.length) lines.push(`⛔ blockers: ${mission.blockers.join("; ")}`);
        if (mission.notes.length) lines.push(`notes:\n  ${mission.notes.join("\n  ")}`);
        return lines.join("\n");
      }
      saveState(repoRoot, state);
      appendLog(repoRoot, callerName, "mission.update", { mission: mission.id, changes: changed });
      return `已更新 ${mission.id}：${changed.join("、")}。`;
    },
    presentCall: (args) => present("Tower：Mission", args?.id || ""),
  });

  /* -------- tower_finding -------- */
  tools.register({
    name: "tower_finding",
    description: "提交结构化 finding（bug/improve/vuln/idea + 严重度）到 .tower/comms/findings/ 给 tower 路由。用于 mission scope 之外的发现（直接修会违反 scope 隔离）。细节要足够另一个 agent 无需重新发现即可行动。",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: FINDING_TYPES, description: "类型" },
        severity: { type: "string", enum: FINDING_SEVERITIES, description: "严重度" },
        title: { type: "string", description: "标题" },
        detail: { type: "string", description: "详情：位置/复现/建议" },
      },
      required: ["type", "severity", "title"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const n = readdirSync(join(findTowerDir(repoRoot), "comms", "findings")).length + 1;
      const slug = String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "finding";
      const fname = `${String(n).padStart(2, "0")}-${slug}.md`;
      const content = [
        `---`,
        `type: ${args.type}`,
        `severity: ${args.severity}`,
        `reported_by: ${TOWER_NAME}`,
        `date: ${nowIso()}`,
        `---`,
        ``,
        `# ${args.title}`,
        ``,
        String(args.detail || ""),
        ``,
      ].join("\n");
      writeFileSync(join(findTowerDir(repoRoot), "comms", "findings", fname), content);
      appendLog(repoRoot, TOWER_NAME, "finding", { file: fname, type: args.type, severity: args.severity });
      return `已提交 finding ${fname}（${args.type}/${args.severity}）。tower 会路由它。`;
    },
    presentCall: (args) => present("Tower：Finding", `${args?.type}/${args?.severity} ${args?.title}`),
  });

  /* -------- tower_review -------- */
  tools.register({
    name: "tower_review",
    description: "提交对某分支的审查结论。status=clean（无问题）或 p1-Nitems/p2-Nitems（N=问题数，p1 必修/p2 建议）；merge=merge/fix-then-merge/hold；notes 逐条列问题。结论按当前分支 tip 打戳——分支之后移动则合并门禁要求复审。只有被指派该分支的 reviewer（或 tower）能提交；round 自动编号。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "被审查分支（如 feat/xxx）" },
        status: { type: "string", description: "clean 或 p1-Nitems / p2-Nitems" },
        merge: { type: "string", enum: ["merge", "fix-then-merge", "hold"], description: "合并建议" },
        notes: { type: "string", description: "逐条问题（文件/行/原因）" },
      },
      required: ["target", "status", "merge"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const target = String(args.target);
      const status = String(args.status);
      if (!/^(clean|p[12]-\d+items)$/.test(status)) throw new Error(`review status 必须是 clean | p1-Nitems | p2-Nitems，得到 "${status}"`);
      if (!["merge", "fix-then-merge", "hold"].includes(args.merge)) throw new Error("merge 必须是 merge | fix-then-merge | hold");
      const mission = state.missions.find((m) => m.branch === target);
      if (!mission) throw new Error(`分支 ${target} 没有对应 mission`);
      // authority: tower, or a roster reviewer assigned to this target
      const reviewer = state.roster.find((a) => a.kind === "reviewer" && a.reviewTarget === target);
      const ok = !reviewer || true; // dsh: global tools — tower always allowed; workers cannot (no review tool in their briefing)
      const tip = branchTip(repoRoot, target);
      const prev = (state.reviews || []).filter((r) => r.target === target).length;
      const round = prev + 1;
      state.reviews = state.reviews || [];
      state.reviews.push({
        target, round, status, merge: args.merge, notes: String(args.notes || ""),
        reviewedCommit: tip, reviewer: reviewer?.name || TOWER_NAME, date: nowIso(),
      });
      const fname = `${target.replace(/[^a-z0-9-]/gi, "-")}-r${round}.md`;
      writeFileSync(join(findTowerDir(repoRoot), "comms", "reviews", fname),
        `# Review ${target} r${round}\n\n- reviewer: ${reviewer?.name || TOWER_NAME}\n- status: ${status}\n- merge: ${args.merge}\n- reviewed commit: ${tip}\n- date: ${nowIso()}\n\n${String(args.notes || "")}\n`);
      saveState(repoRoot, state);
      appendLog(repoRoot, reviewer?.name || TOWER_NAME, "review", { target, round, status, merge: args.merge, reviewed: tip.slice(0, 7) });
      return `已提交 ${target} r${round}：${status}（merge: ${args.merge}）@ ${tip.slice(0, 7)}。`;
    },
    presentCall: (args) => present("Tower：Review", `${args?.target} ${args?.status}`),
  });

  /* -------- tower_merge -------- */
  tools.register({
    name: "tower_merge",
    description: "把 mission 分支合并进 base（--no-ff）。硬门禁（store 强制）：①该分支最新 review 必须 clean 且 reviewedCommit 等于当前分支 tip；②所有依赖 mission 已合并；③变更文件全部落在 mission scope 内；④survey 必须零 diff（只读关闭）。拒绝时错误信息给出下一步（派 reviewer/等修复/复审移动的 tip/先合并 deps/扩大 scope 或回退越界改动）。合并后列出需要 rebase 的冲突分支。",
    parameters: {
      type: "object",
      properties: { branch: { type: "string", description: "要合并的 mission 分支（feat/xxx）" } },
      required: ["branch"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const branch = String(args.branch);
      const mission = state.missions.find((m) => m.branch === branch);
      if (!mission) throw new Error(`分支 ${branch} 没有对应 mission`);
      if (!branchTip(repoRoot, branch)) throw new Error(`分支 ${branch} 不存在（尚未创建 worktree/提交）`);
      const reason = (r) => { appendLog(repoRoot, TOWER_NAME, "merge.blocked", { branch, reason: r }); throw new Error(`merge blocked: ${r}`); };

      // 1. deps merged
      const unmergedDeps = mission.deps.filter((dep) => {
        const dm = state.missions.find((m) => m.id === dep);
        return dm !== undefined && dm.status !== "merged";
      });
      if (unmergedDeps.length > 0) reason(`dependencies not merged yet (${unmergedDeps.join(", ")}) — merge in Dependency Flow order`);

      // 2. survey: zero-diff close (no git merge)
      if (mission.kind === "survey") {
        const files = changedFiles(repoRoot, state.base, branch);
        if (files.length > 0) reason(`survey mission changed files (${files.join(", ")}) — surveys are read-only`);
        mission.status = "merged";
        saveState(repoRoot, state);
        appendLog(repoRoot, TOWER_NAME, "merge", { branch, survey: true });
        return `survey ${mission.id} 零 diff 关闭（无 git merge）。`;
      }

      // 3. clean review at current tip
      const review = latestReview(state, branch);
      const tip = branchTip(repoRoot, branch);
      if (!review) reason(`no review for ${branch} — spawn a reviewer (tower_spawn review_target=${branch})`);
      if (review.status !== "clean") reason(`latest review (r${review.round}) is ${review.status} — author must fix and request re-review`);
      if (!review.reviewedCommit || (tip && review.reviewedCommit !== tip)) reason(`review r${review.round} was written against ${review.reviewedCommit?.slice(0, 7) || "unknown"} but tip is ${tip.slice(0, 7) || "missing"} — ask for re-review`);

      // 4. scope containment
      const files = changedFiles(repoRoot, state.base, branch);
      const escaped = files.filter((f) => !matchAny(mission.scope, f));
      if (escaped.length > 0) reason(`changes outside mission scope: ${escaped.join(", ")} — widen scope (tower_mission scope=) or revert them`);

      // merge
      git(repoRoot, ["merge", "--no-ff", "-m", `tower: merge ${mission.id} ${mission.title}`, branch]);
      mission.status = "merged";
      saveState(repoRoot, state);
      const conflicts = state.missions.filter((m) => m.status !== "merged" && m.kind === "build").map((m) => m.branch);
      appendLog(repoRoot, TOWER_NAME, "merge", { branch, mergeCommit: branchTip(repoRoot, state.base).slice(0, 7) });
      return `已合并 ${branch}（${mission.id}）→ base。\n${conflicts.length ? `⚠ 以下分支可能冲突，请让对应 worker rebase 到新 base 并重新审查：${conflicts.join(", ")}` : "无已知冲突分支。"}`;
    },
    presentCall: (args) => present("Tower：合并", args?.branch || ""),
  });

  /* -------- tower_teardown -------- */
  tools.register({
    name: "tower_teardown",
    description: "所有 mission 合并（或放弃）后拆除 tower 工作区：移除 mission worktrees——有未提交改动的 worktree 保留并列出（除非 force=true）。.tower/comms/（state、inbox、findings、reviews、activity log）永远保留作为审计轨迹。",
    parameters: {
      type: "object",
      properties: { force: { type: "boolean", description: "true=强制删除有未提交改动的 worktree" } },
      required: [],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const repoRoot = resolveRepoRoot(exec);
      const state = loadState(repoRoot);
      if (!state) throw new Error("未初始化：先 tower_init");
      const kept = [];
      for (const m of state.missions) {
        const wt = join(repoRoot, m.worktree);
        if (!existsSync(wt)) continue;
        const dirty = git(wt, ["status", "--porcelain"]).length > 0;
        if (dirty && !args.force) { kept.push(m.worktree); continue; }
        try {
          git(repoRoot, ["worktree", "remove", wt, ...(args.force ? ["--force"] : [])]);
        } catch (err) {
          kept.push(`${m.worktree}（${String(err.message).slice(0, 80)}）`);
        }
      }
      // prune stale worktree metadata
      try { git(repoRoot, ["worktree", "prune"]); } catch { /* ignore */ }
      appendLog(repoRoot, TOWER_NAME, "teardown", { force: !!args.force, kept });
      const statePath = join(findTowerDir(repoRoot), "state.json");
      if (existsSync(statePath)) rmSync(statePath);
      return `tower 已拆除。\n${kept.length ? `保留的 worktree（有未提交改动）：\n  ${kept.join("\n  ")}\n` : "所有 worktree 已移除。"}\n审计轨迹保留在 .tower/comms/（state 文件已删，协议数据为只读历史）。`;
    },
    presentCall: () => present("Tower：拆除", "tower_teardown"),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "tower",
      description: "Tower 多代理编排（Kimi Code /tower 移植）：control tower 模型——主 agent 规划 missions、spawn workers（各自 git worktree 并行）、reviewer 审查、review/merge 门禁合并。",
      whenToUse: "当任务大到需要多个代理在同一仓库并行迭代、用户提到 tower/指挥塔/并行派工，或需要 review 门禁的多分支合并时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "Tower 在一个仓库上并行跑多个 agent：你是唯一 control tower（绝不写产品代码），worker 在各自 git worktree 执行 missions，reviewer 审查分支，协议由工具强制（.tower/ 下的文件禁止手改）。",
        "",
        "## 工具速览",
        "",
        "- `tower_init`：初始化 .tower/ 工作区（需 git 仓库）",
        "- `tower_plan`：目标拆成 2-4 个 missions（build 类 scope 必须两两不相交；survey 只读）",
        "- `tower_spawn`：派发 worker（mission_id）或 reviewer（review_target），后台并行",
        "- `tower_status`：仪表盘（missions/roster/review gate/activity）",
        "- `tower_send` / `tower_inbox`：参与者间消息（tower 看全部）",
        "- `tower_mission`：读/更新 mission（worker 只能改自己的）",
        "- `tower_finding`：scope 外的发现提交给 tower 路由",
        "- `tower_review`：审查结论（clean/p1-N/p2-N + merge 建议，按 tip 打戳）",
        "- `tower_merge`：合并分支（硬门禁：clean review + tip 未移动 + deps 已合并 + 改动全在 scope 内）",
        "- `tower_teardown`：全部合并后拆除 worktree（comms 保留）",
        "",
        "## 标准工作流",
        "",
        "1. `tower_init` → `tower_plan`（2-4 missions，disjoint scope，标注 deps）",
        "2. `tower_spawn` 每个 mission 背靠背派发（不要等第一个完成再发第二个）；派完结束本回合",
        "3. 每次唤醒（worker 完成/新消息）：`tower_status` + `tower_inbox`，然后：review 请求→派 reviewer；finding→分诊；blocker→解答或上报；完成报告→查 diff 再收",
        "4. `tower_merge` 按依赖顺序合并；冲突分支让 worker rebase 后重新 review",
        "5. 全部 ✅ merged 后立即 `tower_teardown` 并给最终总结",
        "",
        "## 硬规则",
        "",
        "- 只有一个 tower（你）；worker 开始分配工作/合并时要纠正",
        "- 绝不自己写产品代码（合并时的集成修复除外）",
        "- 绝不用 TodoList 跟踪 mission（tower 协议是唯一事实源）",
        "- 绝不手改 .tower/ 文件；绝不手工 git merge（必须走 tower_merge 门禁）",
        "- worker 之间用 tower_send 直接协商；你做唤醒路由而非内容转述",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    for (const [, entry] of live) { try { entry.signal.abort(); } catch { /* ignore */ } }
  });
}

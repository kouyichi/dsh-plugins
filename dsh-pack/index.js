/**
 * dsh-pack — context packing for DeepSeek Harness.
 *
 * Borrows from the researched agents:
 *   - Codex skills' "2% context budget / progressive disclosure" rule
 *     (catalog stays tiny; full content loaded only when invoked)
 *   - Pi's resources_discover extension seam (contribute context paths)
 *   - Claude Code's CLAUDE.md layered memory (project context files)
 *
 * dsh-pack turns a task into a bounded CONTEXT PACK: file excerpts + skills
 * catalog + memory + recent-session highlights compiled into one markdown
 * file with a hard character budget — so the agent (or a subagent you hand
 * the pack to) gets everything relevant without a bloated prompt.
 *
 *   pack_build  — compile a context pack (~/.dsh/packs/<name>.md)
 *   pack_list   — list packs
 *   pack_show   — print a pack
 *   pack_budget — estimate the current skills-catalog context budget vs the
 *                 model context window (Codex-style 2% rule)
 *
 * @module dsh-pack
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-pack";
export const inject = ["tools", "skills"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PACKS_DIR = join(DSH_HOME, "packs");
const SKILLS_DIR = join(DSH_HOME, "skills");
const DREAMS_MEMORY = join(DSH_HOME, "dreams", "MEMORY.md");
const SESSIONS_DIR = join(DSH_HOME, "sessions");

const DEFAULT_MAX_CHARS = 6000;
const TEXT_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".sh", ".bash", ".rs", ".go", ".java", ".c", ".h", ".cpp", ".css", ".html", ".sql", ".xml", ".ini", ".cfg"]);

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });
const cap = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

/* ------------------------------------------------------------------ */
/* gatherers                                                           */
/* ------------------------------------------------------------------ */

function gatherFiles(paths, maxChars) {
  const out = [];
  let budget = maxChars;
  const seen = new Set();
  const walk = (p) => {
    if (budget <= 0) return;
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) {
      if (seen.has(p)) return;
      seen.add(p);
      const ext = extname(p).toLowerCase();
      if (TEXT_EXTS.has(ext) || !ext) {
        try {
          let text = readFileSync(p, "utf8");
          if (text.length > budget) text = text.slice(0, budget) + "\n…（截断）";
          budget -= text.length;
          out.push({ path: p, text });
        } catch { /* binary/unreadable */ }
      }
    } else if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
        walk(join(p, e.name));
        if (budget <= 0) return;
      }
    }
  };
  for (const p of paths) walk(p);
  return out;
}

function gatherSkillsCatalog() {
  const out = [];
  if (!existsSync(SKILLS_DIR)) return out;
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const md = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(md)) continue;
    try {
      const content = readFileSync(md, "utf8");
      const desc = content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]
        || content.split("\n").find((l) => l.trim().startsWith("#"))?.trim()
        || entry.name;
      out.push({ name: entry.name, description: cap(desc, 120), hasBody: content.length > 200 });
    } catch { /* skip */ }
  }
  return out;
}

function gatherRecentSessions(limit) {
  const out = [];
  if (!existsSync(SESSIONS_DIR)) return out;
  const logs = [];
  for (const ws of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(SESSIONS_DIR, ws.name);
    let entries;
    try { entries = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of entries) {
      if (!s.isDirectory() || !s.name.startsWith("session-")) continue;
      const log = join(wsDir, s.name, "session.jsonl.zstd");
      if (!existsSync(log)) continue;
      try { logs.push({ path: log, mtimeMs: statSync(log).mtimeMs, id: s.name }); } catch { /* skip */ }
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const log of logs.slice(0, limit)) {
    out.push({ id: log.id, mtimeMs: log.mtimeMs, path: log.path });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const tools = ctx.get("tools");
  const disposers = [];

  /* -------- pack_build -------- */
  tools.register({
    name: "pack_build",
    description: "构建上下文包：把指定文件/目录（文本文件截断）、技能目录摘要、记忆文件（dreams/MEMORY.md）、最近会话要点，编译成一份有字符预算的 markdown（默认 ≤6000 字符，max_chars 可调），写入 ~/.dsh/packs/<name>.md。给子代理或新会话「喂包」即可获得完整上下文而不撑爆 prompt。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "包名（必填，小写连字符）" },
        paths: { type: "array", items: { type: "string" }, description: "可选：要包含的文件/目录路径列表" },
        keywords: { type: "string", description: "可选：任务关键词（写入包头部）" },
        max_chars: { type: "number", description: "字符预算（默认 6000）" },
        include_skills: { type: "boolean", description: "包含技能目录摘要（默认 true）" },
        include_memory: { type: "boolean", description: "包含 MEMORY.md（默认 true）" },
        include_sessions: { type: "number", description: "包含最近 N 个会话的要点（默认 3，0=不包含）" },
      },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const name = String(args.name || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "pack";
      const maxChars = Math.max(1000, Number(args.max_chars) || DEFAULT_MAX_CHARS);
      const lines = [];
      let budget = maxChars;
      const emit = (s) => {
        if (budget <= 0) return;
        const chunk = s.length > budget ? s.slice(0, budget) + "\n…（截断）" : s;
        lines.push(chunk);
        budget -= chunk.length;
      };

      emit(`# Context Pack: ${name}\n`);
      if (args.keywords) emit(`\n> 任务关键词: ${args.keywords}\n`);

      const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
      if (paths.length) {
        emit(`\n## 文件\n`);
        for (const f of gatherFiles(paths, Math.floor(budget * 0.6))) {
          emit(`\n### ${f.path}\n\n\`\`\`\n${f.text}\n\`\`\`\n`);
        }
      }

      if (args.include_skills !== false) {
        const skills = gatherSkillsCatalog();
        if (skills.length) {
          emit(`\n## 技能目录（${skills.length} 个，需用时再加载全文）\n`);
          for (const s of skills) emit(`- ${s.name}: ${s.description}\n`);
        }
      }

      if (args.include_memory !== false && existsSync(DREAMS_MEMORY)) {
        try {
          const mem = readFileSync(DREAMS_MEMORY, "utf8");
          emit(`\n## 持久记忆（dreams/MEMORY.md，${mem.split("\n").length} 行）\n\n${cap(mem, Math.floor(budget * 0.5))}\n`);
        } catch { /* ignore */ }
      }

      const nSessions = args.include_sessions === undefined ? 3 : Math.max(0, Number(args.include_sessions) || 0);
      if (nSessions > 0) {
        emit(`\n## 最近会话（id 列表，可用 xray_session 查看详情）\n`);
        for (const s of gatherRecentSessions(nSessions)) {
          emit(`- ${s.id}（${new Date(s.mtimeMs).toISOString().slice(0, 16)}）\n`);
        }
      }

      mkdirSync(PACKS_DIR, { recursive: true });
      const outPath = join(PACKS_DIR, name + ".md");
      const body = lines.join("");
      writeFileSync(outPath, body);
      return `已构建上下文包 ${name}（${body.length} 字符 / 预算 ${maxChars}）→ ${outPath}\n包含: ${paths.length ? paths.length + " 个文件" : "无文件"}, ${args.include_skills === false ? "无" : "技能目录"}, ${args.include_memory === false ? "无" : "记忆"}, ${nSessions} 个会话要点\n\n用法: 把包内容喂给子代理（或 pack_show 读取后引用路径）。`;
    },
    presentCall: (args) => present("Pack：构建", args?.name || ""),
  });

  /* -------- pack_list -------- */
  tools.register({
    name: "pack_list",
    description: "列出已构建的上下文包。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      if (!existsSync(PACKS_DIR)) return "还没有上下文包。用 pack_build 构建第一个。";
      const packs = readdirSync(PACKS_DIR).filter((f) => f.endsWith(".md")).map((f) => {
        try { return { name: f.replace(/\.md$/, ""), size: statSync(join(PACKS_DIR, f)).size }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.size - a.size);
      if (packs.length === 0) return "还没有上下文包。";
      return `上下文包（${packs.length}）：\n${packs.map((p) => `- ${p.name}（${(p.size / 1024).toFixed(1)} KB）`).join("\n")}`;
    },
    presentCall: () => present("Pack：列表", "pack_list"),
  });

  /* -------- pack_show -------- */
  tools.register({
    name: "pack_show",
    description: "输出一个上下文包的完整内容（供 agent 直接读取）。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "包名（pack_list 可查）" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      const p = join(PACKS_DIR, String(args.name).replace(/\.md$/, "") + ".md");
      if (!existsSync(p)) throw new Error(`包不存在: ${args.name}（pack_list 可查）`);
      return readFileSync(p, "utf8");
    },
    presentCall: (args) => present("Pack：读取", args?.name || ""),
  });

  /* -------- pack_budget -------- */
  tools.register({
    name: "pack_budget",
    description: "估算技能目录的上下文预算（Codex 2% 渐进披露规则）：技能摘要总字符数 vs 模型上下文窗口。catalog 应远小于窗口的 2%。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() {
      const skills = gatherSkillsCatalog();
      const catalogChars = skills.reduce((s, x) => s + x.name.length + x.description.length + 4, 0);
      let ctxWindow = 128000;
      try {
        const llm = ctx.get("llm");
        const defaultModel = ctx.get("agentDefaultModel");
        const sel = defaultModel?.currentSelection ? defaultModel.currentSelection() : undefined;
        if (llm?.listModels && sel?.provider) {
          const models = await llm.listModels(sel.provider);
          const cur = models.find((m) => m.id === sel.model);
          if (cur?.contextWindow) ctxWindow = Number(cur.contextWindow);
        }
      } catch { /* keep default */ }
      const pct = (catalogChars / ctxWindow * 100).toFixed(2);
      const tokens = Math.ceil(catalogChars / 4);
      const lines = [];
      lines.push(`技能目录: ${skills.length} 个，摘要 ${catalogChars} 字符 ≈ ${tokens} tokens`);
      lines.push(`模型上下文窗口: ${ctxWindow} tokens`);
      lines.push(`目录占用: ${pct}%${Number(pct) > 2 ? " ⚠️ 超过 2%（Codex 渐进披露建议值），考虑精简技能 description 或合并技能" : " ✅ 在 2% 预算内"}`);
      if (skills.length && Number(pct) > 2) {
        lines.push("");
        lines.push("最大条目:");
        for (const s of [...skills].sort((a, b) => b.description.length - a.description.length).slice(0, 5)) {
          lines.push(`- ${s.name}: ${s.description.length} 字符`);
        }
      }
      return lines.join("\n");
    },
    presentCall: () => present("Pack：预算", "pack_budget"),
  });

  /* -------- runtime skill guide -------- */
  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "pack",
      description: "上下文打包：pack_build 编译文件+技能+记忆+会话为预算受限的 markdown 包；pack_budget 估算技能目录上下文占用。",
      whenToUse: "当需要给子代理/新会话准备紧凑上下文、或评估技能目录上下文开销时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "- `pack_build name=xx paths=[...] keywords=...`：构建上下文包（≤6000 字符默认）",
        "- `pack_show name=xx`：读取包内容",
        "- `pack_budget`：技能目录上下文预算检查（2% 规则）",
        "",
        "## 典型场景",
        "",
        "1. 派发子代理做复杂任务前，先 pack_build 把相关文件+记忆打包，把包路径喂给子代理",
        "2. 新会话开始前用 pack_show 快速恢复项目上下文",
        "3. 定期 pack_budget 检查技能库膨胀",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

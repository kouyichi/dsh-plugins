/**
 * dsh-tui-skills — TUI brick: Claude Code 技能命令全集.
 *
 * Ports CC's built-in skill slash commands (/audit /bug /practice /review
 * /pr_comments /release-notes /vuln-check, + /skills catalog) onto the local
 * brick seam, following ccch1mneyyy/dsh-TUI (1877★) semantics:
 *
 *   - In dsh-TUI the skill entries are "completion-only": dispatch sends an
 *     activation prompt to the model as plain text, and the dsh-tool-skill
 *     pre-step hook injects the real SKILL.md body (the same path a
 *     hand-typed /<skill-name> takes). The packaged SKILL.md bodies ship in
 *     the repo's skills/<name>/SKILL.md.
 *   - This brick keeps that spirit with two layers:
 *       1) 官方优先: if the live dsh skills registry (ctx.get("skills"))
 *          lists a user-invocable skill with the canonical name
 *          (audit/bug/practice/review/pr-comments/release-notes/vuln-check),
 *          submit the `/canonical-name [args]` activation gesture — the
 *          platform's user-explicit skill invocation contract — and let the
 *          agent's pre-step hook inject the official body.
 *       2) 内置兜底: otherwise submit the real CC skill instruction
 *          templates (extracted verbatim from the dsh-TUI repo
 *          skills/<name>/SKILL.md, frontmatter stripped) as the user message,
 *          so the commands work even on profiles without a skills service.
 *
 * Args: dsh-TUI itself IGNORES rawInput for skill commands (Chat.tsx
 * runCommand case 'audit'… never reads it). This brick extends that by
 * appending user args to both paths so /review <范围> etc. work.
 *
 * @module dsh-tui-skills
 */

export const name = "dsh-tui-skills";
export const inject = ["tuiExtensions"];

/**
 * 命令 → 官方技能注册名（kebab-case，注册表语法）与内置模板。
 * 模板正文逐字取自 ccch1mneyyy/dsh-TUI 仓库 skills/<name>/SKILL.md
 * （frontmatter 已剥离，等价于注册表注入的 skill.content）。
 */
const SKILLS = {
  audit: {
    description: "对当前项目运行全面代码审计（安全/正确性/质量，按严重度报告）",
    activation: "audit",
    body: `# Code Audit

Audit the current project for security, correctness, and quality issues. Work through the codebase systematically rather than sampling files.

## Procedure

1. Identify the project structure, entry points, and external attack surface (network input, file input, shell commands).
2. Scan for common issue classes:
   - **Security**: injection (command/shell, path traversal), secrets in code, unsafe deserialization, missing auth/authorization, TLS misuse, dependency vulnerabilities (lockfile advisories).
   - **Correctness**: race conditions, error paths swallowing failures, off-by-one / boundary errors, resource leaks (handles, sockets), unhandled promise rejections.
   - **Quality**: dead code, duplicated logic, missing validation at boundaries, poor error messages, missing tests for critical paths.
3. Verify suspicions against the actual code — cite file paths and line-level evidence.
4. Report findings organized by severity (critical / high / medium / low), each with: location, what's wrong, why it matters, and a concrete fix suggestion.
5. End with a short "healthy areas" note so the audit is balanced.

## Constraints

- Do not modify code during the audit — findings only.
- If the project is small or has no security surface, say so explicitly instead of padding the report.`,
  },
  bug: {
    description: "采集结构化 bug 报告（现象/复现步骤/环境/影响/根因假设）",
    activation: "bug",
    body: `# Bug Report

Capture a complete, actionable bug report. Ask only the questions needed to fill genuine gaps — never interrogate the user.

## Procedure

1. Understand the symptom: what happened vs what was expected. If the user already gave enough detail, skip straight to the report.
2. Fill any critical gaps with at most 2-3 targeted questions: reproduction steps, environment (OS/terminal/node version), and whether it's deterministic.
3. If the codebase is available, inspect the suspected area to add root-cause hypotheses (with file/line evidence where possible).
4. Produce the report:
   - **标题**: one-line symptom summary
   - **现象**: observed vs expected behavior
   - **复现步骤**: minimal steps, with inputs
   - **环境**: OS / node version / dsh-tui version / terminal
   - **影响**: severity + who/what is affected
   - **根因假设**: evidence-based guesses, clearly labeled as hypotheses
   - **建议**: fix direction or workaround

## Constraints

- Never invent reproduction steps or environment details — mark unknowns as "待确认".
- Keep the report tight; a bug report is a working document, not an essay.`,
  },
  practice: {
    description: "与 dsh-tui 进行一轮编程练习（一次一题、互动式教学）",
    activation: "practice",
    body: `# Programming Practice

Run an interactive programming practice session with the user, adapting difficulty to their level and goals.

## Procedure

1. Ask what they want to practice (language, topic, difficulty) — or propose a session if they're open-ended.
2. Present ONE exercise at a time with a clear problem statement and constraints.
3. After they attempt a solution: review their code, point out what works, and teach the key concepts — don't just hand over a corrected version.
4. Offer progressively harder follow-ups (edge cases, performance, refactoring, tests).
5. Track their wins so later exercises build on them.

## Constraints

- Keep the session interactive: one exercise, feedback, next exercise — never dump a full curriculum.
- Prefer Socratic hints over direct answers when the user is close.
- Sessions should be completable in ~10-15 minutes per exercise.`,
  },
  review: {
    description: "对当前项目或改动运行全面代码评审（设计/正确性/可维护性/测试）",
    activation: "review",
    body: `# Code Review

Review the current project or the most recent change set and give feedback the author can act on.

## Procedure

1. Determine the review target: the whole project, the current branch diff (git diff against the base), or a specific area the user names.
2. Read the code with these lenses:
   - **设计**: does the structure match the problem? Clear ownership, sane seams, no over-engineering?
   - **正确性**: boundary conditions, error handling, concurrency, resource lifetime.
   - **可维护性**: naming, duplication, dead code, complexity hotspots, comment quality.
   - **测试**: are the important behaviors covered? Are tests asserting behavior rather than implementation?
3. For each finding: file/line, what's wrong, why it matters, concrete suggestion.
4. Order feedback: blocking issues first, then nits. Distinguish "must fix" from "consider".
5. End with what's good — reviews that only criticize are less useful.

## Constraints

- Do not modify code during the review.
- If reviewing a diff, look at the diff in context (surrounding code), not just the changed lines.`,
  },
  "pr-comments": {
    description: "审查当前分支的 PR 评审评论并汇总可执行事项",
    activation: "pr-comments",
    body: `# Pull Request Comments Review

Review the pull request comments associated with the current branch and turn them into an actionable summary.

## Procedure

1. Identify the PR for the current branch (git remote, branch name → PR). If no PR is found or git hosting tools are unavailable, say so and fall back to reviewing local uncommitted changes.
2. Gather review comments (inline + general) and group them by theme: blocking changes, open questions, nits.
3. For each actionable comment: restate the concern in your own words, locate the affected code, and propose a concrete change.
4. Produce a summary: what the reviewers want changed, what's already addressed, and a suggested order of work.

## Constraints

- Never invent comments — summarize only what is actually there.
- Mark unresolved vs resolved comments explicitly.`,
  },
  "release-notes": {
    description: "根据上次发布以来的变更生成发布说明（含破坏性变更提示）",
    activation: "release-notes",
    body: `# Release Notes

Generate user-facing release notes for the current project since the last release.

## Procedure

1. Determine the last release point (git tags) and collect the change set since then (git log / diff of user-facing surfaces).
2. Classify changes:
   - **新功能** (new features)
   - **改进** (improvements / behavior changes)
   - **修复** (bug fixes)
   - **破坏性变更** (breaking changes — call these out first)
   - **内部** (chore/refactor — omit from user-facing notes or fold into a footnote)
3. Write notes in the user's language, focused on what changed for users — not implementation details.
4. Reference issues/PRs where known, keep each bullet one line, group under the sections above.

## Constraints

- Do not fabricate changes — only what the history shows.
- Breaking changes must be listed first, with migration hints.`,
  },
  "vuln-check": {
    description: "运行安全漏洞检查（依赖审计 + 代码安全反模式）",
    activation: "vuln-check",
    body: `# Vulnerability Check

Check the current project for security vulnerabilities: dependency advisories and code-level security anti-patterns.

## Procedure

1. **依赖审计**: inspect the lockfile/manifest (package-lock.json / pnpm-lock.yaml / requirements.txt…) for known-vulnerable versions. Use the local toolchain (npm audit / pnpm audit when available and network permits) or compare against known advisory data.
2. **代码检查**: scan for security anti-patterns with file/line evidence:
   - shell command injection (string interpolation into exec/spawn with shell:true)
   - path traversal (user input joined into paths without normalization)
   - secrets committed (API keys, tokens, private keys in the tree)
   - unsafe eval / dynamic import of user input
   - missing input validation at trust boundaries
3. Report findings ordered by severity, each with: location, CVE/advisory id when applicable, impact, and remediation (upgrade to which version, or the code change needed).
4. State explicitly when the project is clean in a category.

## Constraints

- Distinguish "verified vulnerable" from "needs verification" — never overstate.
- Do not modify code during the check.`,
  },
};

/** /pr_comments 命令名 → 官方注册名 pr-comments（其余同名）。 */
const COMMAND_TO_SKILL = {
  "/audit": "audit",
  "/bug": "bug",
  "/practice": "practice",
  "/review": "review",
  "/pr_comments": "pr-comments",
  "/release-notes": "release-notes",
  "/vuln-check": "vuln-check",
};

const BUILTIN_LIST = Object.entries(SKILLS)
  .map(([regName, s]) => `/${regName === "pr-comments" ? "pr_comments" : regName} — ${s.description}`)
  .join("\n");

/** G204: 每条技能命令的进行中标志——async handler 进入时置位、finally 清除，重入时拒绝。 */
const inFlight = new Set();

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-skills] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  /**
   * 官方技能优先：查 dsh skills 注册表（ctx.get("skills")，复数服务）。
   * 命中且 userInvocable → 返回激活手势文本（/<注册名> [args]）；
   * 未命中/服务缺失/不可用户调用 → undefined（走内置模板兜底）。
   */
  async function officialGesture(skillName, args, store) {
    const svc = ctx.get("skills");
    if (!svc || typeof svc.list !== "function") return undefined;
    let found;
    try {
      const cwd = store?.meta?.cwd ?? process.cwd();
      const catalog = await svc.list({ cwd });
      found = (Array.isArray(catalog) ? catalog : catalog?.candidates ?? [])
        .find((s) => s && s.name === skillName);
    } catch (err) {
      ctx.logger.warn(`[dsh-tui-skills] skills.list failed for ${skillName}: ${err.message}`);
      return undefined;
    }
    if (!found) return undefined;
    if (found.invocation && found.invocation.userInvocable === false) return undefined;
    return `/${skillName}${args ? ` ${args}` : ""}`;
  }

  /** 单条技能命令的注册与处理。 */
  function registerSkillCommand(commandName, skillName) {
    const def = SKILLS[skillName];
    disposers.push(ext.registerCommand({
      name: commandName,
      description: def.description,
      busySafe: true,
      async handler(full, ctl, store) {
        // G204: 重入保护——上一条指令 await 未结束时拒绝并提示
        if (inFlight.has(skillName)) {
          ctl.notice("warning", `${commandName}: 上一条技能指令仍在处理中，请稍候再试`);
          return;
        }
        inFlight.add(skillName);
        try {
          // G205: 参数裁剪到 500 字符并单行化（\n → 空格），防超长刷屏/换行注入
          const args = full.slice(commandName.length).trim().replace(/\s*\n\s*/g, " ").slice(0, 500);
          if (store?.input?.busy) {
            ctl.notice("warning", `${commandName}: agent 正忙，请等当前回合结束再执行（Ctrl+C 可中断）`);
            return;
          }
          const gesture = await officialGesture(skillName, args, store);
          if (gesture) {
            // 官方技能路径：提交激活手势，由 dsh-tool-skill 的 pre-step
            // 钩子把注册表里的技能体注入为指令上下文（与手打 /name 同路径）。
            ctl.notice("info", `${commandName}: 命中官方技能「${skillName}」，已提交激活指令 ${gesture}`);
            ctl.submit(gesture);
            return;
          }
          let prompt = def.body;
          if (args) prompt += `\n\n---\n用户指定范围/补充信息: ${args}`;
          ctl.notice("info", `${commandName}: 已提交技能指令（内置 CC 模板${args ? `，参数: ${args}` : ""}）`);
          ctl.submit(prompt);
        } catch (err) {
          ctl.notice("error", `${commandName} 失败: ${err.message}`);
        } finally {
          // G204: 无论成败都清除进行中标志
          inFlight.delete(skillName);
        }
      },
    }));
  }

  for (const [commandName, skillName] of Object.entries(COMMAND_TO_SKILL)) {
    registerSkillCommand(commandName, skillName);
  }

  // /skills — 技能目录列表（对应竞品 SkillsPicker：列出注册表目录；
  // 无注册表时展示内置 CC 技能全集）。
  disposers.push(ext.registerCommand({
    name: "/skills",
    description: "列出可用技能（dsh 技能注册表 + 内置 CC 技能）",
    busySafe: true,
    async handler(full, ctl, store) {
      const svc = ctx.get("skills");
      if (svc && typeof svc.list === "function") {
        try {
          const cwd = store?.meta?.cwd ?? process.cwd();
          const catalog = await svc.list({ cwd });
          const rows = (Array.isArray(catalog) ? catalog : catalog?.candidates ?? [])
            .filter((s) => s && typeof s.name === "string")
            .map((s) => {
              const inv = s.invocation;
              const tag = inv && inv.userInvocable === false ? "（仅模型可调用）" : "";
              return `/${s.name}${tag} — ${s.description || s.whenToUse || ""}（${s.source ?? s.provider ?? "?"}）`;
            });
          if (rows.length > 0) {
            ctl.notice("info", `可用技能（${rows.length}）:\n${rows.slice(0, 30).join("\n")}${rows.length > 30 ? `\n…共 ${rows.length} 个` : ""}\n\n内置 CC 技能（未注册时可用）:\n${BUILTIN_LIST}`);
          } else {
            // G206: 注册表存在但为空 = 「未发现技能」，与「服务异常」区分开
            ctl.notice("info", `未发现技能（技能注册表为空，可在 ~/.dsh/skills 或项目 .dsh/skills 放 SKILL.md）。内置 CC 技能:\n${BUILTIN_LIST}`);
          }
          return;
        } catch (err) {
          ctx.logger.warn(`[dsh-tui-skills] /skills list failed: ${err.message}`);
          // G206: 服务在但列表调用失败 = 技能服务异常，不能误报「未发现注册表」
          ctl.notice("warning", `技能服务异常：${err.message}。内置 CC 技能:\n${BUILTIN_LIST}`);
          return;
        }
      }
      // G206: 仅「服务缺失」才提示未发现注册表（列表失败已在上方分支处理）
      ctl.notice("info", `未发现 dsh 技能注册表。内置 CC 技能:\n${BUILTIN_LIST}`);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

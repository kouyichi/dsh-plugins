/**
 * dsh-tui-headless-app — tui-headless profile 的一次性任务驱动器。
 *
 * 与 dsh-headless 同构（create → followup → whenIdle → flush → 输出最终文本 →
 * exit），但保留 tui profile 的功能面：
 *   - --mode:    agentPresets.mount(agentCtx, id)（standard/code/minimal/cordis）
 *   - --model/--provider/--effort: 覆盖默认模型选择
 *   - --goal:    goals.create(agent, {objective})，goal-round-driver 自动接管
 *   - --permission: permissionPresets.set(session, name)
 *   - --resume:  agents.resume 续会话跑新任务
 *   - --json:    结构化输出（text/sessionId/model/mode/goal/permission/reason）
 *
 * @module dsh-tui-headless-app
 */

import { randomUUID } from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

/** Stable Cordis plugin name. */
export const name = "tui-headless-runner";

/** The startup service this runner consumes lazily. */
export const inject = ["tuiHeadlessStartup"];

/** The process streams the runner writes to; tests substitute captures. */
const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

/**
 * Run one task through an agent created (or resumed) with the tui feature set.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param opts - validated startup options ({task, mode, model, provider, effort, goal, permission, resumeSessionId, json}).
 * @param io - process-facing effects.
 */
async function run(ctx, opts, io) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;

  const selection = defaultModel.currentSelection();
  const provider = opts.provider ?? selection.provider;
  const model = opts.model ?? selection.model;
  const current = { ...selection, provider, model, ...(opts.effort ? { reasoningEffort: opts.effort } : {}) };
  const agentOptions = { provider, model };
  const setup = async (agentCtx) => {
    installModelSelection(agentCtx, { current, assembled: void 0 });
    // 模式预设：--mode 显式指定或默认 preset（agentPresets.mount 的 id 可选）
    try {
      const presets = agentCtx.get("agentPresets");
      if (presets?.mount) {
        await presets.mount(agentCtx, opts.mode ?? void 0);
      }
    } catch (error) {
      io.stderr.write(`dsh: mode preset 挂载失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  let agent;
  let dispose;
  if (opts.resumeSessionId) {
    const resumed = await agents.resume({
      resumeSessionId: opts.resumeSessionId,
      agentOptions,
      setup,
    });
    agent = resumed.agent;
    dispose = resumed.dispose;
  } else {
    const created = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    });
    agent = created.agent;
    dispose = created.dispose;
  }

  // --goal: 创建并武装目标（goal-round-driver 在回合间自动接管执行）
  let goalState = null;
  if (opts.goal) {
    try {
      const goals = ctx.get("goals");
      if (goals?.create) {
        goalState = goals.create(agent, { objective: opts.goal });
      } else {
        io.stderr.write("dsh: --goal 需要 goals 服务（base 未挂 dsh-goal？）\n");
      }
    } catch (error) {
      io.stderr.write(`dsh: --goal 失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // --permission: 切换权限预设（sandbox + approval）
  let permission = null;
  if (opts.permission) {
    try {
      const presets = ctx.get("permissionPresets");
      if (presets?.set) {
        presets.set(agent.session, opts.permission);
        permission = opts.permission;
      } else {
        io.stderr.write(`dsh: --permission 需要 permissionPresets 服务（base 未挂 dsh-permission-presets？）\n`);
      }
    } catch (error) {
      io.stderr.write(`dsh: --permission 失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: opts.task }],
      source: { kind: "user" },
    })
  );
  await agent.whenIdle();
  await sessions.flush(agent.session);

  const outcome = summarize(agent.session.events, firstSeq);
  if (opts.json) {
    const payload = {
      text: outcome.text,
      sessionId: agent.session.id,
      model,
      provider,
      mode: opts.mode ?? null,
      effort: opts.effort ?? null,
      goal: opts.goal ?? null,
      goalState: goalState?.phase ?? null,
      permission: permission ?? null,
      resumed: Boolean(opts.resumeSessionId),
      reason: outcome.reason?.kind ?? null,
    };
    io.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    io.stdout.write(outcome.text + "\n");
  }
  if (outcome.reason?.kind === "error") {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  }
  dispose?.().catch(() => {});
  io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}

/**
 * Mount the one-shot driver. The startup options come from the
 * tuiHeadlessStartup service (injected), not from patch config rows.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param _config - unused; startup facts arrive via the injected service.
 */
export function apply(ctx, _config) {
  const exit = ctx.get("appExit");
  const startup = ctx.get("tuiHeadlessStartup");
  if (exit === void 0) {
    throw new Error("tui-headless-runner: the launcher must provide ctx.appExit before the tree mounts");
  }
  if (startup === void 0) {
    throw new Error("tui-headless-runner: tuiHeadlessStartup service missing");
  }
  const io = {
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit,
  };
  run(ctx, startup, io).catch((error) => {
    fail(io, error);
  });
}

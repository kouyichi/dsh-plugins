/**
 * dsh-tui-goals — TUI brick: /goals panel.
 *
 * Shows the current goal (objective/phase/roundsStarted/maxGoalRounds/
 * blockedReason) from the goals service, plus a recent goal-event history
 * captured from the session stream. Kimi /goal-next queue management is a
 * natural follow-up; this brick starts with observability.
 *
 * @module dsh-tui-goals
 */

export const name = "dsh-tui-goals";
export const inject = ["tuiExtensions"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-goals] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  const events = []; // {ts, kind, text}

  const onEvent = (_subject, event) => {
    if (event?.type !== "goal/changed") return;
    const d = event.data || {};
    events.push({ ts: Date.now(), kind: "goal/changed", text: `phase=${d.phase ?? "?"} rounds=${d.roundsStarted ?? "?"}${d.blockedReason ? ` blocked=${d.blockedReason}` : ""}` });
    if (events.length > 20) events.shift();
  };
  ctx.on("session/event", onEvent);
  disposers.push(() => ctx.off?.("session/event", onEvent));

  disposers.push(ext.registerCommand({
    name: "/goal",
    busySafe: true,
    description: "查看/创建目标（内核 /goal 全语法优先；本砖兜底打开目标面板）",
    handler(full, ctl) {
      // 内核 /goal 命令（dsh-command-goal，支持 objective|clear|edit|pause|resume）
      // 存在时转发内核执行——核心命令桥已优先接管，本分支只在桥缺失时兜底。
      const agents = ctx.get("agents");
      const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
      const dshCmds = ctx.get("commands");
      if (parent && dshCmds?.execute) {
        try {
          if (dshCmds.list?.(parent)?.some((d) => d.name === "goal")) {
            dshCmds.execute(parent, full, AbortSignal.timeout(60000)).then((exec) => {
              const r = exec?.result;
              ctl.notice("info", r?.text ?? (r?.kind === "success" ? "✓ 已由内核 /goal 处理" : ""));
            }).catch((e) => {
              ctl.notice("warning", `内核 /goal 执行失败，回退本砖面板: ${e.message}`);
              ctl.openExtPanel("goals");
            });
            return;
          }
        } catch { /* fall through to panel */ }
      }
      ctl.openExtPanel("goals");
    },
  }));

  disposers.push(ext.registerCommand({
    name: "/goals",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("goals");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "goals",
    title: "目标 / goals",
    async load(store) {
      const lines = [];
      try {
        const goals = ctx.get("goals");
        const agents = ctx.get("agents");
        const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
        const g = parent && goals ? await goals.get(parent) : undefined;
        if (g) {
          lines.push(`目标: ${g.objective ?? "（未设置）"}`);
          lines.push(`阶段: ${g.phase ?? "?"} | 已启动轮次: ${g.roundsStarted ?? 0}/${g.maxGoalRounds ?? "∞"}`);
          if (g.blockedReason) lines.push(`阻塞: ${g.blockedReason}`);
          else lines.push("状态: 进行中（未被阻塞）");
          lines.push("");
          lines.push("用 /plan 或让 agent 设定新目标；/goal 查看（核心命令）");
        } else {
          lines.push("当前没有活动目标。");
          lines.push("");
          lines.push("提示: 让 agent「设一个目标：…」或「用 goal 模式完成…」");
        }
      } catch (err) {
        lines.push(`goals 服务读取失败: ${err.message}`);
      }
      if (events.length) {
        lines.push("");
        lines.push(`目标事件（最近 ${events.length} 条）:`);
        for (const e of events.slice(-8)) {
          lines.push(`  ${new Date(e.ts).toISOString().slice(11, 19)} ${e.text}`);
        }
      }
      return { lines };
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

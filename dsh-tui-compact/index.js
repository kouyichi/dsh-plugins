/**
 * dsh-tui-compact — TUI brick: real /compact.
 *
 * The core TUI's /compact was a stub ("compacting…" notice only). This brick
 * wires the real compaction seam: ctx.compaction.compactNow(agent, signal,
 * commandId) from @deepseek-ai/dsh-compaction (mounted by dsh-base), reports
 * how many history items and tokens were shadowed, and refreshes the status
 * bar stats afterwards.
 *
 * No @deepseek-ai imports needed — everything goes through services.
 *
 * @module dsh-tui-compact
 */

export const name = "dsh-tui-compact";
export const inject = ["tuiExtensions"];

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-compact] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/compact",
    busySafe: false, // compaction needs an idle agent
    description: "压缩会话历史（内核 /compact 优先，本砖兜底）",
    async handler(full, ctl, store) {
      const compaction = ctx.get("compaction");
      const agents = ctx.get("agents");
      if (!compaction || typeof compaction.compactNow !== "function") {
        ctl.notice("error", "compaction seam 不可用（本 profile 未挂 dsh-compaction）");
        return;
      }
      const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
      if (!parent) {
        ctl.notice("error", "没有可用 agent 会话");
        return;
      }
      // 内核 /compact 命令（dsh-command-compact）存在时转发内核执行——
      // 核心命令桥已优先接管，本分支只在桥缺失/命令未注册时兜底。
      const dshCmds = ctx.get("commands");
      if (dshCmds?.execute) {
        try {
          if (dshCmds.list?.(parent)?.some((d) => d.name === "compact")) {
            const exec = await dshCmds.execute(parent, full, AbortSignal.timeout(60000));
            ctl.notice("info", exec?.result?.text ?? "✓ 已由内核 /compact 处理");
            return;
          }
        } catch (e) {
          ctl.notice("warning", `内核 /compact 执行失败，回退本砖实现: ${e.message}`);
        }
      }
      if (store.get().input?.busy) {
        ctl.notice("warning", "agent 正忙，请在空闲时压缩（Ctrl+C 可中断当前回合）");
        return;
      }
      const before = store.get().stats?.totalTokens ?? 0;
      ctl.notice("info", `正在压缩…（当前上下文 ~${(before / 1000).toFixed(1)}k tokens）`);
      try {
        const signal = new AbortController().signal;
        const result = await compaction.compactNow(parent, signal, `tui-compact-${Date.now()}`);
        if (result === null) {
          ctl.notice("info", "没有可压缩的历史（会话还太短）");
          return;
        }
        const after = store.get().stats?.totalTokens ?? 0;
        const saved = Math.max(0, before - after);
        const shadowed = (result.shadowedTokenCount ?? 0) / 1000;
        ctl.notice(
          "success",
          `已压缩 ${result.shadowedSeqs?.length ?? "?"} 条历史（~${shadowed.toFixed(1)}k tokens 被遮蔽）` +
            (saved > 0 ? `，状态栏 token 从 ${(before / 1000).toFixed(1)}k → ${(after / 1000).toFixed(1)}k` : "")
        );
      } catch (err) {
        const msg = String(err?.message || err);
        if (/active compaction|not idle/i.test(msg)) {
          ctl.notice("warning", "当前有压缩在进行或 agent 未空闲，稍后再试");
        } else if (/No compactable/i.test(msg)) {
          ctl.notice("info", "没有可压缩的历史");
        } else if (/could not produce a smaller summary/i.test(msg)) {
          ctl.notice("info", "压缩结果不比原文小，已跳过（历史还不够长或有价值的中间摘要）");
        } else {
          ctl.notice("error", `压缩失败: ${msg}`);
        }
      }
    },
    presentCall: () => present("Compact：压缩上下文", "compact"),
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

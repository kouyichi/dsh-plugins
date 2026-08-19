/**
 * dsh-tui-context — TUI brick: /context panel.
 *
 * Hermes-style context occupancy dashboard: current session tokens vs the
 * model context window, a segmented progress bar (pi-nano-context style),
 * and compaction advice thresholds. All data comes from the TUI store stats
 * (token-meter projection) + llm.listModels (contextWindow).
 *
 * @module dsh-tui-context
 */

export const name = "dsh-tui-context";
export const inject = ["tuiExtensions"];

function bar(pct, width = 28) {
  const filled = Math.round(pct * width);
  let out = "";
  for (let i = 0; i < width; i++) {
    const seg = i / width;
    out += seg < pct ? (pct - seg < 1 / width ? "▏" : "█") : "░";
  }
  void filled;
  return out;
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-context] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  let ctxWindow = null;

  // Resolve the model's context window lazily (moved out of the TUI core:
  // this is brick business, not core business).
  // 真实窗口优先走 resolveModelInfo（adapter 的 configured.contextWindow ??
  // defaultContextWindow）——listModels 的 modelInfo() 不返回 contextWindow，
  // 只有 resolveModel 链路带。解析结果只存模块级 ctxWindow（H13：这里没有
  // store 句柄，原先的 store.set 抛 ReferenceError 被 catch 吞掉；状态栏与
  // 面板统一读模块级 ctxWindow，不再写 store）。
  (async () => {
    try {
      const llm = ctx.get("llm");
      const sel = ctx.get("agentDefaultModel")?.currentSelection?.();
      if (llm?.resolveModelInfo && sel?.provider && sel?.model) {
        const info = await llm.resolveModelInfo(sel.provider, sel.model);
        if (info?.context?.contextWindow) {
          ctxWindow = Number(info.context.contextWindow);
        } else {
          const models = await llm.listModels(sel.provider);
          const cur = models.find((m) => m.id === sel.model);
          if (cur?.contextWindow) ctxWindow = Number(cur.contextWindow);
        }
      }
    } catch { /* non-fatal: falls back to 128k */ }
  })();

  disposers.push(ext.registerCommand({
    name: "/context",
    description: "上下文占用面板",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("context");
    },
  }));

  disposers.push(ext.registerStatusField({
    id: "context-pct",
    order: 30,
    render(store) {
      const s = store.stats;
      if (!s || !s.totalTokens) return "";
      // H13: 状态栏回退到砖解析的模块级 ctxWindow（store.ctxWindow 已不再写入）
      const win = store.ctxWindow ?? ctxWindow ?? 128000;
      const pct = Math.min(100, Math.round(s.totalTokens / win * 100));
      return `ctx ${pct}%`;
    },
  }));

  disposers.push(ext.registerPanel({
    id: "context",
    title: "上下文占用 / context",
    async load(store) {
      const lines = [];
      const s = store.stats || {};
      const used = s.totalTokens || 0;
      // window: brick-resolved model contextWindow, else 128k default.
      const win = ctxWindow || 128000;
      const pct = Math.min(1, used / win);
      const overflow = used > win;
      lines.push(`模型窗口: ${(win / 1000).toFixed(0)}k tokens（${store.meta?.model ?? "?"}）`);
      lines.push(`当前占用: ${(used / 1000).toFixed(1)}k tokens${overflow ? "  ⚠ 超过窗口！" : ""}`);
      lines.push("");
      lines.push(`  [${bar(pct)}]  ${(pct * 100).toFixed(1)}%`);
      lines.push("");
      lines.push("分级建议：");
      if (overflow) lines.push("  ⚠ 已超过模型窗口：继续发送可能被截断或报错，请立即 /compact 或 /new");
      else if (pct >= 0.9) lines.push("  ⚠ 超过 90%：强烈建议 /compact（有截断风险）");
      else if (pct >= 0.7) lines.push("  ⚠ 超过 70%：建议 /compact 或开新会话（/new）");
      else if (pct >= 0.5) lines.push("  ◐ 超过 50%：留意增长，长任务可考虑规划压缩点");
      else lines.push("  ✓ 占用健康，无需处理");
      lines.push("");
      lines.push(`本轮活动: ${s.turns ?? 0} 轮 / ${s.steps ?? 0} 步 / 工具 ${s.toolCalls ?? "?"} 次`);
      lines.push("");
      lines.push("提示: /compact 压缩历史释放空间；/usage 看 token 明细与成本");
      return { lines };
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

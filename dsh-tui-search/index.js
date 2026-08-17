/**
 * dsh-tui-search — TUI brick: /search (extracted from the TUI core).
 *
 * Cross-session full-text search via the sessionQuery service (SQLite FTS,
 * mounted by the profile's session-query-sqlite row). Panel lists hits;
 * Enter on a hit shows the resume command.
 *
 * @module dsh-tui-search
 */

export const name = "dsh-tui-search";
export const inject = ["tuiExtensions"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-search] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  let lastQuery = "";

  disposers.push(ext.registerCommand({
    name: "/search",
    description: "全文搜索历史会话（内核 sessionQuery）",
    busySafe: true,
    handler(full, ctl, store) {
      const q = full.slice("/search".length).trim();
      if (!q) {
        ctl.notice("warning", "用法: /search <关键词>（跨会话全文搜索）");
        return;
      }
      store.set({ searchQuery: q });
      ctl.openExtPanel("search");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "search",
    title: "会话搜索 / search",
    async load(store) {
      const q = store.searchQuery || "";
      if (!q) return { lines: ["（无查询）"] };
      lastQuery = q;
      const sq = ctx.get("sessionQuery");
      if (!sq?.searchSessions) {
        return { lines: ["session search 不可用（profile 未挂 session-query-sqlite）"] };
      }
      try {
        const page = await sq.searchSessions({ query: q, limit: 10 });
        const hits = page.hits ?? [];
        if (hits.length === 0) return { lines: [`「${q}」无命中。首次搜索会建索引，可能较慢；重试即可。`] };
        const lines = [`「${q}」命中 ${hits.length} 个会话（enter 查看恢复命令）`, ""];
        hits.forEach((h, i) => {
          const title = h.title || h.id || "?";
          lines.push(`[${String(i + 1).padStart(2, " ")}] ${title}`);
          if (h.cwd) lines.push(`      @ ${h.cwd}`);
        });
        lines.push("");
        lines.push("提示: 会话内搜索用 /find <词>");
        return { lines };
      } catch (err) {
        return { lines: [`搜索失败: ${err.message}（索引未就绪可重试）`] };
      }
    },
    confirm(line, ctl, store) {
      const m = line?.match(/^\[(\d+)\]\s+(.+)$/);
      if (!m) return;
      ctl.closeExtPanel();
      const sq = ctx.get("sessionQuery");
      if (!sq?.searchSessions) return;
      sq.searchSessions({ query: lastQuery, limit: 10 }).then((page) => {
        const hit = (page.hits ?? [])[parseInt(m[1], 10) - 1];
        ctl.notice("info", hit ? `继续该会话: dsh --profile tui --resume ${hit.id}` : "（命中已失效，重新 /search）");
      }).catch(() => {});
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

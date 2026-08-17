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

/**
 * Direct SQLite fallback for /search. The sessionQuery service reconciles
 * the whole corpus on every search and throws "persistence observation did
 * not stabilize" while large/active sessions keep changing (multi-process
 * or heavy testing sessions make it permanent). A read-only MATCH against
 * the same FTS index answers instantly and covers every persisted session.
 */
async function sqliteSearch(q, limit) {
  const { DatabaseSync } = await import("node:sqlite");
  const home = process.env.DSH_HOME ?? `${process.env.HOME ?? "/root"}/.dsh`;
  const path = `${home}/storages/session-search.db`;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const expr = `"${String(q).replaceAll('"', '""')}"`;
    const rows = db
      .prepare(
        `SELECT pd.session_id AS session_id, ps.cwd AS cwd,
                ps.created_at AS created_at,
                highlight(persisted_docs, 0, '⟦', '⟧') AS marked_text
         FROM persisted_docs AS pd
         JOIN persisted_sessions AS ps ON ps.id = pd.session_id
         WHERE persisted_docs MATCH ?
         ORDER BY ps.created_at DESC
         LIMIT ?`
      )
      .all(expr, Math.min(limit ?? 10, 50));
    const seen = new Set();
    const hits = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      const snippet = String(row.marked_text ?? "").replace(/\s+/g, " ").trim();
      hits.push({
        id: row.session_id,
        title: row.session_id,
        cwd: row.cwd ?? undefined,
        snippet: snippet.slice(0, 120),
      });
    }
    return hits;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

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
        // Race the service against a short stall timer: its reconcile can
        // take minutes (or fail to stabilize) with large/active sessions.
        let hits;
        try {
          const page = await Promise.race([
            sq.searchSessions({ query: q, limit: 10 }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("索引仍在构建，请稍候重试")), 8000)
            ),
          ]);
          // The sessionQuery service pages as { items, nextCursor? } — reading
          // page.hits returned [] forever and made /search claim "no hits".
          hits = page.items ?? page.hits ?? [];
        } catch {
          // Service unavailable/stalled → read-only direct query on the same
          // FTS index. Instant, no reconcile, covers all persisted sessions.
          hits = await sqliteSearch(q, 10);
        }
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
      const idx = parseInt(m[1], 10) - 1;
      const hit = async () => {
        const sq = ctx.get("sessionQuery");
        try {
          if (sq?.searchSessions) {
            const page = await sq.searchSessions({ query: lastQuery, limit: 10 });
            return (page.items ?? page.hits ?? [])[idx];
          }
        } catch { /* fall through to direct query */ }
        try {
          return (await sqliteSearch(lastQuery, 10))[idx];
        } catch {
          return undefined;
        }
      };
      hit().then((h) => {
        ctl.notice("info", h ? `继续该会话: dsh --profile tui --resume ${h.id}` : "（命中已失效，重新 /search）");
      }).catch(() => {});
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

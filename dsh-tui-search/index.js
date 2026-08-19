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

// P-18/C2-01: sessionQuery 服务返回的命中项是 {header:{id,cwd,...}, bestMatch:{sessionId,snippet}} 结构，
// 没有顶层 title/id —— 旧代码读 h.title||h.id 全是 undefined，中文命中标题显示 "?"、
// enter 生成 --resume undefined。统一按实际结构取值（同时兼容 sqlite 直查的 {id,title,cwd} 形态）。
function hitId(h) {
  return h?.header?.id ?? h?.bestMatch?.sessionId ?? h?.id;
}
function hitTitle(h) {
  return h?.header?.title ?? h?.title ?? hitId(h) ?? "?";
}
function hitCwd(h) {
  return h?.header?.cwd ?? h?.cwd;
}

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
          // P-18: 按 header 结构取标题/工作目录
          const title = hitTitle(h);
          const cwd = hitCwd(h);
          lines.push(`[${String(i + 1).padStart(2, " ")}] ${title}`);
          if (cwd) lines.push(`      @ ${cwd}`);
        });
        lines.push("");
        lines.push("提示: 会话内搜索用 /find <词>");
        return { lines };
      } catch (err) {
        return { lines: [`搜索失败: ${err.message}（索引未就绪可重试）`] };
      }
    },
    confirm(line, ctl, store) {
      // P-19: 面板行是 "[ 1] <title>"（padStart 补位空格），旧正则 /^\[(\d+)\]/ 匹配不上
      const m = line?.match(/^\[\s*(\d+)\]\s+(.+)$/);
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
        // C2-01: 命中 id 必须从 header/bestMatch 取（旧代码 h.id 恒 undefined → --resume undefined）
        const id = hitId(h);
        ctl.notice("info", id ? `继续该会话: dsh --profile tui --resume ${id}` : "（命中已失效，重新 /search）");
      }).catch(() => {});
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

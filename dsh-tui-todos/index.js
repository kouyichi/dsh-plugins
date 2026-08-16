/**
 * dsh-tui-todos — TUI brick: /todos panel.
 *
 * The base todo tool (dsh-tool-todo) appends a `todo/write` snapshot event to
 * the session on every call:
 *   { type: "todo/write", seq, time, data: { todos: [{content, status}] } }
 * This brick subscribes to the global session/event stream (same pattern as
 * dsh-guard/dsh-kanban), keeps the latest snapshot in memory, and renders it
 * as a selectable panel. Enter on a row re-sends that todo as a prompt
 * (e.g. "把 X 标记为完成") — a quick path to update the list via the agent.
 *
 * @module dsh-tui-todos
 */

export const name = "dsh-tui-todos";
export const inject = ["tuiExtensions"];

const STATUS_GLYPH = { pending: "○", in_progress: "◐", completed: "✓" };

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-todos] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  let todos = []; // latest snapshot from todo/write events

  // Live subscription: keep the newest whole-list snapshot.
  const onEvent = (_subject, event) => {
    if (event?.type !== "todo/write") return;
    const list = event.data?.todos;
    if (Array.isArray(list)) todos = list;
  };
  ctx.on("session/event", onEvent);
  disposers.push(() => ctx.off?.("session/event", onEvent));

  disposers.push(ext.registerCommand({
    name: "/todos",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("todos");
    },
  }));

  disposers.push(ext.registerStatusField({
    id: "todos-count",
    order: 60,
    render() {
      if (!todos.length) return "";
      const done = todos.filter((t) => t.status === "completed").length;
      const active = todos.filter((t) => t.status === "in_progress").length;
      return `todo ${done}/${todos.length}${active ? ` (${active} 进行中)` : ""}`;
    },
  }));

  disposers.push(ext.registerPanel({
    id: "todos",
    title: "待办 / todos",
    load() {
      if (!todos.length) {
        return { lines: ["当前没有待办列表。", "", "提示: 让 agent 用 todo 工具创建（如「用 todo 工具列出接下来的步骤」）", "列表更新后本面板自动刷新。"] };
      }
      const lines = [];
      lines.push(`共 ${todos.length} 项（${todos.filter((t) => t.status === "completed").length} 完成）`);
      lines.push("");
      todos.forEach((t, i) => {
        lines.push(`${STATUS_GLYPH[t.status] ?? "?"} ${t.content}`);
      });
      lines.push("");
      lines.push("提示: ↑↓ 选择某项后 enter，让 agent 更新它（完成/进行中）");
      return { lines };
    },
    confirm(line, ctl) {
      const item = line?.replace(/^[○◐✓?] /, "").trim();
      if (!item) return;
      ctl.closeExtPanel();
      ctl.notice("info", `已请求更新待办: ${item}`);
      ctl.submit(`把待办「${item}」标记为完成（若还没完成则说明状态）`);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

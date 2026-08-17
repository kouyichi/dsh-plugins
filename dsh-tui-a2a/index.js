/**
 * dsh-tui-a2a — TUI brick: A2A client dispatch (extracted from the TUI core).
 *
 * Registers:
 *   - command /agents     : probe the local agent network and show a panel
 *   - onSubmit hook       : "@hermes/@claude/@codex/@dsh <task>" dispatch
 *   - onSuggest hook      : "@agent" completion candidates while typing @
 * Results are rendered as plain assistant-style message events (the core no
 * longer knows about A2A — the brick owns the whole surface).
 *
 * @module dsh-tui-a2a
 */

export const name = "dsh-tui-a2a";
export const inject = ["tuiExtensions"];

export const A2A_AGENTS = {
  hermes: 9900,
  claude: 9901,
  codex: 9902,
  dsh: 9903,
};

const POLL_MS = 2000;
const TOTAL_TIMEOUT_MS = 1900 * 1000;

async function rpc(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`A2A HTTP ${res.status}`);
  return await res.json();
}

async function a2aSend(name, text) {
  const port = A2A_AGENTS[name];
  if (!port) throw new Error(`unknown A2A agent "${name}"`);
  const t0 = Date.now();
  const data = await rpc(port, {
    jsonrpc: "2.0",
    id: `tui-${t0}`,
    method: "message/send",
    params: { message: { parts: [{ text }] } },
  });
  // A2A v1.0 endpoints return the Task as `result` directly; the legacy local
  // bridge wraps it as `result.task`. Accept both.
  let task = data?.result?.task ?? data?.result;
  if (!task) throw new Error(`A2A bad response: ${JSON.stringify(data).slice(0, 200)}`);
  while (task.status?.state === "TASK_STATE_WORKING") {
    if (Date.now() - t0 > TOTAL_TIMEOUT_MS) throw new Error("A2A task timed out");
    await new Promise((r) => setTimeout(r, POLL_MS));
    const poll = await rpc(port, {
      jsonrpc: "2.0",
      id: "tui-poll",
      method: "tasks/get",
      params: { id: task.id },
    });
    task = poll?.result?.task ?? task;
  }
  const parts = task?.artifacts?.[0]?.parts ?? [];
  const textOut = parts.map((p) => p.text ?? "").join("") ||
    task?.status?.message?.parts?.map((p) => p.text ?? "").join("") ||
    "(no result)";
  return { state: task.status?.state ?? "UNKNOWN", text: textOut, ms: Date.now() - t0 };
}

async function a2aProbe(name) {
  const port = A2A_AGENTS[name];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { name, ok: false, detail: `HTTP ${res.status}` };
    const card = await res.json();
    return { name, ok: true, detail: card.description?.slice(0, 60) ?? card.name ?? "" };
  } catch (e) {
    return { name, ok: false, detail: e.message };
  }
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-a2a] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/agents",
    description: "A2A agent 网络面板；@name 派活",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("a2a");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "a2a",
    title: "A2A 端点 / agents",
    async load() {
      const rows = [];
      for (const name of Object.keys(A2A_AGENTS)) {
        const probe = await a2aProbe(name);
        rows.push(`  ${probe.ok ? "✓" : "✗"} @${name}  ${probe.detail}`);
      }
      return { lines: [`本机 agent 网络（A2A v1.0）:`, "", ...rows, "", "提示: 输入 @hermes 任务 直接派活（Tab 补全 @agent 名）"] };
    },
  }));

  disposers.push(ext.addInputHook({
    onSubmit(text, { ctl, store }) {
      const m = String(text).match(/^@([a-zA-Z-]+)\s+([\s\S]+)$/);
      if (!m || !A2A_AGENTS[m[1]]) return false;
      const name = m[1];
      const task = m[2];
      ctl.notice("info", `A2A 派活 @${name}: ${task.slice(0, 60)}`);
      ctl.submit(`（A2A 派活 @${name} 已发起，结果稍后显示）`);
      (async () => {
        try {
          const r = await a2aSend(name, task);
          ctl.notice("success", `A2A @${name} 完成（${(r.ms / 1000).toFixed(1)}s）:\n${r.text.slice(0, 2000)}`);
        } catch (e) {
          ctl.notice("error", `A2A @${name} 失败: ${e.message}`);
        }
      })();
      return true;
    },
    onSuggest(buffer) {
      if (!String(buffer).startsWith("@")) return [];
      const q = String(buffer).slice(1).toLowerCase();
      return Object.keys(A2A_AGENTS)
        .filter((n) => n.startsWith(q))
        .map((n) => `@${n} `);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

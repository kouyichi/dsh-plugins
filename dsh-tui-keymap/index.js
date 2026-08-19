/**
 * dsh-tui-keymap — TUI brick: leader keys + busy input queue.
 *
 * OpenCode-style leader key (ctrl+x prefix):
 *   ctrl+x m  → /model      ctrl+x c → /compact   ctrl+x t → /theme
 *   ctrl+x x  → /export     ctrl+x u → /undo 1    ctrl+x s → /usage
 *   ctrl+x q  → quit        ctrl+x h → /help
 *
 * Pi-style message queue:
 *   Alt+Enter → if a turn is running, QUEUE the prompt and deliver it when
 *               idle; otherwise submit immediately.
 *   Alt+Up    → take the queued prompt back (fills the input buffer).
 *
 * @module dsh-tui-keymap
 */

export const name = "dsh-tui-keymap";
export const inject = ["tuiExtensions"];

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-keymap] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  let pending = null; // queued prompt while busy
  let poller = null;

  function runCommand(ctl, name, store) {
    const def = ext.commands.get(name);
    if (def) {
      try {
        // H05: 与 app index.js L1474 同款传法 —— store 句柄 + 当前状态扁平快照
        // （原来传 undefined，命令 handler 读不到 store）。
        def.handler(name, ctl, { ...store, ...store.get() });
      } catch (e) { ctl.notice("error", `${name} 失败: ${e.message}`); }
    } else if (name === "/model") {
      ctl.openModel();
    } else if (name === "/help") {
      ctl.notice("info", "leader 键位: ctrl+x m 模型 · c c·compact · t 主题 · x 导出 · u undo · s usage · q 退出 · h 帮助");
    } else if (name === "/quit") {
      ctl.exit();
    } else {
      ctl.notice("warning", `未绑定: ${name}`);
    }
  }

  // H06: ctl 未暴露 submitWithHooks（app index.js），keymap 在 ctl.submit 前自行
  // 跑一遍 onSubmit 钩子链（与 app handleSubmit 相同语义：true = 已消费），避免
  // Alt+Enter / 排队发送绕过钩子（如 A2A @agent 分发）。若未来 app 提供
  // ctl.submitWithHooks，可改为调用它。
  function submitThroughHooks(text, ctl, store) {
    for (const fn of ext.inputHooks.onSubmit) {
      try {
        if (fn(String(text || ""), { ctl, store }) === true) return; // consumed
      } catch (e) { ctl.notice("error", `输入 hook 失败: ${e.message}`); }
    }
    ctl.submit(text);
  }

  disposers.push(ext.addInputHook({
    onLeader: {
      m: ({ ctl, store }) => runCommand(ctl, "/model", store),
      c: ({ ctl, store }) => runCommand(ctl, "/compact", store),
      t: ({ ctl, store }) => runCommand(ctl, "/theme", store),
      x: ({ ctl, store }) => runCommand(ctl, "/export", store),
      u: ({ ctl, store }) => {
        // H21: busy 时拒绝 /undo（重发输入会与当前回合交错）
        if (store.get().input?.busy) {
          ctl.notice("warning", "agent 正忙，/undo 不可用（Ctrl+C 可中断，或等当前轮次结束）");
          return;
        }
        runCommand(ctl, "/undo", store);
      },
      s: ({ ctl, store }) => runCommand(ctl, "/usage", store),
      q: ({ ctl, store }) => runCommand(ctl, "/quit", store),
      h: ({ ctl, store }) => runCommand(ctl, "/help", store),
    },
    onAltEnter(text, { ctl, store }) {
      const t = String(text || "").trim();
      if (!t) return;
      if (store.get().input?.busy) {
        pending = t;
        ctl.notice("info", `已排队（空闲自动发送，Alt+Up 取回）: ${t.slice(0, 60)}`);
        if (!poller) {
          let age = 0;
          poller = setInterval(() => {
            const s = store.get();
            age += 500;
            if (pending && !s.input?.busy) {
              const p = pending;
              pending = null;
              clearInterval(poller);
              poller = null;
              ctl.notice("info", `↩ 发送排队消息: ${p.slice(0, 60)}`);
              submitThroughHooks(p, ctl, store); // H06: 走 onSubmit 钩子链
            } else if (pending && age >= 300000) {
              // never let a queued message sit forever
              pending = null;
              clearInterval(poller);
              poller = null;
              ctl.notice("warning", "排队消息已取消（超过 5 分钟未发出）");
            }
          }, 500);
        }
      } else {
        ctl.notice("info", "↩ 直接发送");
        submitThroughHooks(t, ctl, store); // H06: 走 onSubmit 钩子链
      }
    },
    onAltUp({ ctl, store }) {
      if (!pending) {
        ctl.notice("info", "没有排队中的消息");
        return;
      }
      const p = pending;
      pending = null;
      if (poller) { clearInterval(poller); poller = null; }
      // H09: 若 app 侧（G1）在 ctl 上暴露了 setBuffer（同步 Input 实例内部
      // buffer），优先用它；否则退回 store 快照同步（仅渲染层生效）。keymap
      // 拿不到 Input 实例（app index.js 内部闭包），完整修复依赖 ctl.setBuffer。
      if (typeof ctl.setBuffer === "function") {
        ctl.setBuffer(p, p.length);
      } else {
        store.set({ input: { ...store.get().input, buffer: p, cursor: p.length } });
      }
      ctl.notice("info", "已取回排队消息到输入框");
    },
  }));

  ctx.effect(() => () => {
    if (poller) { clearInterval(poller); poller = null; }
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

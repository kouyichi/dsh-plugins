/**
 * dsh-tui-feedback — TUI brick: /feedback (extracted from the TUI core).
 *
 * Records 👍/👎 feedback for the last assistant message into
 * ~/.dsh/feedback.json (shared surface — the web UI and future tools can
 * consume it too).
 *
 * @module dsh-tui-feedback
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-tui-feedback";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

/** 砖自带的反馈记录（内核 /feedback 不可用时的兜底实现）。 */
function brickFeedback(full, ctl, store) {
  const last = store.lastAssistantId;
  if (!last) {
    ctl.notice("warning", "还没有可反馈的助手消息");
    return;
  }
  const m = full.slice("/feedback".length).trim().match(/^(up|down|👍|👎|good|bad)(?:\s+([\s\S]*))?$/i);
  if (!m) {
    ctl.notice("warning", "用法: /feedback up|down [备注]");
    return;
  }
  const verdict = ["up", "👍", "good"].includes(m[1].toLowerCase()) ? "up" : "down";
  const path = join(DSH_HOME, "feedback.json");
  let all = [];
  try { all = JSON.parse(readFileSync(path, "utf8")); } catch { all = []; }
  all.push({ messageId: last, verdict, note: m[2] ?? "", ts: Date.now() });
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2));
    ctl.notice("info", `已记录反馈（${verdict === "up" ? "👍" : "👎"}）→ ${path}`);
  } catch (e) {
    ctl.notice("error", `反馈写入失败: ${e.message}`);
  }
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-feedback] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  // D-01: 内核命令桥（app 分发）优先于砖 —— 内核 dsh-command-feedback 挂载时，
  // /feedback 被内核直接接管（接受任意非空文本，无 up/down 校验），本砖 handler
  // 不会触发；而 commands.register 对重名命令会抛错（dsh-commands 的
  // CommandLayer/NamedEntries），砖无法替换内核命令 → 彻底修复需 app 侧配合（G1：
  // 命令分发允许砖覆盖内核，或内核侧增加校验）。砖侧尽力：启动时检测并告警，
  // /feedback 描述注明校验规则；内核缺失时由本砖兜底校验（brickFeedback）。
  try {
    const agents = ctx.get("agents");
    const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
    const dshCmds = ctx.get("commands");
    if (parent && dshCmds?.list?.(parent)?.some((d) => d.name === "feedback")) {
      ctx.logger.warn(
        "[dsh-tui-feedback] 内核 /feedback 已接管（接受任意文本，无 up/down 校验），砖的校验逻辑不可达；" +
          "需 app 侧配合（G1）：命令分发应允许砖覆盖内核命令，或内核侧按 up/down/👍/👎/good/bad + 备注 校验"
      );
    }
  } catch { /* boot 期 agents 未就绪属正常，稍后内核存在时桥接层自然接管 */ }

  disposers.push(ext.registerCommand({
    name: "/feedback",
    busySafe: true,
    description: "反馈：/feedback up|down|👍|👎|good|bad [备注]（内核接管时接受任意文本且本砖校验不可达，见 /plugins t 日志）",
    handler(full, ctl, store) {
      // 内核 /feedback 命令存在时转发内核执行（记录到会话日志）——
      // 核心命令桥已优先接管，本分支只在桥缺失/命令未注册时兜底。
      const agents = ctx.get("agents");
      const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
      const dshCmds = ctx.get("commands");
      if (parent && dshCmds?.execute) {
        try {
          if (dshCmds.list?.(parent)?.some((d) => d.name === "feedback")) {
            dshCmds.execute(parent, full, AbortSignal.timeout(60000)).then((exec) => {
              ctl.notice("info", exec?.result?.text ?? "✓ 已由内核 /feedback 处理");
            }).catch((e) => {
              ctl.notice("warning", `内核 /feedback 执行失败，回退本砖实现: ${e.message}`);
              brickFeedback(full, ctl, store);
            });
            return;
          }
        } catch { /* fall through to brick */ }
      }
      brickFeedback(full, ctl, store);
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

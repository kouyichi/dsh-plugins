/**
 * dsh-tui-ops — TUI brick: 工程化命令集 /doctor /login /logout /add-dir /hooks
 * /mcp /cost /tokens /thinking /settings.
 *
 * 语义来源：ccch1mneyyy/dsh-TUI（1,877★）src/screens/Chat.tsx runCommand 各 case +
 * src/dsh-adapter/channel.ts（doctorInfo/mcpStatus/describeCredential）+ i18n.ts 文案
 * + docs/interaction.md（/hooks 明示为兼容占位命令）。移植到本机积木砖接缝：
 * 全部实现为「只读面板 / 指引通知 / 本地显示开关」，busySafe 全部 true。
 *
 * 与现有砖的关系：
 *  - /cost  = /usage 别名（复用 dsh-tui-usage 的 usage 面板，零重复逻辑；
 *            面板未注册时回退到本砖 tokens 面板）。
 *  - /tokens = 复用 usage 的同款数据源（sessionProjections 投影 → tokenUsage/
 *            sessionStats，回退 store.stats），只输出当前会话明细，不扫描会话日志。
 *  - /context（dsh-tui-context）管占用百分比，本砖只管 token 明细行。
 *
 * 安全：所有凭证只报「已配置/来源」，绝不打印值。
 *
 * @module dsh-tui-ops
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, accessSync, constants as fsConstants } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-tui-ops";
export const inject = ["tuiExtensions"];

/* ---------- 惰性路径（ESM import 提升坑：路径一律函数内现算，保证 DSH_HOME 覆盖生效） ---------- */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function tuiProfileDir() {
  return join(dshHome(), "profiles", "tui");
}
function configPath() {
  return join(tuiProfileDir(), "tui-config.json");
}
function credentialsPath() {
  return join(dshHome(), ".credentials.yaml");
}
function settingsPath() {
  return join(dshHome(), "settings.yaml");
}
function homePatchPath() {
  return join(dshHome(), "cordis.patch.yml");
}
function profilePatchPath() {
  return join(tuiProfileDir(), "cordis.patch.yml");
}
function sessionsDir() {
  return join(dshHome(), "sessions");
}

/* ---------- tui-config.json 持久化（同核心 /config 的 load/save 模式） ---------- */
function loadPersisted() {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) ?? {};
  } catch {
    return {};
  }
}
function savePersisted(patch) {
  try {
    const cfg = { ...loadPersisted(), ...patch };
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch {
    /* best-effort persistence */
  }
}

/* ---------- 版本 / 文件 / 凭证（只读，绝不打印值） ---------- */
function readDshVersion() {
  const candidates = [
    join(dirname(process.execPath || ""), "..", "lib", "node_modules", "@deepseek-ai", "dsh", "package.json"),
    join(dirname(process.execPath || ""), "..", "..", "lib", "node_modules", "@deepseek-ai", "dsh", "package.json"),
    "/user/bin/../lib/node_modules/@deepseek-ai/dsh/package.json",
  ];
  for (const p of candidates) {
    try {
      const v = JSON.parse(readFileSync(p, "utf8")).version;
      if (v) return v;
    } catch { /* next candidate */ }
  }
  return "?";
}

function probeFile(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** settings.yaml 顶层 namespace 名（零依赖 YAML 解析）。 */
function settingsNamespaces() {
  try {
    const text = readFileSync(settingsPath(), "utf8");
    return [...text.matchAll(/^([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/** 从 settings.yaml 取单个标量字段（如 llm-deepseek.apiKeyEnv / baseURL）。 */
function settingsScalar(prefix, key) {
  try {
    const text = readFileSync(settingsPath(), "utf8");
    const m = text.match(new RegExp(`^${prefix}[\\s\\S]*?^\\s*${key}:\\s*(\\S+)`, "m"));
    return m ? m[1].replace(/["']/g, "") : null;
  } catch {
    return null;
  }
}

/** ~/.dsh/.credentials.yaml 的 key 名（不含值）。 */
function credentialKeys() {
  try {
    const text = readFileSync(credentialsPath(), "utf8");
    return [...text.matchAll(/^([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/** 环境变量中形如 *API_KEY / *TOKEN / *SECRET 的 ref 名（不含值）。 */
function envCredentialRefs() {
  return Object.keys(process.env).filter((k) => /(^|_)(API_KEY|TOKEN|SECRET)(_|$)/i.test(k)).sort();
}

function fileWritable(path) {
  try {
    accessSync(path, fsConstants.W_OK);
    return "可写";
  } catch {
    return "只读";
  }
}

/** 沙箱/审批现状：profile 补丁层 sandbox-policy / approval 行（进程 env 覆盖优先展示）。 */
function sandboxState() {
  const envMode = process.env.DSH_PERMISSION_MODE;
  try {
    const text = readFileSync(profilePatchPath(), "utf8");
    // G215: 先定位 sandbox-policy 块，再取块内首个 mode:/policy: 行，
    // 避免误读文件其他位置（如 MCP config）的 `mode: stdio`（旧逻辑全文取第一个 mode:）。
    const blockStart = text.search(/^\s*-\s*id:\s*sandbox-policy\s*$/m);
    const block = blockStart >= 0 ? text.slice(blockStart) : text;
    const mode = block.match(/^\s*mode:\s*(\S+)/m)?.[1] ?? null;
    const policy = block.match(/^\s*policy:\s*(\S+)/m)?.[1] ?? null;
    return {
      mode: envMode ?? mode ?? "unknown",
      policy: policy ?? "unknown",
      envOverride: Boolean(envMode),
    };
  } catch {
    return { mode: envMode ?? "unknown", policy: "unknown", envOverride: Boolean(envMode) };
  }
}

/** 插件数：与 splash//plugins 同口径（按包名分组计数）。 */
function pluginCount(ctx) {
  try {
    const loader = ctx.get("loader");
    if (!loader?.entries) return 0;
    const byName = new Map();
    for (const e of loader.entries()) {
      const n = e?.options?.name ?? e?.options?.id ?? "?";
      byName.set(n, (byName.get(n) ?? 0) + 1);
    }
    return byName.size;
  } catch {
    return 0;
  }
}

/** mcp__ 工具枚举：tools.schemas() 按 mcp__<server>__<tool> 分组（竞品 channel.mcpStatus 同款）。 */
function mcpServers(ctx) {
  try {
    const tools = ctx.get("tools");
    const schemas = tools?.schemas ? tools.schemas() : [];
    const byServer = new Map();
    for (const s of schemas) {
      const m = /^mcp__([\w.-]+)__(.+)$/.exec(s?.name ?? "");
      if (!m) continue;
      const list = byServer.get(m[1]) ?? [];
      list.push(m[2]);
      byServer.set(m[1], list);
    }
    return byServer;
  } catch {
    return new Map();
  }
}

/** 当前会话 usage：优先 sessionProjections 投影（同 dsh-tui-usage 数据源），回退 store.stats。 */
function currentUsage(ctx, store) {
  const s = store?.stats ?? {};
  try {
    const agents = ctx.get("agents");
    const proj = ctx.get("sessionProjections");
    const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
    if (parent && proj?.snapshot) {
      const values = proj.snapshot(parent.session)?.values ?? {};
      const stats = values.sessionStats ?? {};
      const usage = values.tokenUsage ?? {};
      return {
        cacheRead: usage.cacheReadTokens ?? 0,
        uncachedInput: usage.uncachedInputTokens ?? 0,
        output: usage.outputTokens ?? stats.decodeTokens ?? 0,
        turns: stats.turns ?? 0,
        steps: stats.steps ?? 0,
      };
    }
  } catch { /* fall through to store.stats */ }
  return {
    cacheRead: s.cacheRead ?? 0,
    uncachedInput: s.uncachedInput ?? 0,
    output: s.decodeTokens ?? 0,
    turns: s.turns ?? 0,
    steps: s.steps ?? 0,
  };
}

function fmtK(n) {
  return `${(n / 1000).toFixed(1)}k`;
}

/** 凭证状态探测：只报 configured/source/writable，绝不打印值。 */
async function credentialStatus(ctx, ref) {
  try {
    const cred = ctx.get("credentials");
    if (cred?.describe) {
      const d = await cred.describe(ref);
      if (d) return d;
    }
  } catch { /* fall through to presence probes */ }
  const inEnv = process.env[ref] !== undefined;
  const inFile = credentialKeys().includes(ref);
  return {
    configured: inEnv || inFile,
    source: inEnv ? "env" : inFile ? "file" : undefined,
    writable: undefined,
  };
}

/* ---------- apply ---------- */
export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-ops] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  /* ----- /doctor：环境自检面板 ----- */
  disposers.push(ext.registerCommand({
    name: "/doctor",
    description: "环境自检面板（版本/凭证/沙箱/插件/服务）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("doctor");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "doctor",
    title: "环境自检 / doctor",
    async load(store) {
      const lines = [];
      const apiKeyEnv = settingsScalar("llm-deepseek:", "apiKeyEnv") ?? "DEEPSEEK_API_KEY";
      let keyState = "✗ 未配置";
      try {
        const st = await credentialStatus(ctx, apiKeyEnv);
        keyState = st?.configured ? `✓ 已配置（${apiKeyEnv}）` : `✗ 未配置（${apiKeyEnv}）`;
      } catch {
        keyState = "? 检查失败";
      }
      lines.push(`Node ${process.version} · ${process.platform} ${process.arch}`);
      lines.push(`dsh ${readDshVersion()} · 会话 ${String(store.meta?.sessionId ?? "?").slice(0, 20)}`);
      lines.push(`API key: ${keyState}`);
      lines.push(`模型: ${store.meta?.model ?? "?"} · 提供方: ${store.meta?.provider ?? "?"}`);
      lines.push(`工作目录: ${store.meta?.cwd ?? process.cwd()}`); // G217: 会话 cwd 优先（回退进程 cwd）
      lines.push(`上下文窗口: ${store.ctxWindow ?? "未知"}`);
      const sandbox = sandboxState();
      lines.push(`沙箱: ${sandbox.mode}${sandbox.policy !== "unknown" ? `（approval: ${sandbox.policy}）` : ""}${sandbox.envOverride ? " · env 覆盖" : ""}`);
      lines.push(`插件: ${pluginCount(ctx)} 个（loader 按包名）`);
      lines.push(`MCP: ${[...mcpServers(ctx).values()].reduce((n, l) => n + l.length, 0)} 个 mcp__ 工具`);
      const services = ["agents", "settings", "llm", "tools", "credentials", "sessionProjections", "skills", "jobs"];
      const ok = services.filter((s) => { try { return Boolean(ctx.get(s)); } catch { return false; } });
      lines.push(`服务: ${ok.length}/${services.length} 可用（${ok.join(" ")}）`);
      lines.push(`配置: settings.yaml ${probeFile(settingsPath()) ? "✓" : "✗"} · 家级 patch ${probeFile(homePatchPath()) ? "✓" : "✗"} · profile patch ${probeFile(profilePatchPath()) ? "✓" : "✗"}`);
      lines.push(`会话存储: ${sessionsDir()} ${probeFile(sessionsDir()) ? "✓" : "✗（未初始化）"}`);
      lines.push("");
      lines.push("提示: /login 看凭据详情；/mcp 看 MCP；/settings 看配置来源");
      return { lines };
    },
  }));

  /* ----- /login：凭据状态（不显示值） ----- */
  disposers.push(ext.registerCommand({
    name: "/login",
    description: "API 凭据状态（不显示密钥值）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("login");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "login",
    title: "凭据状态 / login",
    async load() {
      const lines = [];
      const apiKeyEnv = settingsScalar("llm-deepseek:", "apiKeyEnv") ?? "DEEPSEEK_API_KEY";
      try {
        const st = await credentialStatus(ctx, apiKeyEnv);
        lines.push(`API key: ${st?.configured ? `✓ 已配置（${apiKeyEnv}）` : `✗ 未配置（${apiKeyEnv}）`}`);
        if (st?.source) lines.push(`凭据来源: ${st.source === "env" ? "环境变量" : "文件"}`);
      } catch {
        lines.push("API key: ? 检查失败（credentials 服务不可用）");
      }
      const credsExist = probeFile(credentialsPath());
      lines.push(`凭据存储: ${credentialsPath()} ${credsExist ? `✓（${fileWritable(credentialsPath())}）` : "✗ 文件不存在"}`);
      if (credsExist) {
        const keys = credentialKeys();
        lines.push(`文件中已配置 ref: ${keys.length > 0 ? keys.join(" ") : "（无）"}`);
      }
      const envRefs = envCredentialRefs();
      lines.push(`环境变量 ref: ${envRefs.length > 0 ? envRefs.join(" ") : "（无）"}`);
      const baseUrl = process.env.DEEPSEEK_BASE_URL ?? settingsScalar("llm-deepseek:", "baseURL");
      lines.push(`Base URL: ${baseUrl ?? "官方端点"}`);
      lines.push("");
      lines.push("（安全：仅显示 ref 名与配置状态，值永不输出）");
      lines.push("提示: /logout 查看删除凭据指引；/doctor 环境自检");
      return { lines };
    },
  }));

  /* ----- /logout：登出指引（竞品实现 = 仅提示通知，不改凭据） ----- */
  disposers.push(ext.registerCommand({
    name: "/logout",
    description: "登出指引（删除凭据的操作说明）",
    busySafe: true,
    handler(full, ctl) {
      ctl.notice("info",
        `登出指引：dsh 无 /logout 实际登出动作（与竞品一致：仅提示）。` +
        `删除 ${credentialsPath()} 中对应 key（如 DEEPSEEK_API_KEY），` +
        `或删除对应环境变量后重启 dsh；若 baseURL 指向本地代理则无需登出。`);
    },
  }));

  /* ----- /add-dir：文件策略范围 ----- */
  disposers.push(ext.registerCommand({
    name: "/add-dir",
    description: "文件策略范围（沙箱现状与收紧方式）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("add-dir");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "add-dir",
    title: "文件策略范围 / add-dir",
    load(store) {
      const lines = [];
      const sandbox = sandboxState();
      lines.push(`当前文件系统策略: ${sandbox.mode}${sandbox.policy !== "unknown" ? `（approval: ${sandbox.policy}）` : ""}`);
      lines.push(`  以工作目录为根: ${store.meta?.cwd ?? process.cwd()}`); // G217: 会话 cwd 优先（回退进程 cwd）
      if (sandbox.mode === "danger-full-access") {
        lines.push("  跨目录访问: 不受限（沙箱直通——本机无 bubblewrap/Landlock 后端，");
        lines.push("    workspace-write 沙箱无法约束，bash/fs 全放开）");
      } else {
        lines.push("  跨目录访问: 由 fs-policy 拦截（相对路径均解析自工作目录）");
      }
      lines.push("");
      lines.push("说明: dsh 的「加目录」等价机制是 sandbox-policy.workspaceRoot / fs-policy 配置，");
      lines.push("  无 CC 式 /add-dir 白名单命令。本机为全放开模式，无需添加目录；");
      lines.push("  如需收紧，编辑 ~/.dsh/profiles/tui/cordis.patch.yml 的 sandbox-policy 行后重启。");
      return { lines };
    },
  }));

  /* ----- /hooks：占位说明（竞品明示：DSH 无 hooks 机制，明确说明而非静默） ----- */
  disposers.push(ext.registerCommand({
    name: "/hooks",
    description: "Hooks 状态（DSH 无等价机制说明）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("hooks");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "hooks",
    title: "Hooks 状态 / hooks",
    load() {
      const lines = [];
      lines.push("DSH hooks: 未挂载（dsh-hooks-claude / dsh-hooks-codex 不在本 leaf）");
      lines.push("");
      lines.push("说明: 本命令是兼容占位命令——DSH 没有 CC/Codex 式的运行时 hooks 机制。");
      lines.push("  （竞品 interaction.md 明示 /hooks 为占位；此处同样明确说明而非静默。）");
      lines.push("需要时: 在 ~/.dsh/profiles/tui/cordis.patch.yml 的 insert 段加对应");
      lines.push("  hooks 插件行（官方 dsh-hooks-*）后重启生效。");
      lines.push(`本机: 家级/profile 补丁层均无 hooks 插件行`);
      return { lines };
    },
  }));

  /* ----- /mcp：MCP 连接状态 ----- */
  disposers.push(ext.registerCommand({
    name: "/mcp",
    description: "MCP 连接状态（mcp__ 工具枚举）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("mcp");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "mcp",
    title: "MCP 连接状态 / mcp",
    load() {
      const byServer = mcpServers(ctx);
      const lines = [];
      if (byServer.size === 0) {
        lines.push("未配置 MCP 服务器。");
        lines.push("挂载方式: 在 profile 补丁层（~/.dsh/profiles/tui/cordis.patch.yml）insert 一行，例:");
        lines.push("  - insert:");
        lines.push("      - id: mcp-context7");
        lines.push("        name: '@deepseek-ai/dsh-mcp-client'");
        lines.push("        config: { transport: stdio, serverName: context7, command: npx, args: [\"-y\", \"@upstash/context7-mcp\"] }");
        lines.push("工具命名: 挂载后以 mcp__<server>__<tool> 注册并自动进入模型工具集。");
        lines.push("完整字段见官方配置目录（deepseek-harness config-catalog → dsh-mcp-client）。");
      } else {
        for (const [server, tools] of byServer) {
          lines.push(`${server}（${tools.length} 个工具）: ${tools.join(", ")}`);
        }
      }
      return { lines };
    },
  }));

  /* ----- /cost：/usage 别名（复用 dsh-tui-usage 面板，零重复逻辑） ----- */
  disposers.push(ext.registerCommand({
    name: "/cost",
    description: "当前会话成本（同 /usage 面板）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel(ext.panels.has("usage") ? "usage" : "tokens");
    },
  }));

  /* ----- /tokens：当前会话 token 明细（与 /usage 同数据源，不扫描会话日志） ----- */
  disposers.push(ext.registerCommand({
    name: "/tokens",
    description: "Token 明细（输入/缓存读/输出/命中率）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("tokens");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "tokens",
    title: "Token 明细 / tokens",
    load(store) {
      const lines = [];
      const u = currentUsage(ctx, store);
      const totalIn = (u.cacheRead || 0) + (u.uncachedInput || 0);
      const hit = totalIn > 0 ? Math.round((u.cacheRead || 0) / totalIn * 100) : 0;
      const win = store.ctxWindow ?? 128000;
      const pct = win > 0 ? Math.min(100, Math.round((u.uncachedInput + u.cacheRead + u.output) / win * 100)) : 0;
      lines.push(`当前会话（${String(store.meta?.sessionId ?? "?").slice(0, 20)}）`);
      lines.push(`  输入 ${fmtK(u.uncachedInput || 0)} 未缓存 + ${fmtK(u.cacheRead || 0)} 缓存读`);
      lines.push(`  输出 ${fmtK(u.output || 0)}`);
      lines.push(`  缓存命中率 ${hit}%`);
      lines.push(`  上下文占用 ${pct}%（窗口 ${fmtK(win)}）`);
      lines.push(`  轮次 ${u.turns ?? 0} · 步骤 ${u.steps ?? 0}`);
      lines.push("");
      lines.push("提示: /cost 看估算成本；/context 看占用进度条；/usage 看全局用量");
      return { lines };
    },
  }));

  /* ----- /thinking：思考显示开关（面板选择 + tui-config.json 持久化） ----- */
  disposers.push(ext.registerCommand({
    name: "/thinking",
    description: "思考显示开关（持久化）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("thinking");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "thinking",
    title: "思考显示 / thinking",
    load(store) {
      const persisted = loadPersisted().thinking;
      // S-14: 实时折叠态优先（store.fold 为 Ctrl+O 三态），持久化值仅作回退——旧逻辑反过来导致「当前」显示陈旧值
      const cur = store.fold ?? persisted;
      const curLabel =
        cur === "hidden" ? "隐藏（不显示思考）" :
        cur === "collapsed" ? "折叠（可 Ctrl+O 展开）" : "显示（展开思考内容）";
      const lines = [];
      lines.push(`当前: ${curLabel}`);
      lines.push("");
      lines.push("启用（显示思考内容）");
      lines.push("关闭（隐藏思考）");
      lines.push("");
      lines.push("说明: 本机 app 的思考折叠由 Ctrl+O 三态控制（折叠/展开/隐藏）；");
      lines.push("  /thinking 是显示开关，持久化到 tui-config.json，重启后从本面板一键恢复。");
      lines.push("  模型是否做扩展思考由 /model 的推理力度（e 键）控制。");
      lines.push("提示: ↑↓ 选择 · enter 执行 · esc 关闭");
      return { lines };
    },
    confirm(line, ctl, store) {
      const raw = String(line ?? "").trim();
      if (raw.startsWith("启用")) {
        store.set({ fold: "expanded" });
        savePersisted({ thinking: "expanded" });
        ctl.notice("info", "思考显示：开启（Ctrl+O 仍可折叠/展开）");
        ctl.closeExtPanel();
      } else if (raw.startsWith("关闭")) {
        store.set({ fold: "hidden" });
        savePersisted({ thinking: "hidden" });
        ctl.notice("info", "思考显示：关闭（已持久化到 tui-config.json）");
        ctl.closeExtPanel();
      } else {
        // S-13: 不匹配的行不再静默——明确提示用户可选项
        ctl.notice("warning", "请选择「启用」或「关闭」后再按 enter（esc 关闭面板）");
      }
    },
  }));

  /* ----- /settings：配置来源面板 ----- */
  disposers.push(ext.registerCommand({
    name: "/settings",
    description: "配置来源面板（settings.yaml + 补丁层）",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("settings");
    },
  }));
  disposers.push(ext.registerPanel({
    id: "settings",
    title: "配置来源 / settings",
    async load() { // G216: describe 异步 → load 需 async 才能 await
      const lines = [];
      lines.push("覆盖来源（自高到低）:");
      lines.push(`  1) 环境变量: ${["DSH_HOME", "DSH_PERMISSION_MODE", "DEEPSEEK_BASE_URL"].filter((k) => process.env[k] !== undefined).join(" ") || "（无）"}`);
      lines.push(`  2) ${settingsPath()} ${probeFile(settingsPath()) ? "✓" : "✗"}`);
      lines.push(`  3) ${homePatchPath()} ${probeFile(homePatchPath()) ? "✓" : "✗"}（家级插件装载）`);
      lines.push(`  4) ${profilePatchPath()} ${probeFile(profilePatchPath()) ? "✓" : "✗"}（profile 补丁层）`);
      lines.push("");
      lines.push("settings.yaml 命名空间:");
      const nss = settingsNamespaces();
      for (const ns of nss) {
        if (ns === "llm-deepseek") {
          const baseURL = settingsScalar("llm-deepseek:", "baseURL") ?? "官方端点";
          const win = settingsScalar("llm-deepseek:", "defaultContextWindow") ?? "默认";
          lines.push(`  llm-deepseek: baseURL=${baseURL} · 窗口=${win} · apiKeyEnv=${settingsScalar("llm-deepseek:", "apiKeyEnv") ?? "?"}`);
        } else if (ns === "agent-default-model") {
          lines.push(`  agent-default-model: ${settingsScalar("agent-default-model:", "provider") ?? "?"}/${settingsScalar("agent-default-model:", "model") ?? "?"} · effort=${settingsScalar("agent-default-model:", "reasoningEffort") ?? "?"}`);
        } else if (ns === "agent-presets") {
          lines.push(`  agent-presets: default=${settingsScalar("agent-presets:", "default") ?? "?"}`);
        } else {
          lines.push(`  ${ns}`);
        }
      }
      try {
        const settings = ctx.get("settings");
        if (settings?.describe) {
          // G216: describe 可能返回 Promise——必须 await（旧代码漏 await，desc 实为 Promise 对象）
          const desc = await settings.describe({ redactSecrets: true });
          const rows = Array.isArray(desc) ? desc : [];
          if (rows.length > 0) {
            lines.push("");
            lines.push("settings 服务已注册命名空间:");
            for (const d of rows) {
              lines.push(`  ${d.ns}${d.user !== undefined ? "（用户层已覆盖）" : ""}`);
            }
          }
        }
      } catch { /* G216: 异常分支——服务不可用时以文件解析结果为准 */ }
      lines.push("");
      lines.push("提示: /config 动态改会话参数（contextWindow/压缩）；其余手工编辑文件");
      return { lines };
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

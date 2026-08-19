/**
 * dsh-tui-providers — TUI brick: multi-provider LLM adaptation.
 *
 * Ports Hermes' provider model onto dsh:
 *   - ProviderProfile-ish config in ~/.dsh/tui-providers.json: one entry per
 *     provider (name / displayName / baseURL / apiKeyEnv / models / extraHeaders)
 *   - A single generic OpenAI-compatible adapter (lib/openai-compat.js) is
 *     registered for every configured provider route via ctx.llm.registerAdapter,
 *     so /model + agentDefaultModel can switch providers at runtime
 *     (Hermes' transport: openai_chat / chat.completions).
 *   - /providers panel lists providers + live /models probe status.
 *   - /provider <name> switches the default provider (Hermes `hermes model`
 *     semantics); /provider add|remove manages the config file.
 *
 * Config file (auto-created with defaults on first run):
 *   {
 *     "providers": [
 *       { "name": "deepseek-official", "displayName": "DeepSeek",
 *         "baseURL": "http://127.0.0.1:8899", "apiKeyEnv": "DEEPSEEK_API_KEY",
 *         "defaultContextWindow": 128000,
 *         "models": [{"id":"deepseek-v4-flash","name":"DeepSeek-V4-Flash","contextWindow":128000},
 *                    {"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro","contextWindow":128000}] },
 *       { "name": "openrouter", "displayName": "OpenRouter",
 *         "baseURL": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY",
 *         "models": [{"id":"anthropic/claude-sonnet-4-5"}] },
 *       { "name": "ollama", "displayName": "Ollama (local)",
 *         "baseURL": "http://127.0.0.1:11434/v1", "apiKeyEnv": "OLLAMA_API_KEY",
 *         "models": [{"id":"qwen3:8b"}] }
 *     ]
 *   }
 *
 * The first entry mirrors the stock llm-deepseek route so behavior is
 * unchanged out of the box; extra entries add providers without touching
 * the core.
 *
 * @module dsh-tui-providers
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OpenAICompatAdapter } from "./lib/openai-compat.js";

export const name = "dsh-tui-providers";
export const inject = ["tuiExtensions"];

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const CONFIG_PATH = join(DSH_HOME, "tui-providers.json");

const DEFAULT_PROVIDERS = [
  {
    name: "deepseek-official",
    displayName: "DeepSeek",
    baseURL: "http://127.0.0.1:8899",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultContextWindow: 128000,
    efforts: ["off", "high", "max"],
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 128000, efforts: ["off", "high", "max"] },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 128000, efforts: ["off", "high", "max"] },
    ],
  },
  // 注：原 openai 条目（CRS 网关 http://10.100.154.16:3000/openai/v1）是私有环境
  // 配置，硬编码进默认列表会泄露内网地址，已移除（S-07）。需要者自行
  // /provider add openai <baseURL> <apiKeyEnv> 或编辑 tui-providers.json；
  // 已有配置文件里的 openai 条目不受影响（ensureConfig 只迁移字段，不增删）。
  {
    name: "openrouter",
    displayName: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultContextWindow: 200000,
    efforts: ["off", "low", "high"],
    models: [
      { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, efforts: ["off", "low", "high"] },
      { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128000, efforts: ["off", "low", "high"] },
    ],
  },
  {
    name: "anthropic",
    displayName: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultContextWindow: 200000,
    efforts: ["off", "low", "high"],
    models: [
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", contextWindow: 200000, efforts: ["off", "low", "high"] },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, efforts: ["off", "low", "high"] },
    ],
  },
  {
    name: "gemini",
    displayName: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultContextWindow: 1000000,
    efforts: ["off", "low", "high"],
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000, efforts: ["off", "low", "high"] },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1000000, efforts: ["off", "low", "high"] },
    ],
  },
  {
    name: "ollama",
    displayName: "Ollama (local)",
    baseURL: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    defaultContextWindow: 32768,
    efforts: ["off"],
    models: [
      { id: "qwen3:8b", name: "Qwen3 8B", contextWindow: 32768, efforts: ["off"] },
      { id: "llama3.3:70b", name: "Llama 3.3 70B", contextWindow: 131072, efforts: ["off"] },
    ],
  },
  {
    name: "vllm",
    displayName: "vLLM (local)",
    baseURL: "http://127.0.0.1:8000/v1",
    apiKeyEnv: "VLLM_API_KEY",
    defaultContextWindow: 32768,
    efforts: ["off"],
    models: [{ id: "local-model", name: "Local vLLM model", contextWindow: 32768, efforts: ["off"] }],
  },
  {
    name: "qwen",
    displayName: "Qwen (阿里云)",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "QWEN_API_KEY",
    defaultContextWindow: 131072,
    efforts: ["off", "low", "high", "max"],
    models: [
      { id: "qwen-max", name: "Qwen-Max", contextWindow: 131072, efforts: ["off", "low", "high", "max"] },
      { id: "qwen3-coder-plus", name: "Qwen3-Coder-Plus", contextWindow: 131072, efforts: ["off", "low", "high"] },
    ],
  },
  {
    name: "kimi",
    displayName: "Kimi (Moonshot)",
    baseURL: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
    defaultContextWindow: 131072,
    efforts: ["off", "low", "high"],
    models: [
      { id: "kimi-k3", name: "Kimi K3", contextWindow: 131072, efforts: ["off", "low", "high"] },
    ],
  },
];

// 配置文件损坏时备份为 .bak 的提示状态（供 /providers 面板展示）
let lastConfigIssue = null; // "corrupt-backup" | null

function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return null; // 文件不存在（首次运行）→ 由 ensureConfig 创建默认
  }
  try {
    return JSON.parse(raw);
  } catch {
    // 文件存在但 JSON 损坏：绝不静默覆盖——原样备份为 .bak 后返回标记，让
    // ensureConfig 提示并重建默认，用户可手工从 .bak 找回原配置（S-09）。
    try { writeFileSync(`${CONFIG_PATH}.bak`, raw); } catch { /* 备份失败不阻断重建 */ }
    return { __corrupt: true };
  }
}

function saveConfig(cfg) {
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true });
  // 原子写：先写临时文件再 rename，避免进程中途崩溃留下半截 JSON 损坏配置（S-10）
  const tmpPath = `${CONFIG_PATH}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
    renameSync(tmpPath, CONFIG_PATH);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* 清理失败忽略 */ }
    throw e;
  }
}

function ensureConfig(logger) {
  let cfg = loadConfig();
  if (cfg?.__corrupt) {
    lastConfigIssue = "corrupt-backup";
    logger?.warn?.(`[dsh-tui-providers] ${CONFIG_PATH} JSON 损坏：已备份为 ${CONFIG_PATH}.bak 并重建默认配置（原配置可在 .bak 中找回）`);
    cfg = { providers: DEFAULT_PROVIDERS };
    saveConfig(cfg);
    return cfg;
  }
  if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    cfg = { providers: DEFAULT_PROVIDERS };
    saveConfig(cfg);
    return cfg;
  }
  // Migrate existing configs: fold in new default fields (efforts,
  // stripToolFields, extraSystem, defaultContextWindow) for known providers
  // while keeping the user's baseURL/keyEnv/models. 不再自动追加缺失的默认
  // provider：用户删除的默认项（/provider remove）不会被重启回补（S-08）。
  const byName = new Map(DEFAULT_PROVIDERS.map((p) => [p.name, p]));
  let changed = false;
  for (const p of cfg.providers) {
    const def = byName.get(p.name);
    if (!def) continue;
    for (const k of ["efforts", "stripToolFields", "extraSystem", "defaultContextWindow"]) {
      if (p[k] === undefined && def[k] !== undefined) { p[k] = def[k]; changed = true; }
    }
    if (Array.isArray(p.models) && Array.isArray(def.models)) {
      for (const m of p.models) {
        const dm = def.models.find((x) => x.id === (typeof m === "string" ? m : m.id));
        if (dm && typeof m === "object" && m.efforts === undefined && dm.efforts) { m.efforts = dm.efforts; changed = true; }
      }
    }
  }
  if (changed) saveConfig(cfg);
  return cfg;
}

function toConnection(p) {
  return {
    baseURL: String(p.baseURL || "").replace(/\/$/, ""),
    apiKeyEnv: p.apiKeyEnv || "API_KEY",
    displayName: p.displayName || p.name,
    models: Array.isArray(p.models) ? p.models.map((m) => (typeof m === "string" ? { id: m, name: m } : m)) : [],
    defaultContextWindow: p.defaultContextWindow ?? 128000,
    maxTokens: p.maxTokens,
    defaults: { thinking: p.thinking, reasoningEffort: p.reasoningEffort },
    efforts: Array.isArray(p.efforts) ? p.efforts : ["off", "low", "high", "max"],
    extraHeaders: p.extraHeaders,
    extraSystem: p.extraSystem,
    stripToolFields: Array.isArray(p.stripToolFields) ? p.stripToolFields : undefined,
  };
}

/** Probe {baseURL}/models with the provider key; returns status + model/effort info. */
async function probeProvider(ctx, conn, p) {
  const credentials = ctx.get("credentials");
  let apiKey;
  try {
    const hit = credentials ? await credentials.resolve(conn.apiKeyEnv) : undefined;
    apiKey = hit?.value ?? process.env[conn.apiKeyEnv] ?? "";
  } catch { apiKey = ""; }
  const effortInfo = conn.efforts?.length ? `力度 ${conn.efforts.join("/")}` : "";
  try {
    const res = await fetch(`${conn.baseURL}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data ?? []).map((m) => m.id);
      const verified = ids.filter((id) => (p?.models ?? []).some((m) => (typeof m === "string" ? m : m.id) === id));
      const note = verified.length ? `✓ 验证 ${verified.length}/${ids.length}（${verified.slice(0, 3).join(", ")}…）` : `✓ 网关 ${ids.length} 模型（配置未匹配，用预置 ${conn.models.length}）`;
      return `${note} · ${effortInfo}`;
    }
    return `✗ HTTP ${res.status} · 预置 ${conn.models.length} 模型 · ${effortInfo}`;
  } catch (e) {
    return `✗ ${e.message?.slice(0, 30) ?? e} · 预置 ${conn.models.length} 模型 · ${effortInfo}`;
  }
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-providers] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  const cfg = ensureConfig(ctx.logger);
  const connections = new Map();
  for (const p of cfg.providers) connections.set(p.name, toConnection(p));

  const adapter = new OpenAICompatAdapter(connections);
  // Lazy credential resolution: ctx.get() during apply() may run before the
  // credentials-local entry activates (returns undefined). Resolve per call.
  adapter.credentialsResolver = {
    resolve: async (ref) => ctx.get("credentials")?.resolve(ref),
  };
  // deepseek-official is already owned by @deepseek-ai/dsh-llm-deepseek;
  // registering it again would throw "already registered" and kill the whole
  // batch. Our brick owns only the EXTRA provider routes.
  const ownedRoutes = () => [...connections.keys()].filter((n) => n !== "deepseek-official");
  let registration;
  try {
    const llm = ctx.get("llm");
    if (llm?.registerAdapter) {
      registration = llm.registerAdapter(ownedRoutes(), adapter);
      ctx.logger.info(`[dsh-tui-providers] registered ${ownedRoutes().length} extra provider routes: ${ownedRoutes().join(", ")}`);
    } else {
      ctx.logger.warn("[dsh-tui-providers] llm.registerAdapter unavailable — providers registered but inert");
    }
  } catch (e) {
    ctx.logger.warn(`[dsh-tui-providers] adapter registration failed: ${e.message}`);
  }

  function currentProvider(store) {
    return store.meta?.provider ?? "unknown";
  }

  /* -------- model catalog (feeds the core /model picker) -------- */
  disposers.push(ext.registerModelCatalog(async () => {
    const groups = [];
    for (const p of cfg.providers) {
      const conn = toConnection(p);
      const models = conn.models.length
        ? conn.models
        : (() => {
            try {
              return [];
            } catch { return []; }
          })();
      groups.push({
        provider: p.name,
        providerName: p.displayName ?? p.name,
        efforts: conn.efforts,
        items: models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow ?? conn.defaultContextWindow,
          efforts: Array.isArray(m.efforts) ? m.efforts : conn.efforts,
        })),
      });
    }
    return groups;
  }));

  /* -------- /effort (Claude Code style: switch reasoning effort now) -------- */
  disposers.push(ext.registerCommand({
    name: "/effort",
    busySafe: false,
    handler(full, ctl, store) {
      const arg = full.slice("/effort".length).trim().toLowerCase();
      const known = ["off", "low", "medium", "high", "max"];
      if (!known.includes(arg)) {
        ctl.notice("warning", `用法: /effort <${known.join("|")}>（Claude Code 式；立即生效）`);
        return;
      }
      const sel = ctx.get("agentDefaultModel")?.currentSelection?.();
      if (!sel) {
        ctl.notice("error", "无法读取当前模型选择");
        return;
      }
      // Use the LIVE provider from the status-bar meta (currentSelection()
      // reflects the persisted default, which lags behind /provider switches).
      const liveProvider = store.meta?.provider;
      const effProvider = (liveProvider && cfg.providers.some((p) => p.name === liveProvider)) ? liveProvider : sel.provider;
      // S-11: 用 live provider 时 model 也要取该 provider 的（store.meta.model 是
      // /provider 切换后写入的实时值；currentSelection 可能是旧 provider 的持久化值），
      // 并校验 model 属于 effProvider 的模型列表，不匹配直接报错提示而非静默错配。
      const effModel = (liveProvider === effProvider && store.meta?.model) ? store.meta.model : sel.model;
      const target = cfg.providers.find((p) => p.name === effProvider);
      const modelIds = Array.isArray(target?.models) ? target.models.map((m) => (typeof m === "string" ? m : m.id)) : [];
      if (modelIds.length > 0 && !modelIds.includes(effModel)) {
        ctl.notice("error", `${effProvider} 的模型列表不含 ${effModel}（${modelIds.join(" / ")}）；请先 /model 选择该 provider 的模型`);
        return;
      }
      // 力度校验优先看模型级 efforts（同 resolveModel：模型级 > provider 级）
      const modelEfforts = (Array.isArray(target?.models) ? target.models.find((m) => typeof m === "object" && m.id === effModel) : undefined)?.efforts;
      const conn = toConnection(target ?? {});
      const supported = Array.isArray(modelEfforts) ? modelEfforts : (conn.efforts ?? []);
      if (!supported.includes(arg)) {
        ctl.notice("warning", `${effProvider}（${effModel}）的模型力度集合为 ${supported.join("/")}，不支持 ${arg}；用 /model 选模型后 e 遍历`);
        return;
      }
      (async () => {
        try {
          const m = ctx.get("agentDefaultModel");
          await m.saveSelection({ provider: effProvider, model: effModel, reasoningEffort: arg });
          // 同步实时选择快照（含 provider/model），保证 /effort 与 /provider 状态一致
          ctl.updateSelection({ reasoningEffort: arg, provider: effProvider, model: effModel });
          ctl.notice("success", `推理力度 → ${arg}（立即生效）`);
        } catch (e) {
          ctl.notice("error", `切换失败: ${e.message}`);
        }
      })();
    },
  }));

  /* -------- /providers panel -------- */
  disposers.push(ext.registerCommand({
    name: "/providers",
    busySafe: true,
    handler(full, ctl) {
      ctl.openExtPanel("providers");
    },
  }));

  disposers.push(ext.registerPanel({
    id: "providers",
    title: "LLM Provider / providers",
    async load(store) {
      const lines = [];
      const current = currentProvider(store);
      lines.push(`当前 provider: ${current}`);
      lines.push("");
      lines.push(`配置: ${CONFIG_PATH}`);
      if (lastConfigIssue === "corrupt-backup") {
        lines.push("⚠ 配置文件曾损坏，已备份为 tui-providers.json.bak（当前为重建默认，原配置可在 .bak 找回）");
      }
      lines.push("");
      // credential resolution diagnostics (quick self-check for each route)
      const cred = ctx.get("credentials");
      const rows = await Promise.all(cfg.providers.map(async (p) => {
        let credState = "?";
        try {
          const hit = cred ? await cred.resolve(p.apiKeyEnv || "API_KEY") : undefined;
          credState = hit ? `key ✓(${String(hit.value).slice(0, 4)}…)` : "key ✗未找到";
        } catch (e) { credState = `key ✗${e.message?.slice(0, 30)}`; }
        const conn = toConnection(p);
        const mark = p.name === current ? "▶" : " ";
        const status = await probeProvider(ctx, conn, p);
        // 404 on /models is common for gateways that only serve chat — annotate
        // so the row doesn't read as "provider is broken".
        const annotated = /HTTP 404/.test(status) ? `${status}（/models 探测不受支持，聊天仍可用）` : status;
        return [`${mark} ${p.displayName} (${p.name})`, `   ${conn.baseURL} · ${credState} · ${annotated}`];
      }));
      for (const r of rows) lines.push(...r);
      lines.push("");
      lines.push("提示: /provider <名> 切换；/provider add <名> <baseURL> <apiKeyEnv> [模型...] 添加；编辑 JSON 后重启生效");
      return { lines };
    },
  }));

  /* -------- /provider 命令 -------- */
  disposers.push(ext.registerCommand({
    name: "/provider",
    busySafe: false,
    handler(full, ctl, store) {
      const args = full.slice("/provider".length).trim().split(/\s+/);
      const cmd = args[0] ?? "";
      if (cmd === "add") {
        const name = args[1];
        const baseURL = args[2];
        const apiKeyEnv = args[3];
        const models = args.slice(4).map((id) => ({ id, name: id }));
        if (!name || !baseURL || !apiKeyEnv) {
          ctl.notice("warning", "用法: /provider add <名> <baseURL> <apiKeyEnv> [模型1 模型2 ...]");
          return;
        }
        if (cfg.providers.some((p) => p.name === name)) {
          ctl.notice("warning", `provider ${name} 已存在（编辑 ${CONFIG_PATH} 修改）`);
          return;
        }
        cfg.providers.push({ name, displayName: name, baseURL, apiKeyEnv, models });
        saveConfig(cfg);
        connections.set(name, toConnection(cfg.providers.at(-1)));
        try { registration?.replace(ownedRoutes()); } catch (e) { ctx.logger.warn(`[dsh-tui-providers] hot re-register failed: ${e.message}`); }
        ctl.notice("success", `已添加 provider ${name}（${baseURL}）。/provider ${name} 切换；若 /model 未列出新模型请重启 TUI`);
        return;
      }
      if (cmd === "remove") {
        const name = args[1];
        if (!name) { ctl.notice("warning", "用法: /provider remove <名>"); return; }
        if (name === currentProvider(store)) { ctl.notice("warning", "不能移除当前使用的 provider，先切到别的"); return; }
        if (!cfg.providers.some((p) => p.name === name)) {
          ctl.notice("warning", `未知 provider: ${name}（/provider list 查看）`);
          return;
        }
        cfg.providers = cfg.providers.filter((p) => p.name !== name);
        saveConfig(cfg);
        connections.delete(name);
        try { registration?.replace(ownedRoutes()); } catch (e) { ctx.logger.warn(`[dsh-tui-providers] hot re-register failed: ${e.message}`); }
        ctl.notice("success", `已移除 provider ${name}`);
        return;
      }
      if (cmd === "list" || cmd === "") {
        ctl.notice("info", `providers（当前 ${currentProvider(store)}）:\n${cfg.providers.map((p) => `  ${p.name === currentProvider(store) ? "▶" : " "} ${p.name} — ${p.displayName} @ ${p.baseURL}`).join("\n")}\n\n用法: /provider <名> 切换 · /provider add|remove`);
        return;
      }
      // switch: /provider <name>
      const target = cfg.providers.find((p) => p.name === cmd);
      if (!target) {
        ctl.notice("warning", `未知 provider: ${cmd}（/provider list 查看）`);
        return;
      }
      if (store.get().input?.busy) {
        ctl.notice("warning", "agent 正忙，请在空闲时切换 provider");
        return;
      }
      const model = Array.isArray(target.models) && target.models.length > 0
        ? (typeof target.models[0] === "string" ? target.models[0] : target.models[0].id)
        : "default";
      // S-12: 力度不再硬编码 "high"——按 resolveModel 的 fallback 链取目标 provider
      // 支持的力度：模型级 efforts > provider efforts > 默认集；优先 high，否则
      // efforts[0]，最后 "off" 兜底（如 ollama 只有 off，切过去给 high 会直接报错）。
      const tconn = toConnection(target);
      const firstModel = Array.isArray(target.models) && target.models.length > 0
        ? (typeof target.models[0] === "string" ? { id: target.models[0] } : target.models[0])
        : undefined;
      const effortIds = firstModel?.efforts ?? tconn.efforts ?? ["off", "low", "high", "max"];
      const effort = effortIds.includes("high") ? "high" : (effortIds[0] ?? "off");
      (async () => {
        try {
          const defaultModel = ctx.get("agentDefaultModel");
          if (defaultModel?.saveSelection) {
            await defaultModel.saveSelection({ provider: target.name, model, reasoningEffort: effort });
          }
          // apply immediately to the running agent (mutable selection snapshot)
          ctl.updateSelection({ provider: target.name, model, reasoningEffort: effort });
          // keep status bar / splash in sync (core /model does this too)
          store.set({ meta: { ...store.get().meta, model, provider: target.name } });
          ctl.notice("success", `已切换 provider → ${target.name}（${model}）。立即生效；/model 可换模型与力度`);
        } catch (e) {
          ctl.notice("error", `切换失败: ${e.message}`);
        }
      })();
    },
  }));

  /* -------- 状态栏字段 -------- */
  disposers.push(ext.registerStatusField({
    id: "providers-name",
    order: 20,
    render(store) {
      const p = store.meta?.provider;
      return p && p !== "deepseek-official" ? `prov ${p}` : "";
    },
  }));

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

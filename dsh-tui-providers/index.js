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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 128000 },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 128000 },
    ],
  },
  {
    name: "openrouter",
    displayName: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: [{ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
  },
  {
    name: "ollama",
    displayName: "Ollama (local)",
    baseURL: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    models: [{ id: "qwen3:8b", name: "Qwen3 8B" }],
  },
];

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return null; }
}

function saveConfig(cfg) {
  mkdirSync(join(CONFIG_PATH, ".."), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function ensureConfig() {
  let cfg = loadConfig();
  if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    cfg = { providers: DEFAULT_PROVIDERS };
    saveConfig(cfg);
  }
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
    extraHeaders: p.extraHeaders,
    extraSystem: p.extraSystem,
    stripToolFields: Array.isArray(p.stripToolFields) ? p.stripToolFields : undefined,
  };
}

/** Probe {baseURL}/models with the provider key; returns status string. */
async function probeProvider(ctx, conn) {
  const credentials = ctx.get("credentials");
  let apiKey;
  try {
    const hit = credentials ? await credentials.resolve(conn.apiKeyEnv) : undefined;
    apiKey = hit?.value ?? process.env[conn.apiKeyEnv] ?? "";
  } catch { apiKey = ""; }
  try {
    const res = await fetch(`${conn.baseURL}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data ?? []).map((m) => m.id);
      return `✓ ${ids.length} 模型${ids.length ? "（" + ids.slice(0, 3).join(", ") + "…）" : ""}`;
    }
    return `✗ HTTP ${res.status}`;
  } catch (e) {
    return `✗ ${e.message?.slice(0, 40) ?? e}`;
  }
}

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-providers] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];
  const cfg = ensureConfig();
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
    return store.meta?.provider ?? "?";
  }

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
      lines.push("");
      // credential resolution diagnostics (quick self-check for each route)
      const cred = ctx.get("credentials");
      for (const p of cfg.providers) {
        let credState = "?";
        try {
          const hit = cred ? await cred.resolve(p.apiKeyEnv || "API_KEY") : undefined;
          credState = hit ? `key ✓(${String(hit.value).slice(0, 4)}…)` : "key ✗未找到";
        } catch (e) { credState = `key ✗${e.message?.slice(0, 30)}`; }
        const conn = toConnection(p);
        const mark = p.name === current ? "▶" : " ";
        const status = await probeProvider(ctx, conn);
        lines.push(`${mark} ${p.displayName} (${p.name})`);
        lines.push(`   ${conn.baseURL} · ${credState} · ${status}`);
      }
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
      (async () => {
        try {
          const defaultModel = ctx.get("agentDefaultModel");
          if (defaultModel?.saveSelection) {
            await defaultModel.saveSelection({ provider: target.name, model, reasoningEffort: "high" });
          }
          ctl.notice("success", `已切换 provider → ${target.name}（${model}）。下一条消息生效；/model 可换模型`);
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

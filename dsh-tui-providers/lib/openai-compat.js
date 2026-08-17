/**
 * openai-compat.js — generic OpenAI-compatible LLM adapter for dsh.
 *
 * Protocol layer ported from @deepseek-ai/dsh-llm-deepseek (MIT): request
 * serialization, SSE parsing, and the wire→harness StreamChunk translation
 * are kept wire-compatible so any provider speaking chat/completions
 * (DeepSeek, OpenRouter, Together, Groq, Ollama, vLLM, ...) works. The
 * adapter is multi-provider: one instance serves every registered provider
 * route, selecting its connection by options.provider (Hermes-style
 * transport: openai_chat).
 *
 * @module dsh-tui-providers/openai-compat
 */

import {
  LlmAdapter, LlmError, CallId, EMPTY_RESPONSE_CODE, QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE, attributionHeaders, assertUsableApiKey, ReasoningEffortId, contentHasImage,
} from "@deepseek-ai/dsh-llm";

const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: "Off" },
  { id: HIGH_REASONING_EFFORT, name: "High" },
  { id: MAX_REASONING_EFFORT, name: "Max" },
];
const OFF_ONLY_REASONING_EFFORTS = [{ id: OFF_REASONING_EFFORT, name: "Off" }];

/* ------------------------------------------------------------------ */
/* wire serialization                                                  */
/* ------------------------------------------------------------------ */

function flattenText(content) {
  return (content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) throw new LlmError("The OpenAI-compatible adapter does not support image content.", "UNSUPPORTED_CONTENT");
}

function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  const toolCalls = message.content.filter((b) => b.type === "tool-call").map((b) => ({
    id: b.id,
    type: "function",
    function: { name: b.name, arguments: b.arguments },
  }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((b) => b.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: "user", content: text });
    for (const result of toolResults) {
      wire.push({ role: "tool", tool_call_id: result.toolCallId, content: flattenText(result.content) || "(no output)" });
    }
  }
  return wire;
}

function resolveThinking(options, defaults) {
  const thinking = options.reasoning?.thinking ?? defaults.thinking;
  const reasoningEffort = options.reasoning?.reasoningEffort ?? defaults.reasoningEffort;
  // Only send these fields when the provider explicitly configured them.
  // Some gateways (e.g. the CRS OpenAI-compatible gateway) reject
  // thinking:{type:...} and reasoning_effort:"high" outright (they flip it
  // into Codex mode and error "model not supported when using Codex"), so
  // absent config = omit both.
  return {
    thinking: thinking === "enabled" ? "enabled" : thinking === "disabled" ? "disabled" : undefined,
    reasoningEffort: reasoningEffort === "off" || reasoningEffort === undefined ? undefined : reasoningEffort,
  };
}

function serializeRequest(options, defaults, stripToolFields) {
  const messages = [];
  if (options.system !== undefined) messages.push({ role: "system", content: options.system });
  messages.push(...serializeMessages(options.messages));
  const tools = options.tools?.map((tool) => {
    const params = tool.parameters ? { ...tool.parameters } : undefined;
    if (params && stripToolFields?.length) {
      // Remove schema fields the model keeps misusing (e.g. bash
      // sandbox_permissions/justification) so it cannot generate them.
      const props = params.properties ? { ...params.properties } : undefined;
      if (props) {
        for (const f of stripToolFields) delete props[f];
        params.properties = props;
        if (Array.isArray(params.required)) {
          params.required = params.required.filter((r) => !stripToolFields.includes(r));
        }
      }
    }
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: params ?? { type: "object" } },
    };
  });
  const resolved = resolveThinking(options, defaults);
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(resolved.thinking !== undefined ? { thinking: { type: resolved.thinking } } : {}),
    ...(resolved.reasoningEffort !== undefined ? { reasoning_effort: resolved.reasoningEffort } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* SSE parsing (self-contained; no EventSourceParserStream dependency)  */
/* ------------------------------------------------------------------ */

async function* parseSse(stream) {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data.length === 0) continue;
        yield data;
        if (data === "[DONE]") return;
      }
    }
  }
  if (buffer.trim().length > 0 && buffer.trim() !== "[DONE]") {
    throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
  }
}

/* ------------------------------------------------------------------ */
/* wire → harness translation (ported from dsh-llm-deepseek, MIT)       */
/* ------------------------------------------------------------------ */

function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return {
      type: "tool-call",
      id: CallId(block.callId ?? ""),
      name: block.name ?? "",
      arguments: block.text,
    };
    default: return { type: block.kind, text: block.text };
  }
}

async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  const open = (kind) => {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };
  // Some gateways never send [DONE] and keep the connection open after the
  // finish_reason; after finish we wait a short grace for trailing usage /
  // [DONE] and then finalize normally instead of hanging forever.
  const iterator = payloads[Symbol.asyncIterator]();
  const grace = (ms) => new Promise((r) => setTimeout(r, ms));
  const finalize = function* (reason) {
    for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
    if (pendingUsage) yield { type: "usage", usage: pendingUsage };
    yield {
      type: "finish",
      reason: reason.kind === "stop" && order.length === 0
        ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
        : reason,
    };
  };
  while (true) {
    let result;
    // The gateway may omit [DONE] AND finish_reason entirely (some CRS
    // backends end with a bare usage chunk and keep the connection open).
    // Once we have a finish signal (finish_reason or usage), race a short
    // grace against the next payload and finalize if nothing arrives.
    if (pendingFinish || pendingUsage) {
      result = await Promise.race([
        iterator.next(),
        grace(2500).then(() => ({ value: "[DONE]", done: false, fromTimeout: true })),
      ]);
    } else {
      result = await iterator.next();
    }
    if (result.done) {
      yield* finalize(pendingFinish ?? { kind: "stop" });
      return;
    }
    const payload = result.value;
    if (payload === "[DONE]") {
      yield* finalize(pendingFinish ?? { kind: "stop" });
      return;
    }
    let chunk;
    try { chunk = JSON.parse(payload); } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== undefined) block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }
    if ((pendingFinish || pendingUsage) && result.fromTimeout) {
      // grace expired without [DONE]: finalize now
      yield* finalize(pendingFinish ?? { kind: "stop" });
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* error mapping                                                       */
/* ------------------------------------------------------------------ */

function requestId(headers) {
  return headers.get("x-request-id") ?? headers.get("x-ratelimit-request-id") ?? undefined;
}

function providerRetryAfterMs(header) {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const d = new Date(header).getTime();
  if (Number.isFinite(d)) return Math.max(0, d - Date.now()) || undefined;
  return undefined;
}

function httpErrorCode(status, error) {
  const detail = String(error?.message ?? error?.code ?? "");
  if (/(quota|insufficient_quota|billing)/i.test(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (/(context|token|maximum|exceed)/i.test(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/* ------------------------------------------------------------------ */
/* multi-provider adapter                                              */
/* ------------------------------------------------------------------ */

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description !== undefined ? { description: model.description } : {}),
    inputModalities: ["text"],
  };
}

export class OpenAICompatAdapter extends LlmAdapter {
  /** @param connections {Map<string, object>} provider -> connection */
  constructor(connections) {
    super();
    this.connections = connections;
  }

  providerInfo(provider) {
    const conn = this.connections.get(provider);
    return { id: provider, name: conn?.displayName ?? provider };
  }

  providerRetryPolicy(_provider) {
    return undefined; // harness defaults
  }

  listModels(provider) {
    const conn = this.connections.get(provider);
    if (!conn) return Promise.resolve([]);
    return Promise.resolve((conn.models ?? []).map((m) => modelInfo(provider, m)));
  }

  resolveModel(provider, model, _signal) {
    const conn = this.connections.get(provider);
    const configured = conn?.models?.find((m) => m.id === model);
    const contextWindow = configured?.contextWindow ?? conn?.defaultContextWindow;
    if (!conn) {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ["text"] });
    }
    const thinking = conn.defaults?.thinking;
    // Model effort set: configured per model > provider efforts > deepseek-like default
    const effortIds = configured?.efforts ?? conn.efforts;
    const efforts = effortIds
      ? effortIds.map((e) => ({ id: ReasoningEffortId(e), name: e[0].toUpperCase() + e.slice(1) }))
      : REASONING_EFFORTS;
    // Default effort must be a member of the model's own effort set, or the
    // harness rejects it (INVALID_MODEL_REASONING) and every turn fails —
    // e.g. ollama qwen3:8b declares efforts ["off"] only.
    const hasEffort = (id) => efforts.some((e) => e.id === id);
    const defaultEffort =
      conn.defaults?.reasoningEffort === "off" && hasEffort(OFF_REASONING_EFFORT) ? OFF_REASONING_EFFORT
      : conn.defaults?.reasoningEffort === "max" && hasEffort(MAX_REASONING_EFFORT) ? MAX_REASONING_EFFORT
      : hasEffort(HIGH_REASONING_EFFORT) ? HIGH_REASONING_EFFORT
      : efforts[0]?.id ?? OFF_REASONING_EFFORT;
    return Promise.resolve({
      ...(configured === undefined ? { provider, id: model, name: model, inputModalities: ["text"] } : modelInfo(provider, configured)),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? conn.maxTokens,
      ...(thinking === "disabled"
        ? { reasoning: { efforts: OFF_ONLY_REASONING_EFFORTS, defaultEffort: OFF_REASONING_EFFORT } }
        : { reasoning: { efforts, defaultEffort } }),
    });
  }

  async *stream(options) {
    const provider = options.provider ?? "default";
    const conn = this.connections.get(provider);
    if (!conn) throw new LlmError(`unknown provider route: ${provider}`, "INVALID_REQUEST");
    const apiKey = await resolveApiKey(conn, this.credentialsResolver);
    // Provider-configured system-prompt augmentation (e.g. tell the model
    // about the sandbox mode so it stops requesting escalations).
    const system = conn.extraSystem
      ? `${options.system ?? ""}\n\n[environment]\n${conn.extraSystem}`
      : options.system;
    const body = serializeRequest({ ...options, system }, conn.defaults ?? {}, conn.stripToolFields);
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders(),
      ...(conn.extraHeaders ?? {}),
    };
    // Some gateways (the CRS OpenAI-compatible gateway) route requests to a
    // backend that rejects the model ~50% of the time with a 400 whose detail
    // mentions "Codex". This is transient — the same body succeeds on the
    // other backend — so retry that specific failure a few times.
    const transient400 = /not supported when using Codex/i;
    let response;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
      try {
        response = await fetch(`${conn.baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        lastError = new LlmError(`provider ${provider} request to ${conn.baseURL} failed`, "TRANSPORT", { cause: error });
        continue;
      }
      if (!response.ok) {
        let message = `provider ${provider} error (HTTP ${response.status})`;
        let providerError;
        try {
          const errBody = await response.json();
          providerError = errBody?.error ?? errBody;
          if (providerError?.message) message = providerError.message;
          else if (providerError?.detail) message = String(providerError.detail);
        } catch { /* non-JSON error body */ }
        if (response.status === 400 && transient400.test(message)) {
          lastError = new LlmError(message, "TRANSPORT", { status: 400 });
          continue; // transient gateway routing: retry
        }
        const delay = providerRetryAfterMs(response.headers.get("retry-after"));
        const id = requestId(response.headers);
        throw new LlmError(message, httpErrorCode(response.status, providerError), {
          status: response.status,
          ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
          ...(id === undefined ? {} : { requestId: id }),
        });
      }
      break;
    }
    if (!response?.ok) {
      throw lastError ?? new LlmError(`provider ${provider} request failed after retries`, "TRANSPORT");
    }
    if (!response.body) throw new LlmError("provider returned no response body", "EMPTY_RESPONSE");
    yield* translate(parseSse(response.body));
  }
}

/** Resolve a connection's API key through the dsh credentials seam. */
export async function resolveApiKey(conn, credentialsResolver) {
  const ref = conn.apiKeyEnv;
  if (credentialsResolver) {
    const hit = await credentialsResolver.resolve(ref);
    if (hit !== undefined) return assertUsableApiKey(hit.value, "dsh-tui-providers", ref);
  }
  if (typeof process !== "undefined" && process.env?.[ref]?.length > 0) {
    return assertUsableApiKey(process.env[ref], "dsh-tui-providers", ref);
  }
  throw new LlmError(
    `dsh-tui-providers: no API key for provider route; store ${ref} in ~/.dsh/.credentials.yaml or export ${ref} in the environment (resolver=${credentialsResolver ? "present" : "MISSING"}, env=${typeof process !== "undefined" && process.env?.[ref] ? "present" : "absent"})`,
    "MISSING_CREDENTIAL"
  );
}

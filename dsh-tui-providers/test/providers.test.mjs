/**
 * providers.test.mjs — behavioral tests for the dsh-tui-providers OpenAI-compat
 * adapter. Run: node dsh-tui-providers/test/providers.test.mjs
 *
 * Covers the gateway-compat fixes (commit 777e2ca):
 *   - transient-400 retry (CRS gateway routes ~50% of requests to a backend
 *     that rejects the model)
 *   - stripToolFields (stop gpt-5.6-sol passing sandbox_permissions etc.)
 *   - thinking/reasoning_effort omitted when unconfigured (CRS rejects them)
 *   - lazy credentials resolver (apply-time ctx.get may precede activation)
 *   - closeBlock vocabulary {type, id: CallId, name, arguments} so harness
 *     dispatches tool calls
 *   - translate event sequence (reasoning/text/tool-call/usage/finish)
 *
 * @module dsh-tui-providers/test
 */

import assert from "node:assert";
import { OpenAICompatAdapter } from "../lib/openai-compat.js";

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

const sseOf = (payloads) => payloads.map((p) => `data: ${JSON.stringify(p)}`).join("\n") + "\ndata: [DONE]\n\n";
const streamOf = (text) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
const mkConn = (extra = {}) => new Map([["t", {
  baseURL: "http://x", apiKeyEnv: "K", displayName: "T",
  models: [{ id: "m", name: "M", contextWindow: 8 }],
  defaults: {}, maxTokens: 100, ...extra,
}]]);
const mkAdapter = (conns, resolver = { resolve: async () => ({ value: "k" }) }) => {
  const a = new OpenAICompatAdapter(conns);
  a.credentialsResolver = resolver;
  return a;
};
const collect = async (adapter, opts) => {
  const evs = [];
  for await (const ev of adapter.stream(opts)) evs.push(ev);
  return evs;
};

// 1. retry + stripToolFields + omit thinking/effort
{
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    if (calls.length === 1) {
      return { ok: false, status: 400, headers: new Map(), json: async () => ({ detail: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." }) };
    }
    return { ok: true, status: 200, headers: new Map(), body: streamOf(sseOf([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ])) };
  };
  const adapter = mkAdapter(mkConn({ stripToolFields: ["sandbox_permissions", "justification"] }));
  const evs = await collect(adapter, {
    provider: "t", model: "m", system: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "bash", description: "d", parameters: { type: "object", properties: { command: { type: "string" }, sandbox_permissions: { type: "string" }, justification: { type: "string" } }, required: ["command", "justification"] } }],
  });
  assert.equal(calls.length, 2, "expected a retry (2 fetch calls)");
  const props = calls[1].tools[0].function.parameters.properties;
  assert.ok(!("sandbox_permissions" in props) && !("justification" in props), "stripToolFields must remove fields");
  assert.ok(!calls[1].tools[0].function.parameters.required.includes("justification"), "required must be stripped too");
  assert.ok(calls[1].thinking === undefined && calls[1].reasoning_effort === undefined, "thinking/effort omitted when unconfigured");
  assert.ok(evs.some((e) => e.type === "finish"), "stream must finish");
  ok("retry + stripToolFields + omit thinking/effort");
}

// 2. closeBlock vocabulary: tool-call block-end carries {type, id: CallId, name, arguments}
{
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), body: streamOf(sseOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])) });
  const adapter = mkAdapter(mkConn());
  const evs = await collect(adapter, { provider: "t", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
  const be = evs.find((e) => e.type === "block-end" && e.block?.type === "tool-call");
  assert.ok(be, "tool-call block-end must exist");
  assert.equal(be.block.id, "c1");
  assert.equal(be.block.name, "bash");
  assert.ok(be.block.arguments !== undefined);
  ok("closeBlock vocabulary {type, id, name, arguments}");
}

// 3. translate event sequence (reasoning/text/tool-call/usage/finish ordering)
{
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), body: streamOf(sseOf([
    { choices: [{ delta: { reasoning_content: "think" } }] },
    { choices: [{ delta: { content: "text" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "bash", arguments: "{}" } }] } }] },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 7 } } },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ])) });
  const adapter = mkAdapter(mkConn());
  const evs = await collect(adapter, { provider: "t", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
  const seq = evs.map((e) => e.type).join(",");
  assert.equal(seq, "block-start,reasoning-delta,block-start,text-delta,block-start,tool-call-delta,block-end,block-end,block-end,usage,finish");
  ok("translate event sequence (reasoning/text/tool-call/usage/finish)");
}

// 4. lazy credentials resolver path + MISSING_CREDENTIAL error message
{
  const adapter = mkAdapter(mkConn(), { resolve: async () => undefined });
  let err = null;
  try {
    globalThis.fetch = async () => { throw new Error("should not reach fetch"); };
    await collect(adapter, { provider: "t", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
  } catch (e) { err = e; }
  assert.ok(err && /MISSING_CREDENTIAL/.test(err.code ?? ""), "missing credential must surface as LlmError code");
  ok("missing-credential path");
}

console.log(`\nproviders tests: ${passed}/4 passed`);
process.exit(passed === 4 ? 0 : 1);

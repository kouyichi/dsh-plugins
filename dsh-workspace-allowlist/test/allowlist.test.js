/**
 * dsh-workspace-allowlist 单测：mock workspaceRegistry/fs，验证白名单
 * 放行/拒绝与 fs 过滤开关。运行：node --test test/allowlist.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "../index.js";

/** 构造可用的 mock ctx：临时目录作为 allowedRoot。 */
async function makeCtx(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "allowlist-"));
  const allowed = overrides.allowedRoots ?? [root];
  const created = [];
  const registry = {
    create: async (p, title) => {
      created.push({ p, title });
      return { path: p, title };
    },
  };
  const calls = { fs: [] };
  const fsSvc = {
    async resolve(t) { calls.fs.push(["resolve", t]); return t; },
    async stat(t) { calls.fs.push(["stat", t]); return { size: 1 }; },
    async readText(t) { calls.fs.push(["readText", t]); return "x"; },
    async listDir(t) { calls.fs.push(["listDir", t]); return []; },
  };
  const ctx = {
    config: {
      allowedRoots: allowed,
      denyFsReads: overrides.denyFsReads ?? false,
      denyPaths: overrides.denyPaths,
    },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "workspaceRegistry") return registry;
      if (name === "fs") return fsSvc;
      return undefined;
    },
  };
  await apply(ctx, ctx.config);
  return { root, registry, fsSvc, calls, created };
}

test("白名单内路径放行（等值 + 子目录）", async () => {
  const { root, registry, created } = await makeCtx();
  await registry.create(path.join(root, "projA"), "A");
  assert.equal(created.length, 1);
  await registry.create(root, "根本身");
  assert.equal(created.length, 2);
});

test("白名单外路径拒绝（WORKSPACE_ALLOWLIST_DENIED）", async () => {
  const { registry, created } = await makeCtx();
  await assert.rejects(
    () => registry.create("/root/secret", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  assert.equal(created.length, 0);
});

test("前缀相似目录拒绝（/workspace/algoritmX 不在 /workspace/algorithm 下）", async () => {
  const { registry, created } = await makeCtx({ allowedRoots: ["/workspace/algorithm"] });
  await assert.rejects(() => registry.create("/workspace/algoritmX/p", "x"));
  // 真正的子目录放行
  await registry.create("/workspace/algorithm/hermes-work", "h");
  assert.equal(created.length, 1);
});

test("denyPaths 排除（精确 + 通配），优先级高于 allowedRoots", async () => {
  const { registry, created } = await makeCtx({
    allowedRoots: ["/workspace/algorithm"],
    denyPaths: [
      "/workspace/algorithm/cambricon-work/cnagent-skill3",
      "/workspace/algorithm/cambricon-work/cnagent-skill*",
    ],
  });
  // 白名单内但不在排除项 → 放行
  await registry.create("/workspace/algorithm/hermes-work", "h");
  assert.equal(created.length, 1);
  // 精确排除
  await assert.rejects(
    () => registry.create("/workspace/algorithm/cambricon-work/cnagent-skill3", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  // 通配排除（cnagent-skill4/5/8/9… 全部拒绝）
  await assert.rejects(
    () => registry.create("/workspace/algorithm/cambricon-work/cnagent-skill8", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  await assert.rejects(
    () => registry.create("/workspace/algorithm/cambricon-work/cnagent-skill9-new", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  // 通配不误伤普通前缀
  await registry.create("/workspace/algorithm/cambricon-work/cnagent-show", "show");
  assert.equal(created.length, 2);
});

test("denyFsReads=false 时不包装 fs（仅注册白名单）", async () => {
  const { fsSvc } = await makeCtx({ denyFsReads: false });
  assert.equal(fsSvc.resolve.length, 1); // 未替换（length 仍是原函数参数个数）
  await fsSvc.readText("/root/secret"); // 不拦截
});

test("denyFsReads=true 时 fs 读写路径过滤", async () => {
  const { fsSvc, root, calls } = await makeCtx({ denyFsReads: true });
  // 白名单内放行
  await fsSvc.readText(path.join(root, "a.txt"));
  assert.equal(calls.fs.filter(([m]) => m === "readText").length, 1);
  // 白名单外拒绝
  await assert.rejects(
    () => fsSvc.readText("/etc/passwd"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  await assert.rejects(
    () => fsSvc.listDir("/root"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  await fsSvc.resolve(root);
  assert.equal(calls.fs.filter(([m]) => m === "resolve").length, 1);
});

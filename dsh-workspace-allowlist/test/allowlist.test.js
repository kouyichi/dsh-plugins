/**
 * dsh-workspace-allowlist 单测：mock workspaceRegistry/fs/directoryPicker，
 * 验证白名单放行/拒绝、denyPaths 通配、per-workspace 严格隔离与前端浏览过滤。
 * 运行：node --test test/allowlist.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "../index.js";

/** 构造可用的 mock ctx：临时目录作为 allowedRoot。 */
async function makeCtx(overrides = {}) {
  const root = overrides.root ?? (await mkdtemp(path.join(tmpdir(), "allowlist-")));
  const allowed = overrides.allowedRoots ?? [root];
  const created = [];
  const registered = [...(overrides.registered ?? [])];
  const registry = {
    create: async (p, title) => {
      created.push({ p, title });
      registered.push(p);
      return { path: p, title };
    },
    list: () => registered.map((p) => ({ path: p, title: path.basename(p) })),
  };
  const calls = { fs: [], picker: [] };
  const fsSvc = {
    async resolve(t, opts) { calls.fs.push(["resolve", t]); return { targetKey: t }; },
    async stat(t) { calls.fs.push(["stat", t]); return { size: 1 }; },
    async readText(t) { calls.fs.push(["readText", t]); return "x"; },
    async listDir(t) { calls.fs.push(["listDir", t]); return []; },
  };
  const pickerCap = {
    list: async (t, signal) => { calls.picker.push(t); return { entries: [] }; },
  };
  const picker = { capability: () => pickerCap };
  const guardFns = [];
  const tools = {
    guard: (fn) => { guardFns.push(fn); return () => {}; },
  };
  const ctx = {
    config: {
      allowedRoots: allowed,
      denyFsReads: overrides.denyFsReads ?? false,
      denyPaths: overrides.denyPaths,
      isolateRoots: overrides.isolateRoots,
      noToolsPaths: overrides.noToolsPaths,
      commandReadGuard: overrides.commandReadGuard,
      systemReadPaths: overrides.systemReadPaths,
    },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "workspaceRegistry") return registry;
      if (name === "fs") return fsSvc;
      if (name === "directoryPicker") return picker;
      if (name === "tools") return tools;
      return undefined;
    },
  };
  await apply(ctx, ctx.config);
  return { root, registry, fsSvc, pickerCap, calls, created, guardFns };
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

test("denyPaths 排除（精确 + 通配），优先级高于 allowedRoots", async () => {
  const { registry, created } = await makeCtx({
    allowedRoots: ["/workspace/algorithm"],
    denyPaths: [
      "/workspace/algorithm/cambricon-work/cnagent-skill3",
      "/workspace/algorithm/cambricon-work/cnagent-skill*",
    ],
  });
  await registry.create("/workspace/algorithm/hermes-work", "h");
  assert.equal(created.length, 1);
  await assert.rejects(
    () => registry.create("/workspace/algorithm/cambricon-work/cnagent-skill3", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  await assert.rejects(
    () => registry.create("/workspace/algorithm/cambricon-work/cnagent-skill8", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  await registry.create("/workspace/algorithm/cambricon-work/cnagent-show", "show");
  assert.equal(created.length, 2);
});

test("isolateRoots 下目录可注册（豁免全局 denyPaths）", async () => {
  const { registry, created } = await makeCtx({
    allowedRoots: ["/workspace/algorithm"],
    denyPaths: ["/workspace/algorithm/cambricon-work/*"],
    isolateRoots: ["/workspace/algorithm/cambricon-work/dsh-cc"],
  });
  await registry.create("/workspace/algorithm/cambricon-work/dsh-cc/dsh-proj-a", "dsh-proj-a");
  assert.equal(created.length, 1);
  // 非隔离的 cambricon-work 目录仍拒绝
  await assert.rejects(
    () => registry.create("/workspace/algorithm/cambricon-work/other-proj", "x"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
});

test("fs 严格 per-session：cwd 在 workspace 内只能读自己", async () => {
  const { fsSvc, root, registry } = await makeCtx({ denyFsReads: true });
  await registry.create(path.join(root, "proj-a"), "a");
  await registry.create(path.join(root, "proj-b"), "b");
  // cwd 在 proj-a → 读 proj-a 内放行
  await fsSvc.readText(path.join(root, "proj-a", "x.txt"), { cwd: path.join(root, "proj-a") });
  // cwd 在 proj-a → 读 proj-b 拒绝（兄弟项目）
  await assert.rejects(
    () => fsSvc.readText(path.join(root, "proj-b", "x.txt"), { cwd: path.join(root, "proj-a") }),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  // cwd 在 proj-b → 读 proj-b 放行
  await fsSvc.readText(path.join(root, "proj-b", "y.txt"), { cwd: path.join(root, "proj-b") });
});

test("fs 无 cwd（非 workspace 会话）走全局规则", async () => {
  const { fsSvc, root } = await makeCtx({ denyFsReads: true });
  await fsSvc.readText(path.join(root, "any.txt")); // 白名单内放行
  await assert.rejects(
    () => fsSvc.readText("/etc/passwd"),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
});

test("前端目录浏览过滤：未注册目录拒绝、隔离 workspace 自己放行", async () => {
  const ROOT = "/workspace/algorithm";
  const { pickerCap, registry, calls } = await makeCtx({
    root: ROOT,
    denyPaths: [`${ROOT}/cambricon-work/*`],
    isolateRoots: [`${ROOT}/cambricon-work/dsh-cc`],
  });
  await registry.create(`${ROOT}/cambricon-work/dsh-cc/dsh-proj-a`, "a");
  // 浏览隔离 workspace 自己 → 放行
  await pickerCap.list(`${ROOT}/cambricon-work/dsh-cc/dsh-proj-a`);
  assert.equal(calls.picker.length, 1);
  // 浏览 cambricon-work 未注册目录 → 拒绝
  await assert.rejects(
    () => pickerCap.list(`${ROOT}/cambricon-work/cnagent-skill3`),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
  // 白名单内非 deny 区域 → 放行
  await pickerCap.list(ROOT);
  assert.equal(calls.picker.length, 2);
});

test("隔离根自身可浏览（容器目录），根下非 workspace 目录仍拒绝", async () => {
  const ROOT = "/workspace/algorithm";
  const { pickerCap, registry, calls } = await makeCtx({
    root: ROOT,
    denyPaths: [`${ROOT}/cambricon-work/*`],
    isolateRoots: [`${ROOT}/cambricon-work/dsh-cc`],
  });
  await registry.create(`${ROOT}/cambricon-work/dsh-cc/dsh-proj-a`, "a");
  // 隔离根自身（cambricon-work/* 命中但豁免）→ 放行
  await pickerCap.list(`${ROOT}/cambricon-work/dsh-cc`);
  assert.equal(calls.picker.length, 1);
  // 隔离根下非 workspace 的目录 → 拒绝
  await assert.rejects(
    () => pickerCap.list(`${ROOT}/cambricon-work/dsh-cc/other-dir`),
    (err) => err.code === "WORKSPACE_ALLOWLIST_DENIED"
  );
});

test("commandReadGuard：工具可用但读不了其他项目/拒绝区（bash 命令路径解析）", async () => {
  const ROOT = "/workspace/algorithm";
  const { guardFns, registry } = await makeCtx({
    root: ROOT,
    denyPaths: [`${ROOT}/cambricon-work/*`],
    isolateRoots: [`${ROOT}/cambricon-work/dsh-cc`],
    commandReadGuard: true,
  });
  await registry.create(`${ROOT}/cambricon-work/dsh-cc/dsh-mini`, "mini");
  await registry.create(`${ROOT}/cambricon-work/dsh-cc/dsh-ptc`, "ptc");
  const guard = guardFns[0];
  const exec = (cwd, name, args) => ({ name, arguments: args, agent: { session: { header: { cwd } } } });
  const mini = `${ROOT}/cambricon-work/dsh-cc/dsh-mini`;
  const ptc = `${ROOT}/cambricon-work/dsh-cc/dsh-ptc`;
  // 工具本身可用：bash 在自己目录内操作 → 放行
  assert.equal(guard(exec(mini, "bash", { command: `ls ${mini}` })), undefined);
  assert.equal(guard(exec(mini, "bash", { command: "pwd && echo hi" })), undefined);
  // 系统路径白名单 → 放行
  assert.equal(guard(exec(mini, "bash", { command: "ls /tmp && head /etc/hostname" })), undefined);
  // 读其他项目 → 拒绝
  const denied = guard(exec(mini, "bash", { command: `cat ${ptc}/secret.txt` }));
  assert.ok(typeof denied === "string" && denied.includes("访问被拒绝"));
  // code_run 含拒绝区路径 → 拒绝
  const denied2 = guard(exec(mini, "code_run", { code: `open("${ptc}/x.py")` }));
  assert.ok(typeof denied2 === "string");
  // 非命令工具带 path 字段 → 拒绝
  const denied3 = guard(exec(mini, "fs_read", { path: `${ptc}/x.py` }));
  assert.ok(typeof denied3 === "string");
  // 白名单区（allowedRoots 非 deny）→ 放行
  assert.equal(guard(exec(mini, "bash", { command: `ls ${ROOT}/hermes-work` })), undefined);
  // 非 workspace 会话（cwd 不在任何 workspace）：全局 denyPaths 生效
  const denied4 = guard(exec(`${ROOT}/hermes-work`, "bash", { command: `cat ${ptc}/x` }));
  assert.ok(typeof denied4 === "string");
});

test("noToolsPaths：cwd 命中拒绝所有工具（code_run/bash 等），未命中放行", async () => {
  const { guardFns } = await makeCtx({
    noToolsPaths: ["/workspace/algorithm/cambricon-work/dsh-cc/dsh-ptc-pro"],
  });
  assert.equal(guardFns.length, 1);
  const guard = guardFns[0];
  const exec = (cwd, name) => ({ name, arguments: {}, agent: { session: { header: { cwd } } } });
  // 命中 → 拒绝字符串（guard 返回非 undefined = 拒绝）
  const denied = guard(exec("/workspace/algorithm/cambricon-work/dsh-cc/dsh-ptc-pro", "bash"));
  assert.ok(typeof denied === "string" && denied.includes("已禁用所有工具"));
  const denied2 = guard(exec("/workspace/algorithm/cambricon-work/dsh-cc/dsh-ptc-pro/sub", "code_run"));
  assert.ok(typeof denied2 === "string");
  // 未命中 → undefined（放行）
  assert.equal(guard(exec("/workspace/algorithm/cambricon-work/dsh-cc/dsh-ptc", "bash")), undefined);
  assert.equal(guard(exec("/workspace/algorithm/hermes-work", "code_run")), undefined);
});

test("noToolsPaths 支持尾部通配", async () => {
  const { guardFns } = await makeCtx({ noToolsPaths: ["/workspace/algorithm/cambricon-work/dsh-cc/dsh-ptc*"] });
  const guard = guardFns[0];
  const exec = (cwd) => ({ name: "bash", arguments: {}, agent: { session: { header: { cwd } } } });
  assert.ok(typeof guard(exec("/workspace/algorithm/cambricon-work/dsh-cc/dsh-ptc2")) === "string");
  assert.equal(guard(exec("/workspace/algorithm/cambricon-work/dsh-cc/dsh-mini")), undefined);
});

test("denyFsReads=false 时不包装 fs（仅注册白名单）", async () => {
  const { fsSvc } = await makeCtx({ denyFsReads: false });
  // 白名单外路径不被拦截（fs 层未包装）
  await fsSvc.readText("/root/secret");
});

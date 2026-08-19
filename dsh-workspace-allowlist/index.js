/**
 * dsh-workspace-allowlist — web/交互面「按项目文件夹」的可见性控制。
 *
 * 两层控制（config 开关）：
 *  1. workspace 注册白名单（默认开）：web 文件浏览 = workspace 注册表，
 *     只显示已注册的项目目录。本插件拦截 workspaceRegistry.create，
 *     目录不在 allowedRoots 内一律拒绝 → 未允许的项目在界面上不可见。
 *  2. fs 路径过滤（默认关，denyFsReads: true 开启）：包装 fs 服务的
 *     resolve/stat/readText/listDir 等读写入口，路径不在 allowedRoots
 *     内直接抛 WORKSPACE_ALLOWLIST_DENIED → 硬性不可读。
 *
 * 挂载：web profile（web-app bundle 提供 workspaceRegistry 服务；
 * 家级/headless 无此服务，inject 硬依赖会激活失败，不要挂家级）。
 *
 * @module dsh-workspace-allowlist
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

export const name = "dsh-workspace-allowlist";
export const inject = ["workspaceRegistry", "fs"];

/** fs 服务的读写入口方法（LocalFileSystem 面）。 */
const FS_METHODS = [
  "resolve", "stat", "lstat",
  "readText", "readBytes", "listDir", "streamText",
  "writeText", "editText",
];

export function apply(ctx, config) {
  const cfg = config ?? {};
  const allowedRoots = (cfg.allowedRoots ?? ["/workspace/algorithm"])
    .map((p) => path.resolve(String(p)));
  const denyFsReads = Boolean(cfg.denyFsReads);

  const info = (msg) => ctx.logger?.info?.(`[dsh-workspace-allowlist] ${msg}`);
  const warn = (msg) => ctx.logger?.warn?.(`[dsh-workspace-allowlist] ${msg}`);

  /** Canonicalize（realpath 优先，与 workspaceRegistry.create 一致）。 */
  async function canonical(target) {
    try {
      return await realpath(String(target));
    } catch {
      return path.resolve(String(target));
    }
  }

  async function isAllowed(target) {
    const canon = await canonical(target);
    return allowedRoots.some((root) =>
      canon === root || canon.startsWith(root + path.sep)
    );
  }

  function deny(target, op) {
    const err = new Error(
      `[dsh-workspace-allowlist] ${op} 被拒绝：${target}（允许的项目根: ${allowedRoots.join(", ")}）`
    );
    err.code = "WORKSPACE_ALLOWLIST_DENIED";
    return err;
  }

  // ── 层 1：workspace 注册白名单（web 文件浏览的可见性入口）──
  const registry = ctx.get("workspaceRegistry");
  if (registry?.create) {
    const origCreate = registry.create.bind(registry);
    registry.create = async (target, title) => {
      if (!(await isAllowed(target))) throw deny(target, "workspace 注册");
      return origCreate(target, title);
    };
    info(`workspace 注册白名单生效: ${allowedRoots.join(", ")}`);
  } else {
    warn("workspaceRegistry.create 不可用，注册白名单未生效");
  }

  // ── 层 2（可选）：fs 读写路径过滤 ──
  if (denyFsReads) {
    const fsSvc = ctx.get("fs");
    if (fsSvc) {
      for (const method of FS_METHODS) {
        if (typeof fsSvc[method] !== "function") continue;
        const orig = fsSvc[method].bind(fsSvc);
        fsSvc[method] = async (target, ...rest) => {
          if (typeof target === "string" && !(await isAllowed(target))) {
            throw deny(target, `fs.${method}`);
          }
          return orig(target, ...rest);
        };
      }
      info("fs 读写路径过滤生效（硬隔离）");
    } else {
      warn("fs 服务不可用，路径过滤未生效");
    }
  } else {
    info("fs 过滤未启用（denyFsReads=false），仅限制 workspace 注册");
  }
}

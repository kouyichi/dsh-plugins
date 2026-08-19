/**
 * dsh-workspace-allowlist — web/交互面「按项目文件夹」的可见性控制。
 *
 * 三层控制：
 *  1. workspace 注册白名单（默认开）：web 文件浏览 = workspace 注册表，
 *     只显示已注册的项目目录。拦截 workspaceRegistry.create，
 *     目录不在 allowedRoots 内、或在 denyPaths 内（isolateRoots 下除外）
 *     一律拒绝 → 未允许的项目在界面上不可见。
 *  2. agent 工具读隔离（fs.resolve 包装，denyFsReads: true 开启，严格 per-session）：
 *     当前会话 cwd 落在某个已注册 workspace 内 → 目标路径必须在该
 *     workspace.path 内（"除了自己之外的所有文件"精确达成，含兄弟项目）；
 *     cwd 不在任何 workspace 内 → 按全局规则（allowedRoots − denyPaths）。
 *  3. 前端目录浏览（directoryPicker.list 包装）：目标必须在某个已注册
 *     workspace.path 内，或 allowedRoots 且不在 denyPaths 内——未注册的
 *     目录（如 cambricon-work 下其他项目）在 web 文件树里不可浏览。
 *     （RPC 无会话上下文，无法按"浏览者"区分，这是该层能做到的最严。）
 *
 * 配置：
 *   allowedRoots: string[]  允许的项目根（realpath 比较，子目录继承）
 *   denyPaths:    string[]  排除列表（优先级高于 allowedRoots；尾部 `*`
 *                           通配；isolateRoots 下的注册路径除外）
 *   isolateRoots: string[]  隔离根：其下的目录可注册为 workspace，且每个
 *                           workspace 只能访问自己的 path 子树
 *   denyFsReads:  boolean   是否开启 fs 工具读隔离（建议 true）
 *
 * 挂载：web profile（web-app bundle 提供 workspaceRegistry/directoryPicker
 * 服务；家级/headless 无此服务，inject 硬依赖会激活失败，不要挂家级）。
 *
 * @module dsh-workspace-allowlist
 */

import { realpath } from "node:fs/promises";
import path from "node:path";

export const name = "dsh-workspace-allowlist";
export const inject = ["workspaceRegistry", "fs", "directoryPicker"];

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
  const isolateRoots = (cfg.isolateRoots ?? [])
    .map((p) => path.resolve(String(p)));
  // 排除列表：尾部 `*` 视为通配（匹配任意字符），其余为前缀/等值匹配
  const denyPatterns = (cfg.denyPaths ?? []).map((p) => {
    const s = String(p);
    if (s.endsWith("*")) {
      const prefix = s.slice(0, -1);
      return { type: "glob", regex: new RegExp(
        "^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$"
      ) };
    }
    return { type: "prefix", value: path.resolve(s) };
  });

  const info = (msg) => ctx.logger?.info?.(`[dsh-workspace-allowlist] ${msg}`);
  const warn = (msg) => ctx.logger?.warn?.(`[dsh-workspace-allowlist] ${msg}`);

  async function canonical(target) {
    try {
      return await realpath(String(target));
    } catch {
      return path.resolve(String(target));
    }
  }

  function isDenied(canon) {
    return denyPatterns.some((d) =>
      d.type === "glob" ? d.regex.test(canon) : canon === d.value || canon.startsWith(d.value + path.sep)
    );
  }

  function underRoot(canon, root) {
    return canon === root || canon.startsWith(root + path.sep);
  }

  function underAny(canon, roots) {
    return roots.some((r) => underRoot(canon, r));
  }

  /** 已注册 workspace 的 path 列表（同步，registry.list() 无持久化读）。 */
  function registeredPaths() {
    try {
      return ctx.get("workspaceRegistry")?.list?.()?.map((w) => w.path).filter(Boolean) ?? [];
    } catch {
      return [];
    }
  }

  /** 隔离 workspace 的 path 集合（isolateRoots 下的注册路径）。 */
  function isolatedPaths() {
    return registeredPaths().filter((p) => underAny(p, isolateRoots));
  }

  /** 全局规则（白名单 − 排除），isolateRoots 下的注册路径豁免 deny。 */
  async function globalAllowed(target) {
    const canon = await canonical(target);
    if (!underAny(canon, allowedRoots)) return false;
    if (isDenied(canon)) {
      // 豁免：隔离根下已注册的 workspace 自己的路径
      if (isolatedPaths().some((p) => underRoot(canon, p))) return true;
      return false;
    }
    return true;
  }

  async function deny(target, op) {
    const err = new Error(
      `[dsh-workspace-allowlist] ${op} 被拒绝：${target}（允许的项目根: ${allowedRoots.join(", ")}）`
    );
    err.code = "WORKSPACE_ALLOWLIST_DENIED";
    return err;
  }

  // ── 层 1：workspace 注册白名单 ──
  const registry = ctx.get("workspaceRegistry");
  if (registry?.create) {
    const origCreate = registry.create.bind(registry);
    registry.create = async (target, title) => {
      const canon = await canonical(target);
      // 隔离根下：允许注册（并强制每个项目独立注册）
      if (underAny(canon, isolateRoots)) return origCreate(target, title);
      if (!underAny(canon, allowedRoots) || isDenied(canon)) {
        throw await deny(target, "workspace 注册");
      }
      return origCreate(target, title);
    };
    info(`workspace 注册白名单生效: ${allowedRoots.join(", ")}；隔离根: ${isolateRoots.join(", ")}`);
  } else {
    warn("workspaceRegistry.create 不可用，注册白名单未生效");
  }

  // ── 层 2：agent 工具读隔离（fs）──
  if (denyFsReads) {
    const fsSvc = ctx.get("fs");
    if (fsSvc) {
      for (const method of FS_METHODS) {
        if (typeof fsSvc[method] !== "function") continue;
        const orig = fsSvc[method].bind(fsSvc);
        fsSvc[method] = async (target, ...rest) => {
          if (typeof target === "string") {
            const opts = rest[0];
            const canon = await canonical(target);
            // 严格 per-session：cwd 在某 workspace 内 → 只能读自己
            const cwd = typeof opts?.cwd === "string" ? await canonical(opts.cwd) : undefined;
            if (cwd) {
              const own = registeredPaths().find((p) => underRoot(cwd, p));
              if (own) {
                if (!underRoot(canon, own)) throw await deny(target, `fs.${method}（工作区隔离：只能访问 ${own}）`);
                return orig(target, ...rest);
              }
            }
            // 全局规则
            if (!(await globalAllowed(target))) throw await deny(target, `fs.${method}`);
          }
          return orig(target, ...rest);
        };
      }
      info("fs 读写路径过滤生效（per-workspace 严格隔离）");
    } else {
      warn("fs 服务不可用，路径过滤未生效");
    }
  }

  // ── 层 3：前端目录浏览（directoryPicker）──
  const picker = ctx.get("directoryPicker");
  if (picker?.capability) {
    const cap = picker.capability();
    const origList = cap.list?.bind(cap);
    if (origList) {
      cap.list = async (target, signal) => {
        if (typeof target === "string" && !(await globalAllowed(target))) {
          throw await deny(target, "目录浏览");
        }
        return origList(target, signal);
      };
      info("前端目录浏览过滤生效（已注册 workspace + 白名单）");
    }
  } else {
    warn("directoryPicker 不可用，前端浏览过滤未生效");
  }
}

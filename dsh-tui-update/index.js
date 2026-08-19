/**
 * dsh-tui-update — TUI brick: /update.
 *
 * Full update flow (competitor semantics from ccch1mneyyy/dsh-TUI, adapted
 * to the local kouyichi/dsh-tui-app stack):
 *
 *   1. CHECK   — npm view @deepseek-ai/dsh + dsh-tui-app in parallel, compare
 *                against the installed versions (semver-ish compare).
 *   2. NOTIFY  — a status-bar field shows "⬆dsh <ver>" whenever a newer dsh
 *                is available; /update prints the full plan (versions +
 *                exact commands to run).
 *   3. CONFIRM — two-step typed confirmation: the first /update only arms
 *                the upgrade; a second /update re-checks (≤60s cache) and
 *                executes. No generic confirm panel exists on ctl, so this
 *                is the built-in safety gate.
 *   4. UPGRADE — execFile (piped, timeout-protected, output tail relayed):
 *                `npm install -g @deepseek-ai/dsh` (only when the CLI is
 *                outdated) + `corepack pnpm install` in the profile dir.
 *                Any failure prints a Chinese error + manual fallback
 *                commands; the session is untouched and no restart happens.
 *                Post-upgrade version verification before restarting.
 *   5. RESTART — spawn a detached helper (node -e) that waits ~1.2s (so the
 *                old process fully exits and restores the terminal first),
 *                then spawns `dsh --profile <name> --resume <sessionId>`
 *                with stdio inherited. The old TUI exits itself via
 *                ctl.exit(); the resume id comes from store.meta.sessionId.
 *                We never kill any other process — only ourselves.
 *
 * Safety rules: every destructive step requires the second /update; the
 * full command line (incl. restart target + PIDs) is printed before
 * anything runs; on any failure a manual downgrade/upgrade path is shown.
 *
 * @module dsh-tui-update
 */

import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-tui-update";
export const inject = ["tuiExtensions"];

/** Delay (ms) the restart helper waits before starting the new TUI. */
const RESTART_DELAY_MS = Number(process.env.DSH_TUI_UPDATE_DELAY || 1200);
const CHECK_TTL_MS = 60_000; // re-check window for the confirm step
const STEP_TIMEOUT_MS = 240_000; // npm install / pnpm install

/** Tiny restart helper: waits, then spawns the TUI detached (survives us). */
const WRAPPER_SRC = [
  "const{spawn}=require('node:child_process');",
  "const cmd=process.argv[1];const args=process.argv.slice(2);",
  "const delay=Number(process.env.DSH_TUI_UPDATE_DELAY||1200);",
  "setTimeout(()=>{",
  "  try{",
  "    const c=spawn(cmd,args,{stdio:'inherit',detached:true});",
  "    c.unref();",
  "    c.on('error',e=>{try{process.stderr.write('\\ndsh-tui-update: 重启失败: '+e.message+'\\n')}catch{}});",
  "  }catch(e){",
  "    try{process.stderr.write('\\ndsh-tui-update: 重启失败: '+e.message+'\\n')}catch{}",
  "  }",
  "},delay);",
  "setTimeout(()=>process.exit(0),30000).unref();",
].join("");

// ---- module state (per TUI process) --------------------------------

/** Latest check result: { ok, dshErr, appErr, dsh, app, checkedAt }. */
let latestInfo = null;
/** True after the first /update announced a newer version (needs confirm). */
let armed = false;
/** True while upgrade steps run (re-entry guard). */
let upgrading = false;
/** P-08: 最近一次可用的 store（检查完成后触发 store.set 刷新状态栏用）。 */
let lastStore = null;
/** P-08: 后台检查已完成但尚无 store 可触发刷新时的挂起标记。 */
let pendingStatusRefresh = false;

/**
 * P-08: 有可用 store 时补一次静默刷新（无 notice），让状态栏 ⬆ 及时出现。
 * 接缝里 render 只收到状态快照拿不到 store，ctl/store 仅在 handler 与
 * 输入钩子（onDoubleEsc/onAltUp 带 {ctl, store}）可用，故在捕获点补刷。
 */
function pokeStatusRefresh() {
  if (!pendingStatusRefresh) return;
  pendingStatusRefresh = false;
  if (!lastStore) return;
  try { lastStore.set({}); } catch { /* ignore */ }
}

// ---- version helpers -------------------------------------------------

/** Resolve the installed @deepseek-ai/dsh version (argv[1] walk-up → CLI probe). */
function installedVersion() {
  try {
    const entry = resolve(process.argv[1] || "");
    let dir = dirname(entry);
    for (let i = 0; i < 8; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg)) {
        const j = JSON.parse(readFileSync(pkg, "utf8"));
        if (j.name === "@deepseek-ai/dsh" || j.name === "dsh") return j.version;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* fall through */ }
  try {
    const out = execFileSync("dsh", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    if (out) return out;
  } catch { /* fall through */ }
  return process.env.DSH_VERSION || "unknown";
}

/** Resolve the profile name this TUI was booted with (launcher argv). */
function resolveProfileName() {
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--profile" && process.argv[i + 1] && !process.argv[i + 1].startsWith("-")) {
      return process.argv[i + 1];
    }
    if (a.startsWith("--profile=") && a.length > "--profile=".length) {
      return a.slice("--profile=".length);
    }
  }
  return "tui";
}

/** $DSH_HOME/profiles/<name> (DSH_HOME defaults to ~/.dsh). */
function resolveProfileDir(profile = resolveProfileName()) {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles", profile);
}

/** Installed dsh-tui-app version from the profile (node_modules → plugins). */
function installedAppVersion() {
  const dir = resolveProfileDir(); // G222: resolveProfileDir 恒返回字符串，原 !dir 判断是死代码，已删
  for (const p of [
    join(dir, "node_modules", "dsh-tui-app", "package.json"),
    join(dir, "plugins", "dsh-tui-app", "package.json"),
  ]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j?.name === "dsh-tui-app" && typeof j.version === "string" && j.version) return j.version;
    } catch { /* try next layout */ }
  }
  return null;
}

/** True when the profile pins dsh-tui-app as a local file: dependency. */
function appIsFileDep() {
  try {
    const j = JSON.parse(readFileSync(join(resolveProfileDir(), "package.json"), "utf8"));
    const dep = j?.dependencies?.["dsh-tui-app"];
    return typeof dep === "string" && dep.startsWith("file:");
  } catch {
    return false;
  }
}

/** Minimal semver-ish compare (x.y.z[-pre]); zero-dep brick, no semver pkg. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : null };
  };
  const A = parse(a);
  const B = parse(b);
  // G221: 任一侧无法解析时返回 null 表示「不可比」——绝不回退 localeCompare
  // 字符串序（会把非 semver 版本误判成有新版/已最新）。调用方按 null 处理。
  if (!A || !B) return null;
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  if (A.patch !== B.patch) return A.patch - B.patch;
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1; // release > prerelease
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d) return d;
    } else if (xn) return -1; // numeric identifiers sort below alphanumeric
    else if (yn) return 1;
    else {
      const d = x.localeCompare(y);
      if (d) return d;
    }
  }
  return 0;
}

// ---- npm / execution helpers ------------------------------------------

function npmView(pkg, fields, cb) {
  execFile("npm", ["view", pkg, ...fields, "--json"], { timeout: 20000 }, (err, stdout) => {
    if (err) { cb(null); return; }
    try { cb(JSON.parse(stdout.trim())); } catch { cb(null); }
  });
}

/** S-20: 拉取完整元数据（version/repository/description）用于包真实性校验。 */
function npmViewMeta(pkg, cb) {
  execFile("npm", ["view", pkg, "--json"], { timeout: 20000 }, (err, stdout) => {
    if (err) { cb(null); return; }
    try { cb(JSON.parse(stdout.trim())); } catch { cb(null); }
  });
}

/** S-20: npm 同名包是否为官方 dsh-tui-app（repository/description 匹配官方仓库）。 */
function isOfficialApp(meta) {
  const repo = typeof meta?.repository === "string" ? meta.repository : meta?.repository?.url || "";
  if (/kouyichi\/dsh-tui-app/i.test(repo)) return true;
  const desc = String(meta?.description || "");
  return /kouyichi/i.test(desc) && /dsh-tui-app/i.test(desc);
}

/** 检查序号（G223）：每次 checkAll 递增，仅最新一次检查允许写回结果。 */
let checkSeq = 0;

/** Parallel npm check of both packages; cb(res) with per-package errors. */
function checkAll(cb) {
  const seq = ++checkSeq; // G223: 本次检查的序号（并发保护）
  let dsh = null;
  let app = null;
  let dshErr = false;
  let appErr = false;
  let pending = 2;
  const done = () => {
    if (--pending !== 0) return;
    // G223: 已有更新鲜的检查启动（如用户 /update 压过后台定时检查）——
    // 本结果已过期，丢弃，避免慢结果覆盖新结果。
    if (seq !== checkSeq) return;
    cb({ ok: !dshErr && !appErr, dshErr, appErr, dsh, app, checkedAt: Date.now() });
  };
  npmView("@deepseek-ai/dsh", ["version"], (latest) => {
    const local = installedVersion();
    if (latest == null) { dshErr = true; dsh = { local, latest: null, cmp: null, newer: false, incomparable: false }; }
    else {
      // G221: cmp 为 null = 不可比（版本格式无法解析），newer 恒 false。
      const cmp = local === "unknown" ? null : compareVersions(latest, local);
      dsh = { local, latest, cmp, newer: cmp === 1, incomparable: cmp == null };
    }
    done();
  });
  npmViewMeta("dsh-tui-app", (meta) => {
    const local = installedAppVersion();
    const latest = meta?.version ?? null;
    if (meta == null || latest == null) {
      appErr = true;
      app = { local, latest: null, cmp: null, newer: false, incomparable: false, unverified: false };
      done();
      return;
    }
    // S-20: 先验证 npm 同名包是官方版才比较；否则标记 unverified，
    // 展示「无法确认官方版本」且不参与 newer/升级判定（避免 0.0.1 同名包误导）。
    if (!isOfficialApp(meta)) {
      app = { local, latest, cmp: null, newer: false, incomparable: false, unverified: true };
      done();
      return;
    }
    const cmp = local == null ? null : compareVersions(latest, local);
    app = { local, latest, cmp, newer: cmp === 1, incomparable: cmp == null, unverified: false };
    done();
  });
}

/** Last n lines of a string, capped for TUI notice display. */
function tailLines(text, n) {
  const lines = String(text || "").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "";
  const out = lines.slice(-n);
  let total = out.join("\n").length;
  while (total > 900 && out.length > 1) { out.shift(); total = out.join("\n").length; }
  return out.join("\n");
}

/** Run one upgrade step with timeout + output capture; cb({ok, msg}). */
function runStep(step, ctl) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    execFile(
      step.cmd,
      step.args,
      { cwd: step.cwd ?? undefined, timeout: step.timeout ?? STEP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          const tail = tailLines(stdout || "", 4);
          ctl.notice("info", `✓ ${step.label} 完成（${((Date.now() - t0) / 1000).toFixed(1)}s）${tail ? "\n" + tail : ""}`);
          resolvePromise({ ok: true });
          return;
        }
        // G220: 输出超缓冲不是升级失败——单独提示手动升级，避免误报。
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolvePromise({ ok: false, msg: "输出过大（超过 32MB 缓冲），无法在 TUI 内完成，请手动执行升级命令" });
          return;
        }
        const tail = tailLines(String(stderr || "").trim() || String(stdout || ""), 10);
        const why = err.killed ? "超时被终止" : `退出码 ${err.code ?? err.signal ?? "?"}`;
        resolvePromise({ ok: false, msg: `${why}${tail ? "\n" + tail : ""}` });
      }
    );
  });
}

/** Build the restart launch line: PATH shim first, node+old-bin fallback. */
function buildLaunch(profile, sessionId) {
  const base = (process.argv.slice(2) || []).filter(Boolean);
  const hasProfile = base.some(
    (a, i) => (a === "--profile" && typeof base[i + 1] === "string") || a.startsWith("--profile=")
  );
  const args = hasProfile ? [...base] : ["--profile", profile, ...base];
  if (sessionId) args.push("--resume", sessionId);
  try {
    const shim = execFileSync("sh", ["-c", "command -v dsh"], { encoding: "utf8", timeout: 5000 }).trim();
    if (shim && !shim.includes("\n") && existsSync(shim)) {
      try { accessSync(shim, constants.X_OK); return { cmd: shim, args }; } catch { /* fall through */ }
    }
  } catch { /* fall through */ }
  if (process.argv[1]) return { cmd: process.execPath, args: [process.argv[1], ...args] };
  return { cmd: "dsh", args };
}

/** Spawn the detached restart helper, print plan/PIDs, then exit ourselves. */
function restartTui(ctl, store, profile, launch) {
  const sessionId = store?.meta?.sessionId;
  const fresh = !store?.meta?.resumed && (store?.stats?.turns ?? 0) === 0;
  const resumeLine = sessionId ? `恢复会话: --resume ${sessionId}` : "无会话可恢复（将启动新会话）";
  ctl.notice(
    "info",
    `升级完成，即将重启 TUI（本进程 pid ${process.pid} 退出；不影响其它 TUI 进程）:\n` +
      `  ${launch.cmd} ${launch.args.join(" ")}\n${resumeLine}` +
      (fresh ? "\n注意: 当前会话尚无对话记录，重启后可能无法 --resume 恢复（将启动新会话）" : "")
  );
  const child = spawn(process.execPath, ["-e", WRAPPER_SRC, launch.cmd, ...launch.args], {
    detached: true,
    stdio: "inherit",
  });
  child.unref();
  ctl.notice(
    "info",
    `新 TUI 进程已启动 (pid ${child.pid ?? "?"}，约 ${(RESTART_DELAY_MS / 1000).toFixed(1)} 秒后接管终端)，本进程即将退出。` +
      (sessionId ? `\n如未自动恢复，可手动执行: dsh --profile ${profile} --resume ${sessionId}` : "")
  );
  // Let Ink flush the notices, then leave. The restart helper waits longer
  // than this, so the new TUI always initializes on a restored terminal.
  setTimeout(() => { try { ctl.exit(); } catch { /* ignore */ } }, 300);
}

/** The confirmed upgrade: steps → verify → restart. Never throws. */
async function execUpgrade(ctl, store, res) {
  if (upgrading) return;
  if (store?.input?.busy) {
    armed = true; // keep the confirm so the next /update executes
    ctl.notice("warning", "agent 正忙：升级会中断当前回合。请等回合结束后再次输入 /update 执行（确认状态已保留）");
    return;
  }
  upgrading = true;
  const abort = (msg) => { ctl.notice("error", msg); upgrading = false; armed = false; };
  const sessionId = store?.meta?.sessionId;
  const profile = resolveProfileName();
  const profileDir = resolveProfileDir(profile);

  const steps = [];
  if (res.dsh?.newer) {
    steps.push({ label: "升级 dsh CLI（npm 全局）", cmd: "npm", args: ["install", "-g", "@deepseek-ai/dsh"], cwd: null, manual: "npm install -g @deepseek-ai/dsh" });
  }
  if (res.app?.newer && !appIsFileDep()) {
    // G219: 非 file: 依赖时 `pnpm install` 按 lockfile 不升版本（验证必然失败），
    // 改为显式 `pnpm add dsh-tui-app@<latest>` 升级（同时更新 package.json 与 lockfile）。
    steps.push({
      label: "升级 TUI profile 的 dsh-tui-app",
      cmd: "corepack",
      args: ["pnpm", "add", `dsh-tui-app@${res.app.latest}`],
      cwd: profileDir,
      manual: `cd ${profileDir} && corepack pnpm add dsh-tui-app@${res.app.latest}`,
    });
  } else {
    steps.push({ label: "刷新 TUI profile 依赖", cmd: "corepack", args: ["pnpm", "install"], cwd: profileDir, manual: `cd ${profileDir} && corepack pnpm install` });
  }

  ctl.notice(
    "info",
    "确认收到，开始升级:\n" +
      steps.map((s) => `  ${s.cmd} ${s.args.join(" ")}${s.cwd ? `（cwd: ${s.cwd}）` : ""}`).join("\n") +
      "\n完成后自动重启 TUI 并恢复当前会话"
  );

  for (const s of steps) {
    const r = await runStep(s, ctl);
    if (!r.ok) {
      abort(
        `${s.label} 失败${r.msg ? "：" + r.msg : ""}\n你的会话未受影响。可手动升级:\n  ${s.manual}\n` +
          (sessionId ? `完成后重启: dsh --profile ${profile} --resume ${sessionId}` : `完成后重启: dsh --profile ${profile}`)
      );
      return;
    }
  }

  // Post-upgrade verification — never restart into a version that did not move.
  if (res.dsh?.newer) {
    const now = installedVersion();
    if (now !== "unknown" && compareVersions(now, res.dsh.local) <= 0) {
      abort(
        `升级验证失败: dsh 仍为 ${now}（预期 ${res.dsh.latest}）。可能是镜像 registry 未同步，请稍后手动执行:\n` +
          `  npm install -g @deepseek-ai/dsh@${res.dsh.latest}\n然后: dsh --profile ${profile} --resume ${sessionId || ""}`
      );
      return;
    }
  }
  if (res.app?.newer && !appIsFileDep()) {
    const now = installedAppVersion();
    if (now != null && compareVersions(now, res.app.local) <= 0) {
      abort(
        `tui-app 升级验证失败: 仍为 ${now}（预期 ${res.app.latest}）。请手动执行:\n` +
          `  cd ${profileDir} && corepack pnpm add dsh-tui-app@${res.app.latest}`
      );
      return;
    }
  }

  upgrading = false;
  armed = false;
  restartTui(ctl, store, profile, buildLaunch(profile, sessionId));
}

// ---- brick registration ------------------------------------------------

export function apply(ctx) {
  const ext = ctx.get("tuiExtensions");
  if (!ext) {
    ctx.logger.info("[dsh-tui-update] tuiExtensions absent (non-TUI profile) — no-op");
    return;
  }
  const disposers = [];

  disposers.push(ext.registerCommand({
    name: "/update",
    description: "检查并升级 dsh（确认后自动重启恢复会话）",
    busySafe: true,
    handler(full, ctl, store) {
      // P-08: 捕获 store 并补刷挂起的后台检查结果（状态栏 ⬆）。
      lastStore = store;
      pokeStatusRefresh();
      const safe = (fn) => (...a) => {
        try { fn(...a); } catch (e) {
          try { ctl.notice("error", `update 内部错误: ${e.message}`); } catch { /* ignore */ }
        }
      };
      if (upgrading) {
        ctl.notice("warning", "升级进行中，请稍候…（完成后会自动重启）");
        return;
      }
      // ---- confirm step: second /update executes (with fresh re-check) ----
      if (armed) {
        const runConfirm = safe((res) => {
          latestInfo = res;
          armed = false;
          if (!res.ok) {
            ctl.notice("error", "确认时重新检查失败（离线或 registry 不可达），已取消升级。请稍后重试 /update");
            return;
          }
          if (!res.dsh?.newer && !(res.app?.newer && !appIsFileDep())) {
            ctl.notice("info", "已是最新，取消升级确认");
            return;
          }
          void execUpgrade(ctl, store, res);
        });
        if (latestInfo && Date.now() - latestInfo.checkedAt < CHECK_TTL_MS) runConfirm(latestInfo);
        else { ctl.notice("info", "确认升级，重新检查最新版本…"); checkAll(runConfirm); }
        return;
      }
      // ---- check step: report versions + plan, arm the upgrade -----------
      ctl.notice("info", "正在检查 npm…");
      checkAll(safe((res) => {
        latestInfo = res;
        if (res.dshErr && res.appErr) {
          ctl.notice(
            "error",
            "npm 检查失败（离线或 registry 不可达）。可稍后重试 /update，或手动升级:\n" +
              "  npm install -g @deepseek-ai/dsh\n" +
              `  cd ${resolveProfileDir()} && corepack pnpm install`
          );
          return;
        }
        const dshLine = res.dshErr
          ? "  dsh CLI:  版本检查失败"
          : `  dsh CLI:  本地 ${res.dsh.local ?? "?"} → npm ${res.dsh.latest ?? "?"}` +
            (res.dsh.newer ? "（有新版）" : res.dsh.incomparable ? "（版本格式不可解析，无法确认是否有新版）" : "（已最新）");
        const fileDep = appIsFileDep();
        const appLine = res.appErr
          ? "  tui-app:  版本检查失败"
          : res.app?.unverified
            ? `  tui-app:  本地 ${res.app.local ?? "?"} → npm ${res.app.latest ?? "?"}（npm 同名包与官方仓库不符，无法确认官方版本，跳过比较）`
            : `  tui-app:  本地 ${res.app.local ?? "?"} → npm ${res.app.latest ?? "?"}` +
              (res.app.newer ? (fileDep ? "（npm 有新版，但本机为 file: 本地依赖，仅提示）" : "（有新版）") : res.app.incomparable ? "（版本格式不可解析，无法确认是否有新版）" : "（已最新）");
        const actionable = res.dsh?.newer || (res.app?.newer && !fileDep);
        if (!actionable) {
          ctl.notice("info", `当前已是最新:\n${dshLine}\n${appLine}`);
          return;
        }
        armed = true;
        const steps = [];
        if (res.dsh?.newer) steps.push(`  npm install -g @deepseek-ai/dsh`);
        steps.push(`  cd ${resolveProfileDir()} && corepack pnpm install`);
        ctl.notice(
          "info",
          `检测到新版本:\n${dshLine}\n${appLine}\n\n升级计划（再次输入 /update 确认执行）:\n${steps.join("\n")}\n` +
            `升级完成后将自动重启 TUI 并恢复当前会话（--resume ${store?.meta?.sessionId ?? "?"}）`
        );
      }));
    },
  }));

  // Status-bar hint: ⬆dsh <ver> while a newer CLI exists, !待确认 while armed.
  disposers.push(ext.registerStatusField({
    id: "update",
    order: 150,
    render() {
      const parts = [];
      if (latestInfo?.dsh?.newer) parts.push(`⬆dsh ${latestInfo.dsh.latest}`);
      if (latestInfo?.app?.newer) parts.push(`⬆tui ${latestInfo.app.latest}`);
      if (armed) parts.push("!待确认");
      if (upgrading) parts.push("⏳升级中");
      return parts.join(" ");
    },
  }));

  // P-08: 输入钩子顺带捕获 store 并补刷挂起的后台检查结果（无副作用）。
  disposers.push(ext.addInputHook({
    onDoubleEsc: ({ store: s }) => { lastStore = s; pokeStatusRefresh(); },
    onAltUp: ({ store: s }) => { lastStore = s; pokeStatusRefresh(); },
  }));

  // Background startup check: only fills the status bar, never notices.
  const startupTimer = setTimeout(() => {
    try {
      checkAll((res) => {
        latestInfo = res;
        // P-08: 检查完成 → 触发一次 store.set 刷新状态栏（⬆ 即时出现）；
        // 尚无 store（用户尚未交互）则挂起，待首个捕获点补刷。
        if (lastStore) { try { lastStore.set({}); } catch { /* ignore */ } }
        else pendingStatusRefresh = true;
      });
    } catch { /* best effort */ }
  }, 2500);
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

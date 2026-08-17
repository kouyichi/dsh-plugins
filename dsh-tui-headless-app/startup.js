/**
 * dsh-tui-headless-app/startup — tui-headless profile 的命令行 provider。
 *
 * tui 的 headless 形态：一次性任务驱动，但保留 tui 的功能面——模式（--mode）、
 * 模型（--model/--provider/--effort）、目标（--goal）、权限（--permission）、
 * 续会话（--resume）、结构化输出（--json）。
 *
 * 解析 launcher 参数快照（ctx.cmdlineArgs）后发布 TUI_HEADLESS_STARTUP_SERVICE，
 * runner 懒加载消费。帮助/解析错误是终态的：写文本后经 ctx.appExit 退出。
 *
 * @module dsh-tui-headless-app/startup
 */

/** Stable Cordis plugin name. */
export const name = "tui-headless-startup";

/** Services required before the app arguments can be read. */
export const inject = ["cmdlineArgs"];

/** Service provided by this plugin and injected by the one-shot runner. */
export const TUI_HEADLESS_STARTUP_SERVICE = "tuiHeadlessStartup";

/** The app's help text, printed for `-h/--help` and on usage errors. */
export const USAGE = `Usage: dsh --profile tui-headless [options] <task...>

One-shot task with the tui profile's feature set: agent mode presets, model
selection, goals, permission presets, session resume, and JSON output. The
task positional is required; multiple words are joined by spaces.

Options:
  --mode <id>           agent preset: standard | code | minimal | cordis
                        (default: agent-presets default)
  --model <id>          model id, e.g. deepseek-v4-pro (default: current)
  --provider <id>       provider route, e.g. deepseek-official
  --effort <max|low>    reasoning effort for this run
  --goal <objective>    create and arm a goal before the task runs
  --permission <preset> switch permission preset (sandbox + approval)
  --resume <sessionId>  continue an existing session
  --json                print one JSON object: text/sessionId/model/mode/...
  -h, --help            show this help

Examples:
  dsh --profile tui-headless "run the tests"
  dsh --profile tui-headless --mode code --model deepseek-v4-pro "refactor x"
  dsh --profile tui-headless --goal "ship feature X" --json "start working"
  dsh --profile tui-headless --resume session-abc123 "continue from here"
`;

/**
 * Parse the app argument list. Discriminated result:
 * `{ kind: "start", opts }`, `{ kind: "help" }`, or `{ kind: "error", message }`.
 * Repeated scalar flags keep the last value; the task is all remaining words.
 * @param argv - the launcher's frozen argument snapshot.
 */
export function parseArgs(argv) {
  const opts = {
    mode: void 0,
    model: void 0,
    provider: void 0,
    effort: void 0,
    goal: void 0,
    permission: void 0,
    resumeSessionId: void 0,
    json: false,
    task: "",
  };
  const taskWords = [];
  const takesValue = new Set(["--mode", "--model", "--provider", "--effort", "--goal", "--permission", "--resume"]);
  /** --flag -> opts 字段名（--resume 特例映射到 resumeSessionId）。 */
  const flagKey = (flag) => (flag === "--resume" ? "resumeSessionId" : flag.slice(2));
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") return { kind: "help" };
    if (argument === "--json") {
      opts.json = true;
      continue;
    }
    let matched = false;
    for (const flag of takesValue) {
      if (argument === flag) {
        const value = argv[index + 1];
        if (value === void 0 || value.startsWith("-")) {
          return { kind: "error", message: `error: option '${flag} <value>' argument missing` };
        }
        opts[flagKey(flag)] = value;
        index += 1;
        matched = true;
        break;
      }
      if (argument.startsWith(`${flag}=`)) {
        const value = argument.slice(flag.length + 1);
        if (value === "") {
          return { kind: "error", message: `error: option '${flag} <value>' argument missing` };
        }
        opts[flagKey(flag)] = value;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (argument.startsWith("-")) {
      return { kind: "error", message: `error: unknown option '${argument}'` };
    }
    taskWords.push(argument);
  }
  opts.task = taskWords.join(" ");
  if (opts.task.trim() === "") {
    return { kind: "error", message: "error: a task is required, for example: dsh --profile tui-headless \"run the tests\"" };
  }
  if (opts.effort !== void 0 && !["max", "low", "off"].includes(opts.effort)) {
    return { kind: "error", message: `error: --effort must be max | low | off (got '${opts.effort}')` };
  }
  return { kind: "start", opts };
}

/**
 * Parse and provide the one-shot startup facts as an ordinary Cordis service.
 * On help or a usage error nothing is provided and the process exits.
 * @param ctx - plugin context carrying the command line and exit request.
 */
export function apply(ctx) {
  const cmdline = ctx.get("cmdlineArgs");
  const exit = ctx.get("appExit");
  if (cmdline === void 0 || exit === void 0) {
    throw new Error("tui-headless-startup: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts");
  }
  const parsed = parseArgs(cmdline.get());
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    exit(0);
    return;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`dsh: ${parsed.message}\n`);
    process.stderr.write(USAGE);
    exit(1);
    return;
  }
  ctx.provide(TUI_HEADLESS_STARTUP_SERVICE, parsed.opts);
}

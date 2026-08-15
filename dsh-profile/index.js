/**
 * dsh-profile — profile manager for DeepSeek Harness (cordis plugin half).
 *
 * Thin wrapper over core.js: registers profile_* model tools + a runtime
 * `profile` skill. The standalone CLI (bin/dsh-profile) shares core.js.
 *
 * @module dsh-profile
 */

import { opList, opCreate, opDelete, opRename, opDescribe, opUse, opExport, opImport, opInfo } from "./core.js";

export const name = "dsh-profile";
export const inject = ["tools", "skills"];

const present = (title, text) => ({ card: "generic", title, content: [{ type: "text", text: String(text) }] });

export function apply(ctx) {
  const tools = ctx.get("tools");
  const disposers = [];

  tools.register({
    name: "profile_list",
    description: "列出所有 dsh profile：名字、bundle 组合、本地插件、描述、当前默认。",
    parameters: { type: "object", properties: {}, required: [] },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute() { return opList(); },
    presentCall: () => present("Profile：列出", "profile_list"),

  });

  tools.register({
    name: "profile_create",
    description: "创建新的 dsh profile：生成 package.json（bundles 默认 [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless]，可自定义）+ cordis.patch.yml + pnpm-workspace.yaml + plugins/ 目录。创建后需在 shell 执行 `dsh plugin --profile <name> install` 安装依赖才能启动。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "profile 名（小写连字符）" },
        bundles: { type: "array", items: { type: "string" }, description: "可选：bundle 列表，默认 [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless]" },
        description: { type: "string", description: "可选：描述" },
        base_only: { type: "boolean", description: "true = 只用 @deepseek-ai/dsh-base（适合自研 app/交互式 profile）" },
      },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) {
      return opCreate(args.name, { bundles: args.bundles, baseOnly: args.base_only, description: args.description });
    },
    presentCall: (args) => present("Profile：创建", args?.name || ""),

  });

  tools.register({
    name: "profile_delete",
    description: "删除一个 dsh profile（整个目录，含本地插件与配置）。不可恢复，需 confirm=true。不能删除当前默认 profile。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "profile 名" }, confirm: { type: "boolean", description: "必须显式 true 才执行" } },
      required: ["name", "confirm"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opDelete(args.name, args.confirm); },
    presentCall: (args) => present("Profile：删除", args?.name || ""),

  });

  tools.register({
    name: "profile_rename",
    description: "重命名 dsh profile（移动目录）。若旧名字是当前默认，默认指向新名字。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "现 profile 名" }, new_name: { type: "string", description: "新名字（小写连字符）" } },
      required: ["name", "new_name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opRename(args.name, args.new_name); },
    presentCall: (args) => present("Profile：重命名", `${args?.name} → ${args?.new_name}`),

  });

  tools.register({
    name: "profile_describe",
    description: "读取或设置 profile 的描述（DESCRIPTION.md）。描述用于人/代理快速了解这个 profile 的用途。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "profile 名" }, description: { type: "string", description: "可选：设置描述；省略则读取当前描述" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opDescribe(args.name, args.description); },
    presentCall: (args) => present("Profile：描述", args?.name || ""),

  });

  tools.register({
    name: "profile_use",
    description: "把某 profile 设为默认：写入 ~/.dsh/default-profile，并在 ~/.dsh/bin/ 生成 dsh 包装脚本（直接执行 `dsh` 即进入该 profile，可用 DSH_PROFILE 环境变量临时覆盖）。用 profile_use name='' 清除默认。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "profile 名；空字符串清除默认" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opUse(args.name); },
    presentCall: (args) => present("Profile：设为默认", args?.name || "清除"),

  });

  tools.register({
    name: "profile_export",
    description: "把 profile 打包成 tar.gz（排除 node_modules 与 pnpm-lock 等可再生物）。用于备份或迁移。返回归档路径。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "profile 名" },
        path: { type: "string", description: "可选：输出路径（默认 ~/.dsh/exports/<name>-<时间>.tar.gz）" },
      },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opExport(args.name, args.path); },
    presentCall: (args) => present("Profile：导出", args?.name || ""),

  });

  tools.register({
    name: "profile_import",
    description: "从 tar.gz 归档导入 profile（dsh-profile export 产物；也可导入任意含 package.json 的 profile 目录归档）。name 可选覆盖目录名。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "归档路径（必填）" }, name: { type: "string", description: "可选：导入后的 profile 名（默认用归档内目录名）" } },
      required: ["path"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opImport(args.path, args.name); },
    presentCall: (args) => present("Profile：导入", args?.path || ""),

  });

  tools.register({
    name: "profile_info",
    description: "查看单个 profile 的清单：bundles、本地插件依赖、描述、目录路径、是否默认。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "profile 名" } },
      required: ["name"],
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args) { return opInfo(args.name); },
    presentCall: (args) => present("Profile：详情", args?.name || ""),

  });

  const skillsSvc = ctx.get("skills");
  if (skillsSvc && typeof skillsSvc.register === "function") {
    disposers.push(skillsSvc.register({
      name: "profile",
      description: "dsh profile 管理：列出/创建/删除/重命名/设默认/导出/导入 profile（Hermes `hermes profile` 移植）。",
      whenToUse: "当用户提到 profile、多配置、切换/创建/删除 profile，或询问当前默认 profile 时使用。",
      source: "custom",
      content: [
        "## 用途",
        "",
        "dsh 的 profile 是「有序 bundle patch 层 + 用户 patch 层」的组合（~/.dsh/profiles/<name>/）。本插件提供管理工具：",
        "",
        "- `profile_list`：先看有哪些 profile 和当前默认",
        "- `profile_create`：新建（默认 headless 组合；base_only=true 适合自研交互 app）",
        "- `profile_use`：设默认（生成 ~/.dsh/bin/dsh wrapper，DSH_PROFILE 可临时覆盖）",
        "- `profile_delete` / `profile_rename` / `profile_describe` / `profile_info`",
        "- `profile_export` / `profile_import`：打包迁移（排除 node_modules）",
        "",
        "## 注意",
        "",
        "- 创建/导入 profile 后需 shell 里跑 `dsh plugin --profile <name> install` 装依赖",
        "- 沙箱坑：本机无 bubblewrap，新 profile 要在 cordis.patch.yml 覆盖 sandbox-policy（danger-full-access）+ approval（never），否则 bash 被拒、fs 假写",
        "- 用户也可在 shell 直接用 `dsh-profile <list|create|delete|rename|use|export|import|...>`（同功能的独立 CLI）",
      ],
    }));
  }

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  });
}

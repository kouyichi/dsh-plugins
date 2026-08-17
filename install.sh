#!/usr/bin/env bash
# dsh-plugins 安装脚本：把 5 个插件挂到本机所有 profile
# 用法: bash install.sh
set -euo pipefail

export PATH=/root/.nvm/versions/node/v22.22.2/bin:$PATH
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PLUGINS_DIR="$DSH_HOME/plugins"
# 家级插件（全部 profile 生效）
PLUGINS="dsh-learn dsh-profile dsh-dream dsh-tower dsh-kanban dsh-scaffold dsh-guard dsh-xray dsh-cron dsh-bench dsh-pack dsh-a2a dsh-meter"
# TUI 积木（只挂 tui profile —— cordis inject 是硬依赖，砖的 tuiExtensions 服务只存在于 TUI；bridge 必须排第一）
TUI_BRICKS="dsh-tui-bridge dsh-tui-compact dsh-tui-usage dsh-tui-context dsh-tui-export dsh-tui-theme dsh-tui-todos dsh-tui-history dsh-tui-keymap dsh-tui-commands dsh-tui-btw dsh-tui-update dsh-tui-goals dsh-tui-find dsh-tui-a2a dsh-tui-search dsh-tui-trajectory dsh-tui-feedback dsh-tui-providers"

echo "==> 1. 确认插件目录存在"
for p in $PLUGINS; do
  [ -d "$PLUGINS_DIR/$p" ] || { echo "缺少 $PLUGINS_DIR/$p"; exit 1; }
done

echo "==> 2. 更新各 profile package.json（加 file: 依赖）"
for prof in headless web tui; do
  pkg="$DSH_HOME/profiles/$prof/package.json"
  [ -f "$pkg" ] || { echo "跳过（无 $pkg）"; continue; }
  node -e "
    const fs = require('fs');
    const path = '$pkg';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    for (const p of '$PLUGINS'.split(' ')) {
      pkg.dependencies[p] = 'file:../../plugins/' + p;
    }
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  更新', path);
  "
done

echo "==> 3. headless profile 沙箱修复（无 bubblewrap 本机）"
patch_file="$DSH_HOME/profiles/headless/cordis.patch.yml"
if ! grep -q "sandbox-policy" "$patch_file" 2>/dev/null; then
  # 旧模板文件内容是 "[]"（YAML 数组字面量），追加元素会语法错误 → 整文件重写
  if [ "$(cat "$patch_file" 2>/dev/null | tr -d ' \n')" = "[]" ]; then
    cat > "$patch_file" <<'EOF'
# Your patch layer for this dsh profile, applied after every bundle layer.
# 本机无 bubblewrap/Landlock：danger-full-access + never（否则 bash 被拒、fs 假写）
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
EOF
    echo "  已重写 $patch_file（原 [] 模板）"
  else
    cat >> "$patch_file" <<'EOF'

# 本机无 bubblewrap/Landlock：danger-full-access + never（否则 bash 被拒、fs 假写）
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
EOF
    echo "  已追加沙箱覆盖到 $patch_file"
  fi
else
  echo "  $patch_file 已有 sandbox-policy 覆盖，跳过"
fi

echo "==> 4. pnpm install（每个 profile）"
for prof in headless web tui; do
  dir="$DSH_HOME/profiles/$prof"
  [ -f "$dir/package.json" ] || continue
  echo "  --- $prof ---"
  (cd "$dir" && corepack pnpm install --no-frozen-lockfile 2>&1 | tail -3)
done

echo "==> 5. 开发期热链（node_modules 里的插件 → 源码）"
for prof in headless web tui; do
  nm="$DSH_HOME/profiles/$prof/node_modules"
  [ -d "$nm" ] || continue
  for p in $PLUGINS; do
    if [ -e "$nm/$p" ] && [ ! -L "$nm/$p" ]; then
      rm -rf "$nm/$p"
      ln -sfn "$PLUGINS_DIR/$p" "$nm/$p"
      echo "  $prof/node_modules/$p → symlink"
    fi
  done
done

echo "==> 5b. TUI 积木：tui profile 依赖 + 热链 + patch insert（只挂 tui）"
TUI_PROF="$DSH_HOME/profiles/tui"
if [ -f "$TUI_PROF/package.json" ]; then
  node -e "
    const fs = require('fs');
    const path = '$TUI_PROF/package.json';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    for (const p of '$TUI_BRICKS'.split(' ')) {
      pkg.dependencies[p] = 'file:../../plugins/' + p;
    }
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  更新 tui package.json（+TUI 积木依赖）');
  "
  (cd "$TUI_PROF" && corepack pnpm install --no-frozen-lockfile 2>&1 | tail -2)
  nm="$TUI_PROF/node_modules"
  for p in $TUI_BRICKS; do
    if [ -e "$nm/$p" ] && [ ! -L "$nm/$p" ]; then
      rm -rf "$nm/$p"
      ln -sfn "$PLUGINS_DIR/$p" "$nm/$p"
    fi
  done
  # patch insert 幂等追加（tuiExtensions 服务由 dsh-tui-app 提供）
  tui_patch="$TUI_PROF/cordis.patch.yml"
  missing=""
  for p in $TUI_BRICKS; do
    grep -q "name: '$p'" "$tui_patch" 2>/dev/null || grep -q "name: \"$p\"" "$tui_patch" 2>/dev/null || missing="$missing $p"
  done
  if [ -n "$missing" ]; then
    cat >> "$tui_patch" <<EOF

# TUI 积木（bricks）：扩展接缝 tuiExtensions 由 dsh-tui-app 提供，只在此 profile 生效
- insert:
EOF
    for p in $missing; do
      cat >> "$tui_patch" <<EOF
    - id: $p
      name: '$p'
EOF
    done
    echo "  已追加 TUI 积木到 $tui_patch:$missing"
  else
    echo "  $tui_patch 已含全部 TUI 积木，跳过"
  fi
fi

echo "==> 6. 生成/更新家级 patch 层（~/.dsh/cordis.patch.yml）"
home_patch="$DSH_HOME/cordis.patch.yml"
{
  echo "# 家级 patch 层：本机所有 dsh profile 生效"
  echo "# 由 dsh-plugins 安装脚本生成 — 插件全家桶挂载"
  echo ""
  echo "# 插件行（按加载顺序；每个都是 cordis 插件，tools/skills 服务可用即自动注册工具与技能）"
  echo "- insert:"
  for p in $PLUGINS; do
    echo "    - id: $p"
    echo "      name: $p"
  done
} > "$home_patch"
echo "  已更新 $home_patch（$(echo $PLUGINS | wc -w) 个插件）"

echo "==> 7. 验证 dump-config"
for prof in headless tui; do
  echo "  --- $prof ---"
  dsh --dump-config --profile $prof >/dev/null 2>&1 && echo "  OK" || echo "  FAILED"
done

echo "完成。插件目录: $PLUGINS_DIR"

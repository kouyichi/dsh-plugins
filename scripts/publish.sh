#!/usr/bin/env bash
# publish.sh — 发布 dsh-plugins 全家桶到 GitHub（kouyichi/dsh-plugins）
#
# ⚠️ 本脚本默认 DRY-RUN：不会创建仓库、不会推送。去掉 --go 才会真正执行。
# 用法：
#   bash scripts/publish.sh            # dry-run：检查一切并打印将执行的动作
#   bash scripts/publish.sh --go       # 真正发布（创建 repo + 推送 + 验证）
#
# 发布内容（13 插件 + 报告 + 工具链）：
#   dsh-learn dsh-profile dsh-dream dsh-tower dsh-kanban      (v1 全家桶, 5)
#   dsh-scaffold dsh-guard dsh-xray dsh-cron dsh-bench
#   dsh-pack dsh-a2a dsh-meter                                  (二期, 8)
#   + REPORT-2026-08-16.md / IMPLEMENTATION-REPORT.md / verify.mjs / install.sh
set -uo pipefail
GO=0
[ "${1:-}" = "--go" ] && GO=1

export PATH=/root/.nvm/versions/node/v22.22.2/bin:$PATH
REPO=/workspace/algorithm/dsh-plugins
REMOTE_NAME=origin
GH_USER=kouyichi
REPO_NAME=dsh-plugins

echo "== [1/5] 本地仓库检查 =="
cd "$REPO"
git status --porcelain | grep -q . && { echo "  ⚠️ 工作区有未提交改动："; git status --short; echo "  请先提交"; exit 1; }
echo "  ✓ 工作区干净"
BRANCH=$(git branch --show-current)
echo "  ✓ 当前分支: $BRANCH"

echo "== [2/5] 远程与凭据检查 =="
if git remote | grep -q "^$REMOTE_NAME$"; then
  echo "  remote $REMOTE_NAME 已存在: $(git remote get-url $REMOTE_NAME)"
  REMOTE_EXISTS=1
else
  echo "  无 remote（首次发布）"
  REMOTE_EXISTS=0
fi
# repo 级 credential helper（与 dsh-tui-app 同款：读 gh hosts.yml 的 oauth_token）
if git config --get credential.helper >/dev/null 2>&1; then
  echo "  credential.helper 已配置: $(git config --get credential.helper)"
else
  echo "  credential.helper 未配置（发布时需设置）"
fi

echo "== [3/5] GitHub repo 检查（REST，GraphQL 曾被拒）=="
EXISTING=$(gh api "repos/$GH_USER/$REPO_NAME" --jq '.full_name' 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
  echo "  ✓ repo 已存在: $EXISTING"
else
  echo "  repo 不存在（发布时将创建）"
fi

if [ $GO -eq 0 ]; then
  echo
  echo "== DRY-RUN：以上为将执行的动作预览。确认后运行: bash scripts/publish.sh --go =="
  exit 0
fi

echo "== [4/5] 执行发布 =="
[ $REMOTE_EXISTS -eq 0 ] && git remote add $REMOTE_NAME "https://github.com/$GH_USER/$REPO_NAME.git"
if [ -z "$EXISTING" ]; then
  echo "  创建 repo..."
  gh api --method POST /user/repos -f name="$REPO_NAME" \
    -f description="dsh (DeepSeek Harness) 插件全家桶：learn/profile/dream/tower/kanban + scaffold/guard/xray/cron/bench/pack/a2a/meter — 13 plugins, 76 tools" \
    -F private=false >/dev/null && echo "  ✓ 已创建 github.com/$GH_USER/$REPO_NAME"
fi
# repo 级 credential helper（全局 gh helper 会抢先返回 403，见 dsh-harness-development skill）
git config credential.helper "" >/dev/null 2>&1
if [ -f ~/.config/gh/hosts.yml ]; then
  TOKEN=$(python3 -c "import yaml,sys; d=yaml.safe_load(open('/root/.config/gh/hosts.yml')); print(d['github.com'][0]['oauth_token'])" 2>/dev/null || gh auth token)
  git config credential.helper "!f() { echo username=x-access-token; echo password=$TOKEN; }; f"
  echo "  ✓ repo 级 credential helper 已配置"
fi
git push -u $REMOTE_NAME "$BRANCH" && echo "  ✓ 已推送 $BRANCH"

echo "== [5/5] 验证 =="
sleep 2
gh api "repos/$GH_USER/$REPO_NAME" --jq '.full_name + " | " + .html_url' | sed 's/^/  ✓ /'
echo "  ✓ 发布完成: https://github.com/$GH_USER/$REPO_NAME"

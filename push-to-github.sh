#!/usr/bin/env bash
# PC Game Master 1.0.0 —— 推送到 GitHub 一键脚本
# 使用方法：
#   1) 把下面这行 YOUR_GITHUB_USERNAME 改成你的真实 GitHub 用户名
#   2) 在 GitHub 网页上先建一个【空】公开仓库，名称必须叫 pc-game-master
#      （不要勾选 README / LICENSE / .gitignore，我们已经有了）
#   3) 在本目录打开 Git Bash，运行：  bash push-to-github.sh
#   4) git push 时提示输入密码，请填【GitHub Personal Access Token】(不是登录密码)，
#      Token 需要勾选 repo 权限。可在 https://github.com/settings/tokens 生成。

set -e

# ====== 只需改这一行 ======
GITHUB_USER="jmac1990cn"
# ==========================

REPO="pc-game-master"

echo "==> 1. 回填 package.json 中的 OWNER 占位符（若已回填则自动跳过）"
if command -v node >/dev/null 2>&1; then
  node -e "const fs=require('fs');const u=process.env.GITHUB_USER;const p='package.json';let s=fs.readFileSync(p,'utf8');const before=(s.match(/github.com\/OWNER/g)||[]).length;s=s.split('github.com/OWNER').join('github.com/'+u);fs.writeFileSync(p,s);console.log('  替换 '+before+' 处 OWNER -> '+u);" || echo "   (node 回填跳过)"
else
  echo "   (未检测到 node，跳过；package.json 若已是真实地址则无需处理)"
fi

echo "==> 2. 提交仓库地址回填"
git add package.json
git commit -m "chore: 回填 GitHub 仓库地址 (OWNER -> $GITHUB_USER)" || echo "   (package.json 无变化，跳过提交)"

echo "==> 3. 配置远程仓库"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/$GITHUB_USER/$REPO.git"
  echo "   已更新已有 origin"
else
  git remote add origin "https://github.com/$GITHUB_USER/$REPO.git"
  echo "   已添加 origin"
fi

echo "==> 4. 主分支改名为 main"
git branch -M main

echo "==> 5. 推送 main 分支（此处会要求输入用户名 + Token）"
git push -u origin main

echo "==> 6. 打 v1.0.0 标签并推送（触发 GitHub Actions 自动出包）"
git tag v1.0.0
git push origin v1.0.0

echo ""
echo "✅ 完成！稍后到 https://github.com/$GITHUB_USER/$REPO/releases 查看 Actions 自动构建的安装包。"

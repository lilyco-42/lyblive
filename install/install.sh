#!/usr/bin/env sh
# lyblive 一键安装（Linux / macOS）
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/lilyco-42/lyblive/main/install/install.sh | sh
#   LYBLIVE_VERSION=v0.1.3 sh install.sh      # 指定版本
#   LYBLIVE_BIN_DIR=/usr/local/bin sh install.sh  # 指定安装目录
set -eu

REPO="lilyco-42/lyblive"
VERSION="${LYBLIVE_VERSION:-}"
BIN_DIR="${LYBLIVE_BIN_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)
    case "$arch" in
      x86_64|amd64) asset="lyblive-linux-x86_64" ;;
      *) echo "暂不提供 Linux $arch 的预编译包（可参照 README 从源码构建）" >&2; exit 2 ;;
    esac
    ;;
  Darwin)
    case "$arch" in
      arm64|aarch64) asset="lyblive-macos" ;;
      x86_64) echo "macOS Intel 暂无预编译包：可用源码构建，或在 Rosetta 下运行 arm64 包" >&2; exit 2 ;;
      *) echo "暂不提供 macOS $arch 的预编译包" >&2; exit 2 ;;
    esac
    ;;
  *)
    echo "本脚本支持 Linux / macOS；Windows 请用 install.ps1" >&2
    exit 2
    ;;
esac

if [ -n "$VERSION" ]; then
  base="https://github.com/$REPO/releases/download/$VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> 下载 $asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

echo "==> 校验 SHA256"
expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || { echo "SHA256SUMS 中找不到 $asset" >&2; exit 3; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
[ "$actual" = "$expected" ] || { echo "校验失败：期望 $expected，实际 $actual" >&2; exit 3; }

mkdir -p "$BIN_DIR"
install -m 0755 "$tmp/$asset" "$BIN_DIR/lyblive"

echo "==> 已安装到 $BIN_DIR/lyblive"
"$BIN_DIR/lyblive" --version || true

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "提示：把 $BIN_DIR 加入 PATH，例如："
     echo '  echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.profile' ;;
esac

echo
echo "下一步："
echo "  1) 启动 Web 控制台：$BIN_DIR/lyblive --web"
echo "  2) 浏览器打开 http://127.0.0.1:8765/ 扫码登录 B 站"
echo "  3) 想在 OBS 里用：退出 OBS 后执行 $BIN_DIR/lyblive --obs-install"
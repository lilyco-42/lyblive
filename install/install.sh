#!/usr/bin/env sh
# lyblive 一键安装（Linux / macOS）
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/lilyco-42/lyblive/main/install/install.sh | sh
#   LYBLIVE_VERSION=v0.3.6 sh install.sh      # 指定版本
#   LYBLIVE_BIN_DIR=/usr/local/bin sh install.sh  # 指定安装目录
#   LYBLIVE_FLOAT=1 sh install.sh             # Linux：同时启用桌面悬浮弹幕层（systemd user）
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

# 桌面入口（仅 Linux，可选）：不依赖 OBS 的浏览器模式入口
if [ "$os" = "Linux" ]; then
  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  if mkdir -p "$apps_dir" 2>/dev/null \
     && curl -fsSL "https://raw.githubusercontent.com/lilyco-42/lyblive/main/install/lyblive.desktop" -o "$tmp/lyblive.desktop" 2>/dev/null; then
    sed "s|@BIN@|$BIN_DIR/lyblive|g" "$tmp/lyblive.desktop" > "$apps_dir/lyblive.desktop" 2>/dev/null \
      && echo "==> 已添加应用菜单入口：lyblive Web 控制台"
  fi
fi

echo
echo "下一步："
echo "  1) 浏览器模式（不需要 OBS）：$BIN_DIR/lyblive --open"
echo "  2) 只启动服务：$BIN_DIR/lyblive --web --no-browser → http://127.0.0.1:8769/"
echo "  3) 桌面悬浮弹幕层（Linux）：$BIN_DIR/lyblive --float"
echo "  4) 想在 OBS 里用：退出 OBS 后执行 $BIN_DIR/lyblive --obs-install"

# 桌面悬浮弹幕层（Linux，可选）：LYBLIVE_FLOAT=1 时装成 systemd user 服务并立即启动
if [ "$os" = "Linux" ] && [ "${LYBLIVE_FLOAT:-0}" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$unit_dir"
    cat > "$unit_dir/lyblive-float.service" <<EOF
[Unit]
Description=lyblive 悬浮弹幕层 + 托盘
After=network-online.target

[Service]
Environment=GDK_BACKEND=x11
Environment=DISPLAY=${DISPLAY:-:0}
Environment=LYBLIVE_PORT=8768
ExecStart=$BIN_DIR/lyblive --float
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    echo "==> 已写入 $unit_dir/lyblive-float.service"
    systemctl --user daemon-reload || true
    if systemctl --user enable --now lyblive-float.service; then
      echo "==> 桌面悬浮弹幕层已启动：lyblive-float.service"
    else
      echo "提示：自动启动失败，可稍后手动执行 systemctl --user enable --now lyblive-float.service"
    fi
  else
    echo "提示：当前没有可用的 systemd user 会话，直接运行 $BIN_DIR/lyblive --float 即可"
  fi
fi
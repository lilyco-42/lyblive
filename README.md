# lyblive · B 站直播助手

lyblive 是一个面向 AI 与跨平台的 B 站直播助手原型：用 Rust 和 lilyco 维护**一份 20 条命令注册表**，同时派生 CLI、TUI、MCP stdio 服务和自建 axum Web 控制台；Web 前端使用 React 19、Tailwind 4 与 shadcn 组件。

当前版本 0.1.0 是本机可运行原型。它没有内置 B 站账号、不会替用户扫码，也不提供签名安装包或 Android APK；跨平台能力体现在纯 Rust 命令面、条件依赖、feature 门控、本机 Linux / Windows GNU / Android（arm64 与 x86_64）产物与 CI 构建矩阵中。

## 功能

- 扫码登录状态、二维码 SVG、会话状态；默认凭据仅留在内存，开启「记住登录」才写盘（Unix 显式 0600，Windows 依赖用户配置目录 ACL）。
- 直播间标题、分区、公告；开播、停播、推流地址与密钥；推流密钥默认打码，显式显示后由前端 10 秒恢复打码。
- 弹幕 WebSocket 监听、zlib/brotli 解码、心跳与重连、300 条上限统计、关键词 Top10，以及供 Web 消费的 SSE 事件流。
- 五个 Web 页签：登录、房间、直播、弹幕、设置；设置页展示命令、参数与安全级别。
- 给 Agent 的 MCP tools/list 与 tools/call：只读命令直接放行，白名单写命令放行，开停播和发弹幕等高危命令默认拒绝。

## 快速开始

前提：Rust 1.99+，Node.js 22+，pnpm 12+。Linux 本机已用 pnpm 12.19.0、Vite 8.3.7 验证。

~~~bash
cd /home/lilyco/code/lyblive
cd web
pnpm install --frozen-lockfile
pnpm lint
pnpm build
cd ..
cargo test
cargo build --release
./target/release/lyblive --web --no-browser
~~~

浏览器打开 http://127.0.0.1:8765/ 。无参数启动等价于启动 Web；桌面环境会尝试自动打开浏览器，--no-browser 可禁用。Web 只绑定 127.0.0.1；安全中间件对 API、静态资源和未知路径统一要求 Host 是严格回环 authority（localhost、数值 127.0.0.0/8 或 [::1]，端口必须合法），带 Origin 的 POST 也必须是 http(s) 的完整回环 origin；拒绝 127.evil.example 等 DNS 后缀、userinfo、路径及畸形端口。

## 四种界面

~~~bash
lyblive                         # 默认启动本机 Web 控制台
lyblive --web --no-browser      # 启动 Web 但不自动开浏览器
lyblive --mcp                   # MCP stdio 服务，供 Agent 调用
lyblive --tui                   # TUI
lyblive health --json           # CLI 只读命令
lyblive commands --json         # 导出完整命令描述
lyblive --schema                # CLI/TUI/MCP 共用的 20 条命令 schema
lyblive --version
~~~

LILYCO_UI 可设为 cli、tui、web、mcp；设为 cli 且无参数时显示帮助。正确写法是 lyblive <命令> 或 lyblive --schema，不是 lyblive --cli <命令>。

## MCP 快速示例

~~~bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | lyblive --mcp
~~~

tools/list 返回 19 个可见工具；内部命令 commands 被隐藏。MCP Agent 白名单只允许 login-qrcode、login-poll、danmu-start、danmu-stop、title、area、announcement 这些 T1 写操作；live-start、live-stop、danmu-send、config-set、login-logout 会被安全门拒绝（白名单与 docs/MCP.md、src/policy.rs 由 mcp-smoke.mjs 三方逐项校验），需由人在 Web 或 CLI 中操作。完整协议见 docs/MCP.md；`node scripts/mcp-smoke.mjs` 还会以同一二进制的 `--schema` 为基准，逐项比对可见工具的名称、描述、T1 安全标注与 inputSchema 参数类型/required，并活体验证白名单内 `danmu-stop` 放行、白名单外 `login-logout` 拒绝，防止 Agent 契约漂移。

## HTTP API

所有接口同源挂在 /api 下，错误体统一为 {"ok":false,"error":"中文消息"}。唯一契约在 web/src/lib/api.ts。

- GET：/api/health、/api/session、/api/login/poll?key=...、/api/room、/api/partitions、/api/stream-key?reveal=0|1、/api/danmu/status、/api/danmu/events、/api/commands、/api/config。
- POST：/api/login/qrcode、/api/login/logout、/api/title、/api/area、/api/announcement、/api/live/start、/api/live/stop、/api/danmu/start、/api/danmu/stop、/api/danmu/send、/api/config。
- /api/danmu/events 是 text/event-stream；每条 data 是 {ts,kind,user,text,running,popularity} 形状的 JSON。

POST 请求体用 camelCase（areaId、roomId、rememberLogin），API 层映射到命令注册表的 kebab-case 参数（area-id、room-id、remember-login）。

## 配置与安全

- LYBLIVE_PORT：Web 起始端口，默认 8765，端口占用时向后重试 20 个端口。
- LYBLIVE_CONFIG_HOME：配置目录，默认使用系统 XDG 配置目录下的 lyblive。
- LILYCO_UI：cli、tui、web、mcp。
- 登录凭据默认不落盘；开启「记住登录」后写 config.json：Unix 下显式 chmod 0600，Windows 下不做 chmod、依赖用户配置目录的 NTFS ACL 继承（CLI --help 的「0600」为 Unix 语义）。Cookie、CSRF、推流密钥不出现在 Web 会话响应或普通日志中。
- 推流密钥只在内存中保存明文；开播响应和 /api/stream-key 默认返回打码值，reveal=1 才返回明文。
- Web 无 X-Lilyco-Token 头：它只监听回环并校验 Host/Origin，适合单机个人控制台；不要直接暴露到公网或反向代理到非可信域名。

## 跨平台

Cargo features：default = ["tui", "browser"]，tui = ["lilyco/tui"]，browser = ["dep:webbrowser"]，headless = []。webbrowser 是 optional 目标依赖，Android/iOS 通过 cfg 排除；api.rs 的自动打开浏览器另有 feature 门控。lilyco 关闭默认特性后可在无 crossterm 的 headless 目标回退到 CLI。Android/Termux 建议使用 --no-default-features --features headless。

.github/workflows/ci.yml 已设计 Linux/macOS/Windows 桌面矩阵与 Android aarch64-linux-android / x86_64-linux-android 双 ABI headless 构建，桌面矩阵 release 后运行 node scripts/smoke.mjs、node scripts/mcp-smoke.mjs、node scripts/web-smoke.mjs；真实浏览器 node scripts/browser-smoke.mjs 只在 ubuntu/windows runner 执行，macOS runner 因 --remote-debugging-pipe CDP 不稳定跳过该项（仍覆盖原生构建与 Web HTTP 契约），并经 PyYAML 语法校验与 `node scripts/ci-contract.mjs` 工作流契约回归（桌面三 OS、Android 双 ABI、三份上传均设 `if-no-files-found: error`、`pnpm build` 必须先于 cargo、Web 资源禁止 build.rs 占位页，JS/CSS/5 个 woff2 字体及编译后二进制内嵌字节逐项一致）；远程仓库为 https://github.com/lilyco-42/lyblive ，CI 由推送与 v* 标签触发；publish job 只在 v* 标签推送时把 Linux/Windows/macOS/Android 五个未签名二进制与 SHA256SUMS 发布到 GitHub Release。Round 14 严格回环校验修复后本机最终回归全绿：cargo fmt、clippy -D warnings、33 项 Rust 测试（Round 14 补充严格 Host/Origin authority 正例/反例，含 `agent_whitelist_matches_registry_tiers_and_gate` 穷举白名单/分级一致性、`registered_handlers_enforce_runtime_policy_for_local_and_agent` 直接调用 Local/Agent 注册表 handler 验证放行与安全门、Router::oneshot 非回环 Host 403 及回环 Web T1 路由直达 `commands::dispatch` 的回归）、headless check、release、四套 Node smoke（CLI / MCP Agent schema+白名单对齐 / Web HTTP+SSE+严格 Host/Origin / 真实浏览器；macOS runner 的 CDP 不稳定，原生 macOS 只做构建和 Web HTTP 检查）、pnpm lint（0 errors）与 pnpm build。已根据 Round 14 补丁重建六份未签名二进制；其中四份完成运行验证，macOS 双架构仅做静态验证：

- Linux x86_64 release（6247424 B）：CLI、MCP、HTTP/静态/SSE/Host/Origin 全链路。
- Windows x86_64-pc-windows-gnu PE32+（5591040 B，Zig 0.17.1 + llvm-dlltool）：Wine 下四套 smoke 全过，覆盖 CLI、MCP（19 工具、Agent 放行/拒绝）、Web（/api/health、首页、/api/commands 20 条、静态资源/字体、严格 Host/Origin、SSE）与真实 Chrome React/shadcn 渲染。
- Android aarch64 ELF（5232752 B，NDK r27d / Android 24）：此前 Android 模拟器上 CLI、MCP 与 Web 控制台实跑；补丁后完成重建、file/嵌入资产校验，当前模拟器为 x86_64，未重跑 arm64。
- Android x86_64 ELF（5869560 B，同 NDK）：补丁后在 Android 模拟器实跑 --version 与 health --json；此前同设备完成 CLI、MCP 与 Web 控制台全链路。
- macOS aarch64-apple-darwin Mach-O（4749904 B，minos 11.0）：file/llvm-otool/llvm-nm 静态验证，动态依赖 /usr/lib/libSystem.B.dylib 与 /usr/lib/libiconv.dylib；未在真实 macOS 执行。
- macOS x86_64-apple-darwin Mach-O（5347816 B，minos 10.12）：同套静态验证与动态依赖；未在真实 macOS 执行。

Windows MSVC 与 macOS 原生构建/运行验证由 GitHub Actions 的 windows-latest / macos-latest runner 执行；v* 标签推送还会在所有 job 成功后自动创建 Release。本机 macOS 产物用 Zig 与仅链接期解析 -liconv 的 libiconv.tbd stub 交叉链接，stub 不打包进产物，产物未签名/公证；不产出签名安装包、APK 或应用商店发布流程。

## 验证命令

~~~bash
cd /home/lilyco/code/lyblive
cargo fmt -- --check
cargo clippy --offline --all-targets -- -D warnings
cargo check --offline --no-default-features --features headless --all-targets
cargo test --offline
cd web && pnpm lint && pnpm build && cd ..
cargo build --offline --release
node scripts/smoke.mjs
node scripts/mcp-smoke.mjs
node scripts/web-smoke.mjs
node scripts/browser-smoke.mjs
~~~

四个脚本都接受可选的二进制路径参数（argv[2]），并支持 `LYBLIVE_SMOKE_WRAPPER=wine`；因此从产物归档解出的 Linux 或 Windows GNU 二进制也都能用同一套契约回归。

`node scripts/browser-smoke.mjs` 用纯 Node stdlib 启动 release 二进制及无头 Chrome，经 `--remote-debugging-pipe` 在真实浏览器里验证 React 挂载、五个 Tab 的鼠标/键盘切换、Geist/Tailwind 计算样式、命令表与零 JS 异常；只在允许的离线后端 4xx 路径上放行预期网络日志。`node scripts/ci-contract.mjs` 不启动二进制、不联网；CI 中 browser-smoke.mjs 设 if: runner.os != macOS：它在源码树或产物归档内定位 `ci.yml`，逐项锁定触发器、桌面三 OS、四个 smoke 与 macOS browser-smoke 例外、上传策略、Android 双 ABI/NDK/构建顺序、严格 Host/Origin 解析器与浏览器进程清理；`--assets` 检查 `web/dist/index.html` 不是占位页并逐项读取真实 JS/CSS/5 个 woff2 字体，`--embedded` 在 cargo release 后逐字节确认编译产物内嵌这些资源，`--embedded --all-artifacts` 可在产物归档解包后一次校验六份二进制。CI 在两个 job 的 Node 安装后、`pnpm build` 后与 cargo release 后分别运行它，防止某平台静默缺二进制、嵌入占位页或沿用陈旧资产。产物归档自带扁平 `./assets/` 的 9 份构建资产；`--embedded --all-artifacts` 只从该归档目录读取 `assets/` 与 `bin/`，不借用上级目录资源。

## 已知边界

- 真实登录、开播、停播、发弹幕和弹幕长连接需要用户自己的 B 站会话；本机验收只覆盖打桩、未登录路径、协议解析、安全门与离线命令，不使用或存储用户凭据。
- 上游弹幕 INTERACT_WORD_V2 的 protobuf 负载没有引入 prost，首版按普通进场/系统事件处理或忽略。
- Linux、Windows GNU 与 Android arm64/x86_64 headless 已有本机产物与实跑验证；四个 Node smoke 均支持显式二进制与 Wine 包装器（CI 中真实浏览器 smoke 仅在 ubuntu/windows 执行）；web-smoke.mjs 已在 Linux 与 Wine/Windows GNU 下验证 Web 首页、静态资源、SPA 回落、API、严格 Host/Origin 安全门（含 127.* DNS 后缀、畸形端口与 IPv6 正例）与 SSE；browser-smoke.mjs 已在 Linux 与 Wine/Windows GNU 下通过真实 Chrome 验证 React 挂载、五个 shadcn Tab 的鼠标/键盘切换、Geist/Tailwind 计算样式与无 JS 异常；macOS 双架构仅有本机静态验证（未在真实 macOS 执行、未签名/公证）；Windows MSVC 与 macOS 原生构建/运行验证由 GitHub Actions 工作流在 windows-latest / macos-latest runner 执行；不含签名安装包、APK 或应用商店发布流程。
本机若 ~/.cargo/config.toml 把 [build] target-dir 指向共享缓存，必须给 cargo 与四个 smoke 显式设置同一个 CARGO_TARGET_DIR=$PWD/target；否则 cargo 更新的二进制与 smoke 默认读取的 target/release/lyblive 可能不是同一份。`node scripts/ci-contract.mjs --embedded` 与 `web-smoke.mjs` 的内嵌字节/HTTP 字节比对会直接暴露这种陈旧二进制。
- 源码已推送到 https://github.com/lilyco-42/lyblive ；release 资产为 runner 生成的未签名二进制，请用 GitHub Release 中的 SHA256SUMS 校验。

## 本机 Windows GNU 交叉验证（可选）

在 Linux 上已有 Zig 0.17.1、llvm-dlltool 与 Wine，且不安装 MSVC/MinGW 时，可用 Zig 作为 C 编译器/链接器验证 headless Windows GNU 产物。关键环境是 CARGO_TARGET_DIR=target-zigwin、CC_x86_64_pc_windows_gnu 与 CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER 指向 Zig cc 包装器、AR 指向 zig ar、RUSTFLAGS="-C dlltool=/usr/bin/llvm-dlltool"，命令为：

~~~bash
cargo build --offline --release --no-default-features --features headless --target x86_64-pc-windows-gnu
wine target-zigwin/x86_64-pc-windows-gnu/release/lyblive.exe --version
~~~

包装器需在最终链接时去掉 Rust windows-gnu 默认追加的 -l:libpthread.a、-lmsvcrt、-lmingwex、-lmingw32，保留 -lgcc_eh/-lgcc 提供 unwind 符号；产物是未签名的控制台 PE，不是 MSVC 安装包。

## 本机 Android headless 交叉验证（可选）

已安装 Android SDK NDK r27d（或 r27 系）时，可直接在 Linux 上编译并真机/模拟器运行 headless 二进制：

~~~bash
NDK=$HOME/Android/Sdk/ndk/android-ndk-r27d
BIN=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
export CARGO_TARGET_DIR=$PWD/target-android
export CC_aarch64_linux_android=$BIN/aarch64-linux-android24-clang
export AR_aarch64_linux_android=$BIN/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$BIN/aarch64-linux-android24-clang
export CC_x86_64_linux_android=$BIN/x86_64-linux-android24-clang
export AR_x86_64_linux_android=$BIN/llvm-ar
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER=$BIN/x86_64-linux-android24-clang
cargo build --release --no-default-features --features headless --target aarch64-linux-android
cargo build --release --no-default-features --features headless --target x86_64-linux-android
ABI=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')
case "$ABI" in
  arm64-v8a) DEVICE_BIN=target-android/aarch64-linux-android/release/lyblive ;;
  x86_64) DEVICE_BIN=target-android/x86_64-linux-android/release/lyblive ;;
  *) echo "unsupported ABI: $ABI"; exit 1 ;;
esac
adb push "$DEVICE_BIN" /data/local/tmp/lyblive
adb shell 'chmod 755 /data/local/tmp/lyblive && /data/local/tmp/lyblive health --json'
~~~

两个 target 都会交叉编译并留在 `target-android/`；`adb` 只推送并执行与设备 `ro.product.cpu.abi` 匹配的那一份，另一份是构建产物，不应假设能在同一设备原生执行。aarch64 产物只链接 libdl/libm/libc，可直接在 arm64 设备或支持 arm64-v8a 的模拟器上运行；x86_64 产物在 x86_64 模拟器上原生运行，不依赖 arm64 二进制转译。Web 控制台在设备内监听 127.0.0.1，可用 adb forward 在主机浏览器访问。
## 本地部署（systemd user）
当前开发机已把 lyblive Web 控制台部署为用户级 systemd 服务，默认只监听回环地址 `127.0.0.1:8768`（端口 8765 已由 AgentDock 占用，8766/8767 分别是 lycodl/lycomc）：

```bash
systemctl --user status lyblive.service
curl -sS -H 'Host: 127.0.0.1:8768' http://127.0.0.1:8768/api/health
```

打开：<http://127.0.0.1:8768/>。服务单元位于 `~/.config/systemd/user/lyblive.service`，程序位于 `~/.local/bin/lyblive`，日志可用 `journalctl --user -u lyblive.service -f` 查看。默认不持久化登录凭据；如需改端口，编辑单元的 `LYBLIVE_PORT` 后执行 `systemctl --user daemon-reload && systemctl --user restart lyblive.service`。

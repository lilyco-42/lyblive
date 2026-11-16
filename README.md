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
- 开播若返回 B 站 code 60043（本次开播需要身份验证），这是平台侧的实名/人脸认证，不是 lyblive 或 OBS 的功能入口：先确认关播且 OBS 未推流，用同一账号在 B 站手机客户端或官方直播姬点「开始直播」并完成人脸验证，停掉官方端后再回 lyblive 开播；若官方端未弹出认证，检查同一账号、实名状态与停播冷却期，不要反复点击以免触发开播频繁。lyblive 不能代做人脸认证，也不会索取或保存账号凭据；check_response() 仅把这段操作提示追加到错误信息，由 CLI/Web/MCP 共用。

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

仓库 `deploy/` 提供可移植模板与 `install.py`：默认执行只读 `--plan`，`--apply --bin target/release/lyblive` 备份并安装 unit/启动器/二进制，`--apply --no-binary --configure-dock` 只在 OBS 退出后改 `user.ini`；二者都不重启运行中的服务。`LYBLIVE_PORT` 同时改后端端口与 dock URL，`--fixture` 仅在离线副本测试。unit 文件里的 `%h` 由 systemd 展开为账号 HOME，但 `systemd-run --property=Environment=HOME=%h` 不会展开；`systemd --user` 自动把 user manager 的 `DISPLAY`、`XAUTHORITY`、`XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS` 传给进程，`PassEnvironment=` 只对 system manager 有意义，模板不使用它。CI 两个 job 均运行 `node scripts/ci-contract.mjs --deploy` 静态校验模板、安装器守卫与工作流步骤；`--all-artifacts` 读取旧产物快照时跳过源码树部署检查。`scripts/deploy-install-smoke.mjs` 在临时 HOME 夹具中离线实跑 `--plan`、`--apply`、幂等、端口覆盖和输入守卫（含正例与负例）；两个 CI job 用 `actions/setup-python@v5` 固定 Python 3.12 后执行它（也探测 `python3`/`python`/`py -3`），不再只靠静态 grep 校验安装器；`ci-contract.mjs` 校验两处 setup 步骤及其位于 smoke 之前的顺序，源码树专属守卫在 `--all-artifacts` 旧归档校验时跳过。契约按精确步骤行解析 setup 与版本，且版本值必须用单引号或双引号逐字写成 `'3.12'` / `"3.12"`，YAML 注释或裸 `3.12` 都不会冒充 pin。安装器写回 user.ini 时按 Qt QSettings 的 INI 语义处理 [BasicWindow]：容忍 section header 的前导空白及 `]` 后的注释/空格、把所有 repeated [BasicWindow] 段视为同一逻辑段、把大小写变体的 ExtraBrowserDocks 键与带 leading whitespace 的键一起合并成唯一的规范列 0 键，并拒绝坏 JSON 或非数组 JSON，避免旧 dock 因重复键/重复段被 QSettings 后值覆盖而失联；Linux 的 Qt INI section/key 实际大小写敏感，这里的键名 casefold 合并是更保守的防重复策略，不是声称 Qt 忽略大小写。若文件无 [BasicWindow] 会新建真正的 section 而非写入裸顶层键；末行无换行时先补 EOL；读写全程使用 `newline=""` 的 `read_raw()` 保留 CRLF；UTF-8 BOM 在 Qt-equivalent 解析前剥离、写回时保留在原位置，未加引号的 `;` inline comment 按 QSettings `readIniLine` 语义截断，避免 BOM 或注释造成 [BasicWindow] 重复段/坏 JSON。离线 smoke 用 BOM-preserving 夹具断言 BOM 三字节、原 dock、`[Panels]` 数据不丢且二次 apply 幂等。离线 smoke 用「重复段 + 带 trailing comment 的下一 section + 大小写变体键 + 其它段 dock」夹具断言最终只剩一个规范键且原有 dock 均保留，并覆盖缺段、末行无 EOL、CRLF、坏 JSON 拒绝与逐文件严格幂等。`--fixture` 下 all write targets 都会先 resolved through symlinks，再要求位于临时 HOME 内且不在真实 HOME 内：检查 `XDG_CONFIG_HOME`、unit/bin 目标与 `--dock-ini`，防止离线测试误改真实 systemd/OBS 配置；smoke 另用 HOME 外路径、HOME 外 `XDG_CONFIG_HOME` 与 symlink escapes 三组负例验证拒绝后目标未被改写。 所有输出文件、备份路径也纳入同一检查；`binary/backup symlinks` 逃跑会被拒绝，安装器用 `backup_copy` / `atomic_copy` 经临时文件原子替换符号链接，不向其目标写入。 Windows CI 若没有创建符号链接的权限，安装器 smoke 会改用 hard-link fallback 验证原子替换；两个 CI job（both CI jobs）都同时执行普通与 Windows-like 两条路径，契约守卫禁止任一路径漂移。`LYBLIVE_SMOKE_FORCE_NO_SYMLINK=1` 可在任何平台复现该回退。节头前导空白也按 Qt readIniLine 先 trim，因此缩进（indented header）的 `  [Other]` 会正确结束上一节，其 dock 键不会被吸进 BasicWindow；smoke 夹具同时断言 Other 段 dock 保留、BasicWindow 只剩自己的 dock。值扫描按 Qt readIniLine 的引号语义处理：未加引号的分号仍截断为注释，但引号内的分号（例如 dock URL 里的 `http://127.0.0.1:9/api;jsessionid=abc`）会完整保留，不会被截成非法 JSON；反斜杠转义下一个字符。

安装器把 canonical mode（`0644/0755`）也纳入幂等判定：unit 0644、launcher/binary 0755；缺位、多余或 special bits 都只修权限不重写内容，`--plan` 会诚实显示 `mode repair`，且 chmod 不跟随符号链接。`bad JSON` 在 `--plan` / `--apply` 都给出可读 argparse 错误并在任何 unit/launcher 写入前 `atomic` 终止，避免配置损坏时留下半套部署；离线 smoke 用独立 HOME 断言旧 unit 哨兵与缺失 launcher 均未被改写。

安装器对 non-UTF-8 文件给出可读 argparse 错误，或备份原始字节后安全替换 unit；缺陷 user.ini 在写入任何 unit/launcher 前终止。missing OBS dock 的 `--plan` 显示 `[create]`，`--apply` 在 OBS 未运行时创建规范 0644 user.ini；OBS is running 时拒绝编辑或创建，避免与正在运行的 OBS 写冲突；进程探测本身也有 `OBS_DETECT_TIMEOUT = 5` 上界，挂住的 `pgrep`/`tasklist` 会触发 `OBS detection timeout` 并在写入前终止；离线 smoke 用 `LYBLIVE_SMOKE_OBS_STATE` 确定性地模拟 clear/running/timeout，覆盖 bounded OBS detection，不会 traceback 或半写入。dock symlink 写穿解析目标并保留链接，不用 `os.replace` 把链接替换成普通文件；`--no-binary` 缺既有二进制也返回 readable argparse error。离线 smoke 覆盖四类行为。

安装器备份采用 frozen-clock 下仍 collision-free 的 `os.link` + `mkstemp` 命名：首次写入固定 `.dsh-portable-backup`，已有备份时用同级唯一临时文件，不用可碰撞的秒级时间戳或 `os.replace` 覆写历史；离线 smoke 冻结 `time.strftime` 并连续改写四次，断言四个原始版本都保留。

安装器在 `--plan` 输出或 `--apply` 写入前执行 `destination preflight`：`check_write_target` 验证每个输出路径不是目录/损坏链接等 non-regular file、已有普通文件可读、父目录可写（`parent directory is not writable`），`check_readable_source` 验证二进制源可读（`cannot read installer source binary`）；任何一项失败都返回 rc=2 的 argparse 错误，不留半套部署，也不会把 `DO_NOT_TOUCH` 哨兵当备份对象。离线 smoke 对目录目标、`blocked parent`（父路径被普通文件阻塞）、0000 权限 unit、0555 父目录、0000 二进制源与损坏链接各自断言 `--plan`/`--apply` 均失败且原文件不变。安装器还在 `parse_args()` 后立即把 `HOME` 与 `XDG_CONFIG_HOME` 的绝对路径校验交给 argparse：`relative HOME` / `relative XDG_CONFIG_HOME` 分别返回 rc=2 的 `HOME must be an absolute path`、`XDG_CONFIG_HOME must be an absolute path`，不会在路径拼接前抛出 `RuntimeError`，也不会暴露 Python traceback 或写入任何文件；离线 smoke 的 5 条输入守卫逐条断言可读错误与 no traceback。此外，`HOME` 或 `XDG_CONFIG_HOME` 为 `~`、`~/...` 时由安装器按真实账户主目录显式展开，不再对临时 fixture 的 `HOME` 调用 `Path.expanduser()`（`RuntimeError: Could not determine home directory.`）；`~` 展开后的 `--plan` 返回 rc=0、显示 `HOME=/home/lilyco`，离线 smoke 同时断言服务目标存在且无 traceback。命令行 `--bin`、`--dock-ini` 的 `~`、`~/...` 同样经 `user_path()` 从真实账户主目录展开：夹具 `HOME=~` 下 `~/missing-lyblive` 返回 rc=2 的 `--bin is not a file: /home/lilyco/missing-lyblive`，`~/missing-user.ini` 的 `--plan` 输出 `OBS dock -> /home/lilyco/missing-user.ini [create]` 且不写真实主目录；两者都无 traceback。 corrupt deploy bundle（缺少 `lyblive.service`、非 UTF-8、硬编码 `/home/lilyco`、WorkingDirectory marker drift）由 `bundle_error()` 在读模板阶段统一转成 rc=2 的 `deployment template ... is invalid: ...; restore deploy/ from the release bundle`，既无 Python traceback，也不输出计划或写入任何文件；离线 smoke 复制 deploy/ 模板和 install.py 到四个独立夹具逐条验证。 安装器还会在任何 `--apply` 写入前做 `unreachable-systemd preflight with bounded timeouts`：用 `systemctl --user show-environment` 探测用户管理器，若当前 shell 没有 `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` 或 PATH 里缺 `systemctl`/`systemd-analyze`，`--plan` 明确打印 `systemd --user: UNREACHABLE`，`--apply` 以 rc=2 拒绝且一个文件都不写；此时可显式 `--no-systemctl` 仅安装文件，之后在图形/登录会话里手动 `daemon-reload && enable lyblive.service lyblive-obs.service`。离线 smoke 用 `sitecustomize.py` 隐藏两个工具、模拟 `TimeoutExpired`，并断言 `--no-systemctl` 路径仍可完成纯文件安装；所有 systemctl/systemd-analyze 子进程都有 `SYSTEMD_TIMEOUT = 15` 秒上限，卡住的用户管理器不会挂死安装器。


## 单 OBS 集成（Custom Browser Dock）

本机 KDE/Wayland 会话里，OBS 33 的 Wayland 原生模式不渲染 Custom Browser Dock；而 X11/XWayland 模式若继承 `SESSION_MANAGER`、`WAYLAND_DISPLAY` 或桌面激活令牌，Qt 又会在约 10 秒后干净自退。已验证的做法是让 lyblive 后端与**同一个** OBS 进程配合：

- `lyblive.service` 在 `127.0.0.1:8768` 提供 Web 控制台，`~/.config/obs-studio/user.ini` 的 `[BasicWindow]` 保存 `ExtraBrowserDocks`，其中标题为 `lyblive`、URL 为 `http://127.0.0.1:8768/`。
- `~/.local/bin/lyblive-obs` 启动 `/usr/bin/obs --multi --disable-updater`，清除 `WAYLAND_DISPLAY`、`SESSION_MANAGER`、`DESKTOP_STARTUP_ID`、`XDG_ACTIVATION_TOKEN`，并固定 `QT_QPA_PLATFORM=xcb`、`XDG_SESSION_TYPE=x11`；未给 lilyco facade 增加新的原生插件 feature，也不需要第二个 OBS 进程。
- `lyblive-obs.service` 在 `Wants=lyblive.service`、`After=lyblive.service` 下启动上述脚本；`systemctl --user enable --now lyblive-obs.service` 可持久化。OBS 日志应出现 `Using EGL/X11`、`Session Type: x11`、`[obs-browser]: Version 2.27.5`，且 `ss -tnp` 可见 `obs-browser-page` 到 `127.0.0.1:8768` 的 ESTAB 连接。
- 验证：`curl -sS -H 'Host: 127.0.0.1:8768' http://127.0.0.1:8768/api/health` 返回 `{"ok":true,...}`；OBS 主窗口右侧应显示 lyblive 五个 Tab、开播控制与默认打码的推流地址/密钥。不要把推流密钥写进 OBS 场景集合或日志；浏览器 dock 与页面同源，只监听回环地址。

本机可用 `scripts/single-obs-regress.sh` 做只读回归：它检查两个 systemd 用户单元、恰好一个 OBS 进程、OBS 环境变量（四个会话/激活变量已清除且 `QT_QPA_PLATFORM=xcb`）、回环健康与 `obs-browser-page` 连接、`user.ini` dock URL、场景集合无 `browser_source`、最新 OBS 日志、unit 依赖与仓库 `deploy/` 模板的可移植性、安装器离线夹具实跑；启动器路径里的 `%h` 会展开为当前 HOME 后再检查。失败即返回非零。该脚本不重启服务、不读取凭据、不进行远端写。

脚本默认从 `lyblive.service` 的 `Environment=LYBLIVE_PORT=` 解析端口，并支持 `LYBLIVE_HOME`、`LYBLIVE_WEB_UNIT`、`LYBLIVE_OBS_UNIT`、`LYBLIVE_PORT` 覆盖；`LYBLIVE_OBS_UNIT_FILE`、`LYBLIVE_WEB_UNIT_FILE`、`LYBLIVE_OBS_ENV_FILE` 仅用于负例文件夹具，不影响正在运行的服务。若显式 `LYBLIVE_PORT` 与单元声明不一致会直接判失败。除上述检查外，还验证 OBS 启动器的 `-u`/X11 环境变量、OBS 进程 cmdline、Web 单元 PID 是否占用回环端口、最新日志可读性与 `systemd-analyze --user verify`。

冷启动顺序也纳入回归：本次开机 `default.target` 在 `08:25:16` 已 active，而 `graphical-session.target` 与 XWayland 的 X11 display `:0` 到 `08:25:35` 才就绪；若 GUI unit 只挂在 `default.target`，OBS 可能在 X11 尚不可用时启动，且旧配置 `Restart=no` 会让它永久停在失败状态。原 unit 备份在 `~/.config/systemd/user/lyblive-obs.service.dsh-boot-robust-backup`。

现 `lyblive-obs.service` 使用 `WantedBy=graphical-session.target`、`PartOf=graphical-session.target`、`After=graphical-session.target`、`After=lyblive.service`，并设 `Restart=on-failure` / `RestartSec=5`；`systemctl --user enable lyblive-obs.service` 只创建 `graphical-session.target.wants/` 符号链接。`PartOf` 让 OBS 随图形会话停止，避免会话结束后残留 GUI；headless `lyblive.service` 仍由 `default.target` 拉起。`Restart=on-failure` 只处理非零失败，用户主动关闭 OBS 或清环境失败导致的干净自退仍须靠 launcher 里 `-u` 会话变量修复，不应改成 `Restart=always`。回归脚本会检查上述 unit 字段、enable 符号链接、`graphical-session.target` 的 Wants 反向依赖和有效重启策略；`LYBLIVE_OBS_UNIT_FILE` 可指向旧 unit 做负例，不影响正在运行的服务。

本机已通过 `deploy/install.py --apply --no-binary` 将 unit 文件迁移到 `%h` 模板（原文件自动备份为 `*.dsh-portable-backup`），只做 daemon-reload/enable，未重启 OBS；下次手动 restart 时新配置才进入进程环境。旧字段 `PassEnvironment=XAUTHORITY` 是 systemd --user 的 no-op，回归脚本要求 unit 文件不再写它，但保留运行时 `XAUTHORITY`/`DISPLAY` 与会话管理器一致的检查。

冷启动还依赖 X11 认证：`systemd --user` 默认把 user manager 的 `DISPLAY`、`XAUTHORITY`、`XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS` 传给服务进程；`PassEnvironment=` 仅对 system service manager 有意义，对 user manager 无效，也不应把随会话变化的 cookie 路径硬编码进 unit。回归脚本确认 OBS 进程实际拿到与会话管理器相同的 `XAUTHORITY`、cookie 文件可读（不读取内容）、`DISPLAY` 一致，并确认 headless `lyblive.service` 仍只挂在 `default.target.wants/`、`default.target` 的运行时 Wants 包含它、没有 `graphical-session.target.wants/` 链接。这样误改 `DISPLAY`、丢失 X11 认证或把 Web 后端挂到图形目标都会立即失败，而不是等下次冷启动时才报错；`deploy/` 模板与 CI `--deploy` 契约另行禁止硬编码这些会话值。

若切回纯 Wayland 启动 OBS，dock 可能缺席；这不是 lyblive 后端故障。可用 `xprop -root _NET_CLIENT_LIST` 找到 `WM_CLASS="obs"` 的窗口，再以 `import -display :0 -window <id> obs.png` 取证（XWayland 下抓取 root 常为黑图）。

若目标窗口被最小化/未映射（`xprop -id <id> WM_STATE` 为 `Iconic`、`_NET_WM_STATE` 含 `_NET_WM_STATE_HIDDEN`），ImageMagick 7.1.2-35 的 `import` 会误报 `missing an image filename`：该报错来自 `MagickWand/import.c:1291` 的 `image == NULL` 分支，并非缺少输出文件名。先用 `XMapRaised`/`XMapWindow`（例如 Python ctypes 调 `libX11.so.6`）重新映射窗口，确认 `WM_STATE=Normal` 后再抓图即可；`XSetInputFocus` 失败不影响已完成的映射。

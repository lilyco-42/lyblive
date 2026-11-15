# lyblive 架构

## 设计目标

用一份命令注册表保证 CLI、TUI、MCP、Web 的命令名、参数 schema 和安全级别一致；把 B 站领域逻辑收在可注入 Transport 的薄层里；让 Web 控制台只做状态展示与人机确认，不直接持有凭据。

## 模块地图

| 路径 | 职责 |
| --- | --- |
| src/main.rs | 同步入口；构造共享状态并按 --mcp / --web / --tui / CLI 分发；仅 Web 启动 Tokio runtime |
| src/bili/client.rs | BiliApi 与 Transport trait、HttpTransport、WBI/appsign、二维码 SVG、Cookie 解析、B 站 REST API |
| src/state.rs | AppState：登录会话、二维码 key/TTL、0600 配置（Unix）、房间号回退、房间/分区映射、推流码内存状态 |
| src/danmu.rs | DanmuHub：wss 连接、认证包、30 秒心跳、zlib/brotli 帧递归解码、重连退避、统计与 SSE 广播 |
| src/commands.rs | CommandContext、dispatch、20 条 schema、describe_commands、build_registry；全部后端操作唯一入口 |
| src/api.rs | axum Router、camelCase→kebab-case 映射、body 限流、安全中间件、SSE、静态资源、端口重试 |
| web/src/lib/api.ts | 前后端唯一 HTTP 契约与 TypeScript 类型 |
| web/src/hooks/* | 健康、会话、房间、分区、弹幕 SSE、配置、命令的浏览器状态 |
| web/src/components/* | shadcn 五个业务面板与通用 UI |
| src/assets.rs | include_dir! 嵌入 web/dist，SPA 无扩展名回落 index.html |
| build.rs | 声明 web/dist 重编译触发；dist 缺失时生成占位 index.html 并告警 |
| scripts/smoke.mjs | release 二进制的 --version/--help/--schema/health/commands 冒烟 |
| scripts/mcp-smoke.mjs | stdio JSON-RPC 的 MCP initialize/tools/list/health/安全门/未知工具回归，并以 --schema 校验工具面逐项一致、以 policy.rs/README/MCP.md 锁定 Agent 白名单及活体放行/拒绝 |
| scripts/web-smoke.mjs | Web 控制台 HTTP/静态资源/SPA/API/Host/Origin/SSE 端到端回归 |
| scripts/browser-smoke.mjs | 真实 Chrome CDP 渲染回归：React/shadcn 挂载、五个 Tab 的鼠标/键盘交互、Geist/Tailwind 计算样式与 JS 异常捕获 |

## 启动链路

main.rs 同步调用 SharedConfig::load、BiliApi::new、AppState::new、DanmuHub::new(state.clone())、CommandContext::new。同步 reqwest blocking 客户端不能在 #[tokio::main] 上下文里构造，否则会触发 Tokio 的 "Cannot drop a runtime in a context where blocking is not allowed"；因此只有 Web 分支创建 Runtime 并 block_on(api::serve(...))。

CLI/TUI 使用 policy::Local（放行 T0/T1），MCP 使用 policy::Agent（放行 T0 与白名单 T1）。build_registry 先 Registry::new().with_policy(policy) 再注册 handler；lilyco 的安全门在 register 时捕获策略，所以不能用 run_registry_with_policy 对已注册的策略再包一层。Round 10 新增的 cfg(test) 回归直接取得两套运行时注册表的 handler 并调用，验证 20 条命令均有 handler、health/danmu-stop 双策略放行、Local 的 login-logout 到达 dispatch、Agent 的 5 个被拒 T1 在 dispatch 前返回 AppError::Safety。Web 是有意的人机回环控制台：它直接复用 commands::dispatch 并放进 tokio::task::spawn_blocking（不经 Registry Agent 安全门），另有 loopback Host/POST Origin 校验；Router::oneshot 回归用 Agent 拒绝的 config-set 证明该路由确实抵达 dispatch，避免阻塞网络 I/O 卡住 Tokio。

## 命令面

20 条命令覆盖 health、session、login-qrcode、login-poll、login-logout、room、partitions、title、area、announcement、live-start、live-stop、stream-key、danmu-start、danmu-stop、danmu-status、danmu-send、config、config-set、commands。commands 自身 hidden=true，不进 MCP tools/list 可见列表，但 CLI/API 可查询完整表。`scripts/mcp-smoke.mjs` 把这份一致性作为 CI 回归：`--schema` 与 MCP tools/list 的名称、描述、T1 标注、inputSchema 参数类型与 required 必须逐项一致；`src/policy.rs` 的 7 个白名单命令、README.md、docs/MCP.md 与 5 个拒绝 T1 命令也必须逐项一致，并活体验证 `danmu-stop` 放行 / `login-logout` 拒绝。对应 Rust 单测 `agent_whitelist_matches_registry_tiers_and_gate` 穷举注册表分级与 Agent 策略，未来 T2/T3 命令一律拒绝。

没有使用 #[derive(App)]：宏生成的 from_args 只能获取 HashMap<String,Value>，无法注入共享 AppState/DanmuHub。命令用 RegisteredCommand::new(CommandSchema{...}).with_handler(...) 手工注册，handler 捕获 CommandContext 克隆。

## 状态与隐私

AppState 内部用 Arc<RwLock<Core>> 保存 BiliApi、SharedConfig、LoginSession、PendingQr、RtmpInfo 与 WbiKeys。public_session 只输出 uid、uname、face、level、roomId、persisted、csrfPresent，不输出 Cookie/CSRF。poll_qrcode 在发网络请求前校验 pending key 与 180 秒 TTL；登录成功从 Set-Cookie 精确取 bili_jct、DedeUserID；只有 remember_login 为真时才写 config.json（Unix 显式 chmod 0600；Windows 依赖用户配置目录 ACL、不做 chmod）。

start_live 返回 (addr, code) 后只把明文交给 state.set_rtmp 存内存；命令响应和日志使用 mask(&code)。stream-key 未登录且无推流码时返回空 addr/code 与 masked=true；有推流码时才要求登录，按 reveal flag 决定明文或打码。

## Web 与 SSE

api.rs 的 router 注册 22 条契约路由，/api/config 同时 get(config).post(config_set)，然后 with_state、fallback(static_file)，最后 layer(security_mw) 让安全门覆盖已注册 API 与 fallback 静态资源/未知路径。security_mw 先小写并严格解析 Host/Origin authority：只接受 localhost、四段数值 127.0.0.0/8 或方括号 [::1]，可选端口必须是合法 u16；POST 的 Origin 必须带 http(s) scheme、无 userinfo/path/query/fragment，且 authority 同样严格回环。127.evil.example 等 DNS 后缀与畸形端口一律拒绝；body_json 限 1 MiB，空体转 {}，非法 JSON 返回 400 与统一错误体。

danmu_events 从 DanmuHub::subscribe 拿 unbounded receiver，用 async_stream 把每条 Value 序列化为 SSE data。没有 ready 首帧：前端 EventSource 的 onmessage 会直接 JSON.parse。DanmuHub::stop 广播 running=false 的系统消息，便于无 B 站连接时验证 SSE。静态资源按扩展名设 MIME，/assets/ 长缓存 immutable（JS/CSS/woff2 均经 HTTP 字节比对），其余 no-cache；未知 /api 返回「未知接口」，缺失静态返回「页面不存在」。

## 弹幕协议

connect_once 用 BiliApi::danmu_info 返回的完整 wss URL，不再重复拼接端口。握手带 User-Agent、Origin、buvid3 与 DedeUserID Cookie；认证包 operation=7，body 为 {uid,roomid,protover:3,platform:"web",type:2,key:token}；16 字节大端包头为 len,16,1,operation,1；心跳 operation=2 每 30 秒；底层 TcpStream 读超时 31 秒。接收循环按 proto_ver=2 用 flate2 zlib、proto_ver=3 用 brotli 递归解压，operation=3 解析人气，operation=5 解析 JSON cmd；支持 DANMU_MSG、SEND_GIFT、INTERACT_WORD、ENTRY_EFFECT、COMBO_SEND。重连退避 min(5*2^(attempt-1),60)，generation 防止重启竞态。

## 跨平台编译

lilyco 以 default-features=false 引入，默认 feature 是 ["tui", "browser"]，其中 browser = ["dep:webbrowser"]；headless = [] 不启用任何额外能力。webbrowser 是 optional 目标依赖，放在 cfg(not(any(target_os="android",target_os="ios"))) 下；api.rs 的自动打开浏览器再加 #[cfg(all(feature = "browser", not(any(target_os="android",target_os="ios"))))] 门控。这样 Android/iOS 不拉 webbrowser，headless 构建也不拉 TUI、jni、AppKit/Foundation 与 chrono。Android CI 用 --no-default-features --features headless 分别构建 aarch64-linux-android 与 x86_64-linux-android，并设置 NDK 27.3.13750724（本机 r27d）对两个 target 的 CC/AR/LINKER；Windows CI 用 GitHub Actions 的 MSVC 环境。CI workflow 已通过 PyYAML 校验，源码已推送到 https://github.com/lilyco-42/lyblive 并在 GitHub Actions 运行；publish job 在 v* 标签推送时汇总五份 runner 产物并生成 GitHub Release 与 SHA256SUMS。desktop 矩阵在 release 构建后运行 node scripts/smoke.mjs、node scripts/mcp-smoke.mjs、node scripts/web-smoke.mjs 与 node scripts/browser-smoke.mjs，覆盖 Linux/macOS/Windows 的 CLI、MCP Agent 与 Web HTTP 契约；android-headless 仅做交叉编译并分别上传两个 ABI 的 release 二进制，Android 二进制无法在 runner 上直接运行。 所有 `actions/upload-artifact@v4` 步骤都设 `if-no-files-found: error`；`scripts/ci-contract.mjs` 在两个 job 中校验工作流结构，并在 `pnpm build` 后加 `--assets` 校验真实 React/CSS/5 个 woff2 字体、在 cargo release 后加 `--embedded` 逐字节校验二进制内嵌资源，避免某个平台静默缺产物、把 build.rs 占位页嵌入二进制或沿用陈旧资产。

本机另用 Zig 0.17.1 + llvm-dlltool 交叉链接 x86_64-pc-windows-gnu headless release，Wine 下跑通 CLI、MCP 与 Web 控制台；用 NDK r27d 直接编译 aarch64-linux-android 与 x86_64-linux-android headless release（只链接 libdl/libm/libc），在 Android 17 模拟器上分别跑通 CLI、MCP 与 Web 控制台；用 Zig 与仅链接期解析 -liconv 的 libiconv.tbd stub 产出 aarch64-apple-darwin 与 x86_64-apple-darwin headless Mach-O，以 file、llvm-otool、llvm-nm 静态验证最低系统版本与动态依赖。六份产物分别覆盖 Linux x86_64、Windows GNU、Android 两种 ABI 与 macOS 两种架构，说明无 TUI、无 webbrowser 的移动端/headless 链路可用。Windows GNU 与 Android 产物都不是签名安装包/APK；macOS 产物未在真实 macOS 执行、未签名/公证；Windows MSVC 与 macOS 原生构建/运行验证由 GitHub Actions 的 windows-latest / macos-latest runner 执行。

## 测试策略

- 单元层：util 的 MD5/mask/form_encode，settings 的默认不落盘与 Unix 0600（config_file_is_private 仅 cfg(unix)），policy 的 Agent 白名单与注册表分级的穷举一致性，BiliApi 的 WBI 向量/appsign/Cookie/二维码/错误码，danmu 的包头、命令解析、brotli 递归、300 条上限。
- API 层：严格 loopback Host/Origin authority（localhost、数值 127/8、[::1]、合法 u16 端口）、camelCase 映射、空/坏 JSON、统一错误体、静态路径与 SPA 回落；Router::oneshot 回归覆盖非回环 Host 403、8 组恶意 Host/Origin 403 与 [::1]/127/8 正例，防止 127.evil.example 等 DNS 后缀绕过。
- 集成层：33 项 Rust 测试，CLI --schema/health/session/config/commands，MCP initialize/tools/list/tools/call 与高危拒绝，真实 axum 服务的 HTTP/静态/SSE/Host/Origin 冒烟，pnpm lint/build，release 二进制的四个 Node smoke 与 ci-contract.mjs 的磁盘/内嵌资产逐字节回归；四者均接受可选 argv[2] 二进制路径并可设 LYBLIVE_SMOKE_WRAPPER=wine，便于校验归档中跨平台产物。
- AI 面：node scripts/mcp-smoke.mjs 通过 stdio JSON-RPC 断言 initialize(2024-11-05)、tools/list 的 19 个可见工具与隐藏 commands 不外泄、health 放行、live-start 被 Agent 安全门拒绝、未知工具 -32602；并以同一二进制的 --schema 为单一事实来源，逐项比对 20 条命令与 19 个工具的名称集合、hidden 排除、描述与 T1 标注、参数名/类型/说明/required（text→string、flag→boolean、number→number），防止单一注册表在 Agent 面漂移。产物归档将 `policy.rs`、`README.md`、`MCP.md` 与 `mcp-smoke.mjs` 平铺，脚本会自动在源码树或归档根目录定位契约源，因此解包后也可独立执行。脚本按响应 id 归集（lilyco worker 可能乱序），可在三桌面 OS 原生运行，也可用 LYBLIVE_SMOKE_WRAPPER=wine 本机验证 Windows 产物。
- 真实浏览器面：node scripts/browser-smoke.mjs 以 Chrome --remote-debugging-pipe 的 fd3/fd4 收发 CDP 消息，无额外监听端口；先装 Runtime.exceptionThrown/Log.entryAdded/consoleAPICalled 监听再导航，用可信鼠标和键盘事件逐项切到五个 shadcn Tab（Radix 对合成 DOM click 不响应），等待异步面板出现，并断言 Geist/Tailwind 计算样式、命令表、字体与无未捕获异常。CI 用 browser-actions/setup-chrome@v2 的 chrome-path 显式传给 LYBLIVE_BROWSER_BIN，Linux/Windows GNU 本机已验证。
- Web 面：node scripts/web-smoke.mjs 用纯 Node stdlib 启动 release 二进制的 --web --no-browser，自动选择空闲回环端口，断言 /api/health、首页 #root、构建产物 JS/CSS/5 个 woff2 字体、SPA 回落、favicon、缺失字体 404，并在有磁盘资源时逐字节比对 HTTP 响应、/api/session 不吐凭据、/api/stream-key 默认打码、/api/commands 20 条、非回环 Host 403、跨站 POST Origin 403、127.* DNS 后缀/userinfo/畸形端口 Host/Origin 403、数值 127/8 与 [::1] 正例和 /api/danmu/events 的系统 SSE 事件；不联网、不读凭据，CI 三桌面 OS 原生运行，本机亦可用 LYBLIVE_SMOKE_WRAPPER=wine 验证 Windows 产物。
- 外部 B 站写接口只做打桩与协议解析验证；不拿用户凭据做真实开播或发弹幕。

## 凭据持久化的平台差异（Round 7 审计）

`src/settings.rs` 的 `write_file` 只在 `#[cfg(unix)]` 下用 `OpenOptionsExt::mode(0o600)` 创建文件、并在写后 `set_permissions(0o600)`；`config_file_is_private` 单测同样只在 `cfg(unix)` 下断言 mode。Windows 没有 POSIX mode，代码不做显式 ACL 改写：config.json 落在 `directories::BaseDirs` 给出的用户配置目录（通常为 `%APPDATA%\lyblive`），由该目录继承的 NTFS ACL 限制访问。CLI `--help` 中的「权限为 0600」是 Unix 语义，不代表 Windows 执行了 chmod；README 的配置与安全段已同步说明。

五个 Node 契约/冒烟脚本只依赖 Node 标准库（`node:path` / `node:net` / `node:child_process`），二进制候选同时覆盖 `lyblive` 与 `lyblive.exe`；`web-smoke.mjs` 在 win32 下用 `child.kill()` 而非 POSIX 进程组信号，`browser-smoke.mjs` 的 Chrome 在 POSIX 独立进程组内 SIGTERM/SIGKILL、Windows 用 taskkill /T /F 清理整棵进程树，`LYBLIVE_SMOKE_WRAPPER=wine` 可在本机复用 Windows GNU 产物。`web/pnpm-lock.yaml` 含 oxlint、rolldown、tailwindcss-oxide、lightningcss 与 typescript 的 darwin/win32 原生可选绑定，CI 的 `node-version: '22'` 满足 Vite 8、oxlint 与 @vitejs/plugin-react 的 `>=22.12.0` 引擎要求。本机无 macOS SDK 与 MSVC 头文件，Windows MSVC / macOS 原生构建仍须远端 CI 验证。 本机共享 target-dir 场景必须显式设置 CARGO_TARGET_DIR，使 cargo 与 smoke 指向同一二进制；ci-contract.mjs --embedded 与 web-smoke.mjs 的字节比对会捕获陈旧内嵌资源。 产物归档另自带扁平 `./assets/` 的 9 份构建资产；`--embedded --all-artifacts` 只从脚本所在归档目录读取 `assets/` 与 `bin/`，不借用上级目录的同名资源，避免空转或误判。

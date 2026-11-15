# lyblive MCP 协议

lyblive --mcp 启动 lilyco 的 MCP stdio 服务。每行一个 JSON-RPC 2.0 请求；服务支持 initialize、ping、tools/list、tools/call、notifications/initialized，EOF 后会等待已启动 worker 把响应写完。协议版本为 2024-11-05，serverInfo 来自 lilyco 0.3.0。

## 启动

~~~bash
LYBLIVE_CONFIG_HOME=/tmp/lyblive-mcp-config lyblive --mcp
~~~

MCP 使用 Agent 安全策略，而不是 Web/CLI 的 Local 策略。它不改变本地配置文件内容，也不输出 Cookie、CSRF 或推流密钥明文。

## initialize

请求：

~~~json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
~~~

响应要点：

~~~json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"lilyco","version":"0.3.0"}}}
~~~

## tools/list

请求：

~~~json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
~~~

返回 19 个可见工具；内部 commands 命令 hidden=true，不列出。T0 工具描述保持原文，T1 工具描述追加 " [safety: T1 confirm]"。inputSchema 来自 CommandSchema.to_json_schema()，正文 type 为 object，属性名与 CLI 长参数一致，例如 area-id、room-id、remember-login。`scripts/mcp-smoke.mjs` 以同一二进制的 `--schema` 为单一事实来源，逐项校验 20 条命令与 19 个工具的名称集合、hidden 排除、描述与 T1 标注、参数名/类型/说明/required；脚本还读取 `src/policy.rs` 的 `AGENT_ALLOWED`，与 README.md、本文档的白名单列表和 `tools/list` 可见 T1 集合逐项比对，拒绝集必须恰为 5 个命令；任何漂移都会让三桌面 CI 失败。

## tools/call 只读命令

请求：

~~~json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"health","arguments":{}}}
~~~

响应要点：

~~~json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"backend\":\"lilyco\",\"name\":\"lyblive\",\"ok\":true,\"version\":\"0.1.0\"}"}],"isError":false}}
~~~

## tools/call 高危命令被拒绝

请求：

~~~json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"live-start","arguments":{"area-id":1}}}
~~~

响应要点：

~~~json
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"安全门: 命令 live-start 分级为 T1 confirm：Agent 调用面未放行（请用 Web 或 CLI）"}],"isError":true}}
~~~

安全门发生在 handler 执行前，因此不会请求 B 站 startLive 接口。

## Agent 白名单

允许：所有 T0 只读命令，以及 T1 的 login-qrcode、login-poll、danmu-start、danmu-stop、title、area、announcement。

拒绝：live-start、live-stop、danmu-send、config-set、login-logout 这 5 个 T1 命令，以及未来任何 T2/T3 命令。白名单与 src/policy.rs、README.md 由 mcp-smoke.mjs 三方逐项校验。拒绝文案统一为「Agent 调用面未放行（请用 Web 或 CLI）」。开停播、发弹幕、修改「记住登录」应由人在 Web 二次确认或显式 CLI 命令中执行。

## 参数与错误

tools/call 先执行 CommandSchema.validate_args：必填 Text 不能为空，Flag 必须是布尔，Number 必须是数字并遵守 min/max。未知工具返回 JSON-RPC error code -32602 与 "unknown tool: <name>"；handler 错误把 AppError 的中文说明放进 result.content[0].text 并置 isError=true。

## 给 Agent 的建议流程

1. 先 tools/list，记录每个工具的 name、description 与 inputSchema。
2. 用 health、session、room、partitions、danmu-status 等 T0 工具判断状态。
3. 需要扫码登录时调用 login-qrcode，把 qrSvg 展示给用户，再用 login-poll 轮询；不要在日志里打印 Cookie。
4. 只在用户明确授权后调用白名单内的标题、分区、公告或弹幕监听命令。
5. 开播、停播、发弹幕和持久化凭据设置不通过 MCP；引导用户在 Web 控制台或 CLI 完成。

## 自动化回归

配套的 `node scripts/browser-smoke.mjs` 用真实 Chrome 的 `--remote-debugging-pipe` 渲染 Web 控制台，验证五个 shadcn Tab 与命令表在人机界面中可用；它不调用 MCP 工具，也不改变 Agent 安全门。

`node scripts/mcp-smoke.mjs` 用纯 Node 通过 stdio JSON-RPC 对已编译二进制做契约回归，不联网、不读取凭据：断言 initialize 的 protocolVersion、tools/list 的 19 个可见工具与隐藏 commands 不外泄、health 放行、live-start 被 Agent 安全门拒绝、未知工具 -32602；新增白名单内 `danmu-stop` 活体放行与白名单外 `login-logout` 活体拒绝。并以同一二进制的 `--schema` 逐项比对工具名称、描述、安全级别标注与 inputSchema 参数类型/required（text→string、flag→boolean、number→number），同时把 `src/policy.rs` 白名单、README.md、本文档和 7 允许 / 5 拒绝的 T1 集合逐项锁定。脚本按响应 id 归集（lilyco 的 worker 可能乱序返回），跨平台可在 Linux/macOS/Windows 原生运行；本机也可用 `LYBLIVE_SMOKE_WRAPPER=wine` 验证 Windows 产物。CI 的 desktop 矩阵在 cargo build --release 后运行该脚本；同时运行 `node scripts/web-smoke.mjs`，在相同三个桌面 OS 上回归 Web 控制台的 HTTP/静态资源/安全门/SSE 契约。Rust 侧另有 33 项测试（Round 14 增加严格回环 Host/Origin authority、端口及 8 组恶意 origin 活体断言）：`registered_handlers_enforce_runtime_policy_for_local_and_agent` 直接调用 Local/Agent 注册表 handler，证明安全门不是只存在于静态策略检查，而是在已注册 handler 执行前生效；`loopback_web_route_runs_agent_denied_t1_without_registry_gate` 证明 Web 回环路由按设计绕过该 Agent 门并抵达 `commands::dispatch`，供人在 Web 二次确认。CI 另有 `node scripts/ci-contract.mjs` 校验三个桌面 OS、Android 双 ABI、三份上传的 `error` 策略、严格 Host/Origin 解析器与浏览器进程清理，避免平台产物静默缺失或安全门回退；`ci-contract.mjs --assets/--embedded` 另锁定 JS/CSS/5 个 woff2 字体与编译产物内嵌字节一致。

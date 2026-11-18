mod api;
mod assets;
mod bili;
mod commands;
mod danmu;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "obs")]
mod obs;
mod policy;
mod settings;
mod state;
mod util;

use std::sync::Arc;

use crate::commands::CommandContext;
use crate::policy::{Agent, Local};
use crate::settings::SharedConfig;

const APP_NAME: &str = "lyblive";
const DEFAULT_PORT: u16 = 8769;
/// `--open` 默认跟随常驻服务端口（与 lyblive.service 一致），避开 8765 上的 AgentDock
const OPEN_DEFAULT_PORT: u16 = 8768;

/// 用 /api/health 判断端口上跑的是不是 lyblive（只用 std，不引入 HTTP 依赖）
fn is_lyblive(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::time::Duration;

    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(900)));
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body);
    body.contains("\"name\":\"lyblive\"") || body.contains("\"name\": \"lyblive\"")
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{APP_NAME} {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return Ok(());
    }

    #[cfg(feature = "obs")]
    {
        if args.iter().any(|a| a == "--obs-fix-dock") {
            obs::run_fix_dock()?;
            return Ok(());
        }
        if args.iter().any(|a| a == "--obs-install") {
            obs::run_install(obs::port_from_env())?;
            return Ok(());
        }
        if args.iter().any(|a| a == "--obs-status") {
            obs::run_status()?;
            return Ok(());
        }
        if args.iter().any(|a| a == "--obs-uninstall") {
            obs::run_uninstall()?;
            return Ok(());
        }
    }

    let config = SharedConfig::load();
    let state = state::AppState::new(bili::BiliApi::new(), config);
    let danmu = danmu::DanmuHub::new(state.clone());
    let ctx = CommandContext::new(state, danmu.clone());

    let ui = std::env::var("LILYCO_UI").ok();
    let ui = ui.as_deref();
    let mcp = args.iter().any(|a| a == "--mcp") || ui == Some("mcp");
    let open_only = args.iter().any(|a| a == "--open");
    #[cfg(feature = "desktop")]
    if args.iter().any(|a| a == "--float" || a == "--desktop") {
        let port = std::env::var("LYBLIVE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(OPEN_DEFAULT_PORT);
        return desktop::run(port);
    }

    let web = args.iter().any(|a| a == "--web" || a == "--gui")
        || open_only
        || (args.is_empty() && ui.is_none())
        || matches!(ui, Some("web" | "gui"));
    let tui = args.iter().any(|a| a == "--tui") || ui == Some("tui");

    if mcp {
        let registry = commands::build_registry(ctx, Arc::new(Agent));
        lilyco::serve_mcp(registry);
    } else if web {
        let port = std::env::var("LYBLIVE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(if open_only {
                OPEN_DEFAULT_PORT
            } else {
                DEFAULT_PORT
            });
        // --open：只有确认该端口上跑的就是 lyblive 才打开浏览器；
        // 端口被别的程序（如 AgentDock 占 8765）占用时明确报错，绝不盲目打开。
        if open_only {
            if is_lyblive(port) {
                let url = format!("http://127.0.0.1:{port}/");
                println!("lyblive 已在运行：{url}");
                #[cfg(feature = "browser")]
                let _ = webbrowser::open(&url);
                return Ok(());
            }
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                anyhow::bail!(
                    "端口 {port} 已被其它程序占用，且不是 lyblive。请用 LYBLIVE_PORT=<其它端口> 再试"
                );
            }
        }
        let open_browser = !args.iter().any(|a| a == "--no-browser");
        // 服务启动即自动开始弹幕监控（已登录时），避免每次重启都要手动点「开始监控」
        {
            let boot = danmu.clone();
            if let Err(err) = boot.start(None) {
                tracing::debug!(error = %err, "启动时自动开始弹幕监控失败（通常是未登录）");
            }
        }
        let runtime = tokio::runtime::Runtime::new()?;
        runtime.block_on(api::serve(api::ApiState { ctx, danmu }, port, open_browser))?;
    } else if tui {
        let registry = commands::build_registry(ctx, Arc::new(Local));
        lilyco::run_tui_registry(APP_NAME, registry);
    } else if args.is_empty() && ui == Some("cli") {
        print_help();
    } else {
        let registry = commands::build_registry(ctx, Arc::new(Local));
        lilyco::run_cli_registry(APP_NAME, registry);
    }
    Ok(())
}

fn print_help() {
    println!(
        "{APP_NAME} {}\n\nB 站直播助手：CLI / TUI / MCP / Web 共用一份命令注册表。\n\n用法:\n  {APP_NAME}                    启动本地 Web 控制台（默认 127.0.0.1:{DEFAULT_PORT}）\n  {APP_NAME} --web [--no-browser]\n  {APP_NAME} --open              打开 Web 控制台（已在跑则只开浏览器，无需 OBS）\n  {APP_NAME} --float             桌面悬浮弹幕层（托盘/常驻，Linux；需 --features desktop）\n  {APP_NAME} --mcp               作为 MCP stdio 服务（Agent 安全白名单）\n  {APP_NAME} --tui               启动终端交互界面\n  {APP_NAME} --obs-install      把 Web 控制台注册为 OBS 停靠面板（无需装 OBS 插件）\n  {APP_NAME} --obs-fix-dock     把已注册的面板修成浮动 360×760（OBS 退出后执行）\n  {APP_NAME} --obs-status       查看 OBS 停靠面板配置状态\n  {APP_NAME} --obs-uninstall    移除 OBS 停靠面板配置\n  {APP_NAME} <命令>             执行 CLI 子命令，例如 health
  {APP_NAME} --schema           导出 CLI/TUI/MCP 共用的命令 schema\n  {APP_NAME} --version|-V\n\n环境变量:\n  LYBLIVE_PORT                Web 监听端口\n  LYBLIVE_CONFIG_HOME         配置目录（默认 XDG 配置目录/lyblive）\n  LILYCO_UI=cli|tui|web|mcp   指定默认界面（cli 无参数时显示帮助）\n\n安全: 默认不持久化登录凭据；开启「记住登录」后凭据文件权限为 0600。推流密钥默认打码。",
        env!("CARGO_PKG_VERSION")
    );
}

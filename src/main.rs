mod api;
mod assets;
mod bili;
mod commands;
mod danmu;
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
const DEFAULT_PORT: u16 = 8765;

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
    let web = args.iter().any(|a| a == "--web" || a == "--gui")
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
            .unwrap_or(DEFAULT_PORT);
        let open_browser = !args.iter().any(|a| a == "--no-browser");
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
        "{APP_NAME} {}\n\nB 站直播助手：CLI / TUI / MCP / Web 共用一份命令注册表。\n\n用法:\n  {APP_NAME}                    启动本地 Web 控制台（默认 127.0.0.1:{DEFAULT_PORT}）\n  {APP_NAME} --web [--no-browser]\n  {APP_NAME} --mcp               作为 MCP stdio 服务（Agent 安全白名单）\n  {APP_NAME} --tui               启动终端交互界面\n  {APP_NAME} --obs-install      把 Web 控制台注册为 OBS 停靠面板（无需装 OBS 插件）\n  {APP_NAME} --obs-status       查看 OBS 停靠面板配置状态\n  {APP_NAME} --obs-uninstall    移除 OBS 停靠面板配置\n  {APP_NAME} <命令>             执行 CLI 子命令，例如 health
  {APP_NAME} --schema           导出 CLI/TUI/MCP 共用的命令 schema\n  {APP_NAME} --version|-V\n\n环境变量:\n  LYBLIVE_PORT                Web 监听端口\n  LYBLIVE_CONFIG_HOME         配置目录（默认 XDG 配置目录/lyblive）\n  LILYCO_UI=cli|tui|web|mcp   指定默认界面（cli 无参数时显示帮助）\n\n安全: 默认不持久化登录凭据；开启「记住登录」后凭据文件权限为 0600。推流密钥默认打码。",
        env!("CARGO_PKG_VERSION")
    );
}

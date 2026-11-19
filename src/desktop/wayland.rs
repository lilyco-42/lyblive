//! Wayland layer-shell 悬浮弹幕层：位于 KWin 全屏窗口之上，透明、默认鼠标穿透。
//!
//! GTK/X11 的 DOCK 窗口会被 KWin 的全屏层盖住（全屏游戏看不到弹幕）；layer-shell
//! 的 Overlay 层在全屏之上，是 KDE Wayland 下唯一可靠的层级。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};

use smithay_client_toolkit::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay_client_toolkit::reexports::calloop::EventLoop;
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::reexports::client::protocol::{
    wl_output, wl_region, wl_seat, wl_shm, wl_surface,
};
use smithay_client_toolkit::reexports::client::{
    globals::registry_queue_init, Connection, QueueHandle,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_registry, delegate_seat,
    delegate_shm,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{Capability, SeatHandler, SeatState},
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
    shm::{slot::SlotPool, Shm, ShmHandler},
};

const LANE_HEIGHT: i32 = 36;
const WIDTH: u32 = 960;
const HEIGHT: u32 = 144;
const FPS_MS: u64 = 16;
const LANES: usize = 4;

struct Flight {
    user: String,
    text: String,
    x: f64,
    lane: usize,
}

struct Content {
    flights: Vec<Flight>,
    last_ts: i64,
}

struct App {
    registry_state: RegistryState,
    shm_state: Shm,
    seat_state: SeatState,
    output_state: OutputState,
    pool: SlotPool,
    layer: LayerSurface,
    content: Arc<Mutex<Content>>,
    rx: mpsc::Receiver<(i64, String, String)>,
    visible: Arc<AtomicBool>,
    width: u32,
    height: u32,
}

impl App {
    fn tick(&mut self) {
        if self.width == 0 || self.height == 0 {
            return;
        }
        let stride = self.width as i32 * 4;
        let (buffer, canvas) = match self.pool.create_buffer(
            self.width as i32,
            self.height as i32,
            stride,
            wl_shm::Format::Argb8888,
        ) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("lyblive float: create_buffer 失败: {err}");
                return;
            }
        };
        {
            let mut content = self.content.lock().unwrap();
            while let Ok((ts, user, text)) = self.rx.try_recv() {
                if ts <= content.last_ts {
                    continue;
                }
                content.last_ts = ts;
                eprintln!("lyblive float(wayland): +1 user={user} text={text}");
                let lane = content.flights.len() % LANES;
                content.flights.push(Flight {
                    user,
                    text,
                    x: self.width as f64,
                    lane,
                });
                if content.flights.len() > 24 {
                    content.flights.remove(0);
                }
            }
            if std::env::var("LYBLIVE_FLOAT_DEMO").ok().as_deref() == Some("1")
                && content.flights.is_empty()
            {
                content.flights.push(Flight {
                    user: "演示".into(),
                    text: "全屏弹幕可见性".into(),
                    x: self.width as f64,
                    lane: 0,
                });
            }
            for flight in content.flights.iter_mut() {
                flight.x -= 3.2;
            }
            content.flights.retain(|flight| flight.x > -800.0);

            let surface = unsafe {
                cairo::ImageSurface::create_for_data_unsafe(
                    canvas.as_mut_ptr(),
                    cairo::Format::ARgb32,
                    self.width as i32,
                    self.height as i32,
                    stride,
                )
            };
            let surface = match surface {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("lyblive float: cairo surface 失败: {err}");
                    return;
                }
            };
            {
                let cr = match cairo::Context::new(&surface) {
                    Ok(value) => value,
                    Err(_) => return,
                };
                cr.set_operator(cairo::Operator::Source);
                cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
                let _ = cr.paint();
                cr.set_operator(cairo::Operator::Over);
                if self.visible.load(Ordering::SeqCst) {
                    for flight in &content.flights {
                        let y = (flight.lane as i32 * LANE_HEIGHT + LANE_HEIGHT - 8) as f64;
                        let mut x = flight.x;
                        if !flight.user.is_empty() {
                            let label = format!("{}：", flight.user);
                            x += draw_text(&cr, x, y, &label, (0.49, 0.83, 0.99));
                        }
                        draw_text(&cr, x, y, &flight.text, (1.0, 1.0, 1.0));
                    }
                }
                surface.flush();
            }
        }
        buffer.attach_to(self.layer.wl_surface()).ok();
        self.layer.commit();
    }
}

fn layout_for(cr: &cairo::Context, text: &str) -> pango::Layout {
    let layout = pangocairo::functions::create_layout(cr);
    layout.set_text(text);
    let mut font = pango::FontDescription::from_string("Sans Bold 22");
    font.set_size(22 * pango::SCALE);
    layout.set_font_description(Some(&font));
    layout
}

/// 用「四向黑色偏移 + 彩色正文」模拟描边，返回文字宽度。
fn draw_text(cr: &cairo::Context, x: f64, y: f64, text: &str, color: (f64, f64, f64)) -> f64 {
    let layout = layout_for(cr, text);
    let (width, height) = layout.pixel_size();
    let top = y - height as f64;
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.9);
    for (dx, dy) in [(-2.0, 0.0), (2.0, 0.0), (0.0, -2.0), (0.0, 2.0)] {
        cr.move_to(x + dx, top + dy);
        pangocairo::functions::show_layout(cr, &layout);
    }
    cr.set_source_rgba(color.0, color.1, color.2, 0.98);
    cr.move_to(x, top);
    pangocairo::functions::show_layout(cr, &layout);
    width as f64
}

impl CompositorHandler for App {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }

    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for App {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl SeatHandler for App {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wl_seat::WlSeat,
        _capability: Capability,
    ) {
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wl_seat::WlSeat,
        _capability: Capability,
    ) {
    }

    fn remove_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {
    }
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm_state
    }
}

impl LayerShellHandler for App {
    fn closed(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _layer: &LayerSurface) {
        std::process::exit(0);
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        let (width, height) = configure.new_size;
        if width > 0 && height > 0 {
            eprintln!("lyblive float: configure {width}x{height}");
            self.width = width;
            self.height = height;
        }
    }
}

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers![OutputState, SeatState];
}

delegate_compositor!(App);
delegate_output!(App);
delegate_seat!(App);
delegate_shm!(App);
delegate_layer!(App);
delegate_registry!(App);

smithay_client_toolkit::reexports::client::delegate_noop!(App: ignore wl_region::WlRegion);

pub fn run(port: u16) -> Result<()> {
    eprintln!("lyblive float: 使用 Wayland layer-shell");
    let conn = Connection::connect_to_env().map_err(|err| anyhow!("连接 Wayland 失败: {err}"))?;
    let (globals, event_queue) = registry_queue_init(&conn)?;
    let qh = event_queue.handle();

    let compositor_state =
        CompositorState::bind(&globals, &qh).map_err(|err| anyhow!("compositor 不可用: {err}"))?;
    let layer_shell =
        LayerShell::bind(&globals, &qh).map_err(|err| anyhow!("layer-shell 不可用: {err}"))?;
    let shm_state = Shm::bind(&globals, &qh).map_err(|err| anyhow!("shm 不可用: {err}"))?;
    let seat_state = SeatState::new(&globals, &qh);
    let output_state = OutputState::new(&globals, &qh);

    let surface = compositor_state.create_surface(&qh);
    let layer =
        layer_shell.create_layer_surface(&qh, surface, Layer::Overlay, Some("lyblive-float"), None);
    layer.set_anchor(Anchor::TOP);
    layer.set_margin(380, 0, 0, 0);
    layer.set_size(WIDTH, HEIGHT);
    layer.set_exclusive_zone(-1);
    layer.set_keyboard_interactivity(KeyboardInteractivity::None);

    // 空输入区域：鼠标事件直接穿透到下层（游戏/桌面）
    let region = compositor_state.wl_compositor().create_region(&qh, ());
    region.add(0, 0, 0, 0);
    layer.set_input_region(Some(&region));
    layer.commit();
    region.destroy();

    let pool = SlotPool::new((WIDTH * HEIGHT * 4) as usize, &shm_state)
        .map_err(|err| anyhow!("创建 shm pool 失败: {err}"))?;

    let visible = Arc::new(AtomicBool::new(true));
    let pass_through = Arc::new(AtomicBool::new(true));
    {
        let tray = crate::desktop::tray::Tray {
            visible: visible.clone(),
            pass_through: pass_through.clone(),
            port,
        };
        ksni::TrayService::new(tray).spawn();
    }

    let (tx, rx) = mpsc::channel::<(i64, String, String)>();
    {
        let url = format!("http://127.0.0.1:{port}/api/danmu/status");
        thread::spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
            {
                Ok(client) => client,
                Err(_) => return,
            };
            loop {
                thread::sleep(Duration::from_millis(1000));
                let Ok(resp) = client.get(&url).send() else {
                    continue;
                };
                let Ok(body) = resp.json::<serde_json::Value>() else {
                    continue;
                };
                let Some(recent) = body.get("recent").and_then(|value| value.as_array()) else {
                    continue;
                };
                for item in recent {
                    let ts = item.get("ts").and_then(|value| value.as_i64()).unwrap_or(0);
                    let text = item
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let user = item
                        .get("user")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string();
                    if ts <= 0 || text.is_empty() {
                        continue;
                    }
                    if tx.send((ts, user, text)).is_err() {
                        return;
                    }
                }
            }
        });
    }

    let mut app = App {
        registry_state: RegistryState::new(&globals),
        shm_state,
        seat_state,
        output_state,
        pool,
        layer,
        content: Arc::new(Mutex::new(Content {
            flights: Vec::new(),
            last_ts: 0,
        })),
        rx,
        visible,
        width: WIDTH,
        height: HEIGHT,
    };

    let mut event_loop: EventLoop<App> =
        EventLoop::try_new().map_err(|err| anyhow!("创建事件循环失败: {err}"))?;
    let handle = event_loop.handle();
    WaylandSource::new(conn, event_queue)
        .insert(handle.clone())
        .map_err(|err| anyhow!("注册 wayland source 失败: {err}"))?;
    handle
        .insert_source(
            Timer::from_duration(Duration::from_millis(FPS_MS)),
            |_, _, app: &mut App| {
                app.tick();
                TimeoutAction::ToDuration(Duration::from_millis(FPS_MS))
            },
        )
        .map_err(|err| anyhow!("注册定时器失败: {err}"))?;
    event_loop
        .run(None, &mut app, |_| {})
        .map_err(|err| anyhow!("事件循环退出: {err}"))?;
    Ok(())
}

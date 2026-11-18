//! 桌面悬浮弹幕层：透明、置顶、无边框、可拖动，独立于浏览器。
//!
//! 数据来自 `GET /api/danmu/status`（1 秒轮询），只把 `recent` 里新增的条目
//! 排进滚动队列；关闭浏览器/主界面不影响本窗口。
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use gtk::cairo;
use gtk::prelude::*;
use gtk::{gdk, glib};

/// 一条正在飞行的弹幕
struct Flight {
    user: String,
    text: String,
    x: f64,
    lane: usize,
    speed: f64,
}

struct State {
    flights: Vec<Flight>,
    lanes: usize,
    width: i32,
    height: i32,
    last_ts: i64,
    drag: Option<(f64, f64, i32, i32)>,
}

const FPS_MS: u64 = 16;

/// 设置窗口的输入区域：空区域 = 完全穿透（点击落到下层），None = 恢复默认。
fn set_pass_through(window: &gtk::Window, on: bool) {
    let Some(gdk_win) = window.window() else {
        return;
    };
    if on {
        // 空输入区域：所有点击直接落到下层窗口
        let empty = cairo::Region::create();
        gdk_win.input_shape_combine_region(&empty, 0, 0);
    } else {
        // 覆盖整个窗口：恢复可点击（此时才能拖动、双击等）
        let (width, height) = window.size();
        let full = cairo::Region::create_rectangle(&cairo::RectangleInt::new(
            0,
            0,
            width.max(1),
            height.max(1),
        ));
        gdk_win.input_shape_combine_region(&full, 0, 0);
    }
}
const LANE_HEIGHT: i32 = 36;
const POLL_MS: u64 = 1_000;

pub fn run(port: u16) -> Result<()> {
    // GTK3 在 Wayland 会话下默认走 Wayland backend，KWin 会忽略 set_decorated(false)；
    // 走 XWayland 才能用 _MOTIF_WM_HINTS + Dock 类型做真正的无边框悬浮层。
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    gtk::init().map_err(|e| anyhow!("GTK 初始化失败: {e}"))?;

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_keep_above(true);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    window.set_accept_focus(true);
    // Dock 类型在 KDE 下不加边框/阴影、不进任务栏，最接近「桌面歌词」的形态
    window.set_type_hint(gdk::WindowTypeHint::Dock);
    window.stick();
    window.set_default_size(960, LANE_HEIGHT * 4);
    window.set_position(gtk::WindowPosition::Center);

    // 透明背景（需要 RGBA visual + app_paintable）
    if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&window) {
        if let Some(visual) = screen.rgba_visual() {
            window.set_visual(Some(&visual));
        }
    }
    window.set_app_paintable(true);
    window.connect_draw(|_, cr| {
        cr.set_operator(cairo::Operator::Source);
        cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
        let _ = cr.paint();
        glib::Propagation::Proceed
    });

    let area = gtk::DrawingArea::new();
    window.add(&area);

    let lanes = 4usize;
    let state = Rc::new(RefCell::new(State {
        flights: Vec::new(),
        lanes,
        width: 960,
        height: LANE_HEIGHT * lanes as i32,
        last_ts: 0,
        drag: None,
    }));

    // 后台轮询新弹幕
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
                thread::sleep(Duration::from_millis(POLL_MS));
                let Ok(resp) = client.get(&url).send() else {
                    continue;
                };
                let Ok(body) = resp.json::<serde_json::Value>() else {
                    continue;
                };
                let Some(recent) = body.get("recent").and_then(|v| v.as_array()) else {
                    continue;
                };
                for item in recent {
                    let ts = item.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
                    let text = item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let user = item
                        .get("user")
                        .and_then(|v| v.as_str())
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

    // 消费新消息（在主线程里）
    {
        let state = state.clone();
        glib::timeout_add_local(Duration::from_millis(200), move || {
            while let Ok((ts, user, text)) = rx.try_recv() {
                let mut st = state.borrow_mut();
                if ts <= st.last_ts {
                    continue;
                }
                st.last_ts = ts;
                eprintln!("lyblive float: +1 user={user} text={text}");
                let lane = st.flights.len() % st.lanes;
                let start_x = st.width as f64;
                st.flights.push(Flight {
                    user,
                    text,
                    x: start_x,
                    lane,
                    speed: 3.2,
                });
                // 同时最多保留 24 条，避免长直播堆积
                if st.flights.len() > 24 {
                    st.flights.remove(0);
                }
            }
            glib::ControlFlow::Continue
        });
    }

    // 绘制
    {
        let state = state.clone();
        area.connect_draw(move |_, cr| {
            let st = state.borrow();
            // 全透明底
            cr.set_operator(cairo::Operator::Source);
            cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
            let _ = cr.paint();
            cr.set_operator(cairo::Operator::Over);

            for flight in &st.flights {
                let y = (flight.lane as i32 * LANE_HEIGHT + LANE_HEIGHT - 8) as f64;
                cr.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
                cr.set_font_size(22.0);

                // 名字（青色）与正文（白色）分段绘制，各自带黑描边
                let mut x = flight.x;
                if !flight.user.is_empty() {
                    let label = format!("{}：", flight.user);
                    cr.move_to(x, y);
                    cr.set_line_width(3.0);
                    cr.set_source_rgba(0.0, 0.0, 0.0, 0.85);
                    cr.text_path(&label);
                    let _ = cr.stroke_preserve();
                    cr.set_source_rgba(0.49, 0.83, 0.99, 0.98);
                    let _ = cr.fill();
                    if let Ok(ext) = cr.text_extents(&label) {
                        x += ext.x_advance();
                    }
                }

                cr.move_to(x, y);
                cr.set_line_width(3.0);
                cr.set_source_rgba(0.0, 0.0, 0.0, 0.85);
                cr.text_path(&flight.text);
                let _ = cr.stroke_preserve();
                cr.set_source_rgba(1.0, 1.0, 1.0, 0.98);
                let _ = cr.fill();
            }
            glib::Propagation::Proceed
        });
    }

    // 动画：每帧左移
    {
        let state = state.clone();
        let area = area.clone();
        glib::timeout_add_local(Duration::from_millis(FPS_MS), move || {
            {
                let mut st = state.borrow_mut();
                for flight in st.flights.iter_mut() {
                    flight.x -= flight.speed;
                }
                st.flights.retain(|f| f.x > -600.0);
            }
            area.queue_draw();
            glib::ControlFlow::Continue
        });
    }

    // 尺寸变化时同步宽度
    {
        let state = state.clone();
        area.connect_size_allocate(move |_, alloc| {
            let mut st = state.borrow_mut();
            st.width = alloc.width();
            st.height = alloc.height();
        });
    }

    // 拖动：按住任意位置拖窗口
    {
        let state = state.clone();
        let window = window.clone();
        area.add_events(gdk::EventMask::BUTTON_PRESS_MASK | gdk::EventMask::BUTTON_RELEASE_MASK);
        area.connect_button_press_event(move |_, ev| {
            if ev.button() == 1 {
                let (wx, wy) = window.position();
                state.borrow_mut().drag = Some((ev.root().0, ev.root().1, wx, wy));
            }
            glib::Propagation::Proceed
        });
    }
    {
        let state = state.clone();
        let window = window.clone();
        area.add_events(gdk::EventMask::POINTER_MOTION_MASK);
        area.connect_motion_notify_event(move |_, ev| {
            let drag = state.borrow().drag;
            if let Some((rx, ry, wx, wy)) = drag {
                let dx = ev.root().0 - rx;
                let dy = ev.root().1 - ry;
                window.move_(wx + dx as i32, wy + dy as i32);
            }
            glib::Propagation::Proceed
        });
    }
    {
        let state = state.clone();
        area.connect_button_release_event(move |_, _| {
            state.borrow_mut().drag = None;
            glib::Propagation::Proceed
        });
    }

    // 鼠标穿透：默认开启，避免挡住用户操作；托盘可切换（关闭后才能拖动窗口）
    let pass_through = Arc::new(AtomicBool::new(true));
    {
        let pt = pass_through.clone();
        let win = window.clone();
        window.connect_realize(move |_| {
            set_pass_through(&win, pt.load(Ordering::SeqCst));
        });
        let pt = pass_through.clone();
        let win = window.clone();
        glib::timeout_add_local(Duration::from_millis(250), move || {
            set_pass_through(&win, pt.load(Ordering::SeqCst));
            glib::ControlFlow::Continue
        });
    }

    // 托盘：关闭悬浮层/主界面后仍可从这里恢复
    let visible = Arc::new(AtomicBool::new(true));
    {
        let tray = crate::desktop::tray::Tray {
            visible: visible.clone(),
            pass_through: pass_through.clone(),
            port,
        };
        let service = ksni::TrayService::new(tray);
        service.spawn();
    }
    {
        let visible = visible.clone();
        let win = window.clone();
        glib::timeout_add_local(Duration::from_millis(250), move || {
            let want = visible.load(Ordering::SeqCst);
            if win.is_visible() != want {
                win.set_visible(want);
            }
            glib::ControlFlow::Continue
        });
    }

    window.show_all();
    gtk::main();
    Ok(())
}

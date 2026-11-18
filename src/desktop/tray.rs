//! 系统托盘（KDE StatusNotifierItem）：关闭悬浮/主界面后仍可从这里恢复。
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ksni::menu::StandardItem;

pub struct Tray {
    pub visible: Arc<AtomicBool>,
    /// 鼠标穿透：开启后点击直接落到下层窗口，悬浮层只负责显示
    pub pass_through: Arc<AtomicBool>,
    pub port: u16,
}

impl ksni::Tray for Tray {
    fn id(&self) -> String {
        "lyblive-float".into()
    }

    fn title(&self) -> String {
        "lyblive 弹幕".into()
    }

    fn icon_name(&self) -> String {
        "applications-multimedia".into()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        let next = !self.visible.load(Ordering::SeqCst);
        self.visible.store(next, Ordering::SeqCst);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        vec![
            StandardItem {
                label: "显示 / 隐藏悬浮弹幕".into(),
                activate: Box::new(|this: &mut Self| {
                    let next = !this.visible.load(Ordering::SeqCst);
                    this.visible.store(next, Ordering::SeqCst);
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: if self.pass_through.load(Ordering::SeqCst) {
                    "鼠标穿透：已开启（点击关闭，才能拖动窗口）".into()
                } else {
                    "鼠标穿透：已关闭（点击开启，不挡操作）".into()
                },
                activate: Box::new(|this: &mut Self| {
                    let next = !this.pass_through.load(Ordering::SeqCst);
                    this.pass_through.store(next, Ordering::SeqCst);
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "打开 Web 控制台".into(),
                activate: Box::new(|this: &mut Self| {
                    let _ = webbrowser::open(&format!("http://127.0.0.1:{}/", this.port));
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "退出 lyblive 悬浮层".into(),
                activate: Box::new(|_: &mut Self| std::process::exit(0)),
                ..Default::default()
            }
            .into(),
        ]
    }
}

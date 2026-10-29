//! macOS trackpad gestures: gesture.m reports when fingers start a new scroll, and Rust tells the
//! webview (`scrollGestureBegan`) so a swipe can move again while the last one's momentum runs.
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C" {
    fn atv_register_scroll_gesture_monitor();
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    APP.set(app.clone())
        .map_err(|_| "macOS scroll gesture monitor was installed more than once".to_owned())?;
    // setup executes on Tauri's native main thread, which is required by NSEvent monitors.
    unsafe { atv_register_scroll_gesture_monitor() };
    Ok(())
}

#[no_mangle]
pub extern "C" fn atv_scroll_gesture_began() {
    if let Some(app) = APP.get() {
        let _ = app.emit("scrollGestureBegan", ());
    }
}

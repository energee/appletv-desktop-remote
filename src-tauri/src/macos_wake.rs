//! macOS wake detection: wake.m observes NSWorkspaceDidWakeNotification and calls back into
//! Rust, which tells the webview (`powerResume`) to replace its stale Apple TV connection.
use std::sync::OnceLock;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C" {
    fn atv_register_wake_observer();
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    APP.set(app.clone())
        .map_err(|_| "macOS wake observer was installed more than once".to_owned())?;
    // setup executes on Tauri's native main thread, which is required by NSWorkspace.
    unsafe { atv_register_wake_observer() };
    Ok(())
}

#[no_mangle]
pub extern "C" fn atv_power_did_wake() {
    if let Some(app) = APP.get() {
        crate::desktop::notify_power_resume(app);
    }
}

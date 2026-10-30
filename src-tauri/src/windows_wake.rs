//! Windows counterpart of macos_wake.rs: reports resume from sleep as `powerResume`. The power
//! manager calls back on its own thread, so no window or message loop is needed.
use std::{ffi::c_void, ptr, sync::OnceLock};
use tauri::AppHandle;
use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    System::Power::{PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS},
    UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC},
};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Sent on every resume, whether or not a user is present (PBT_APMRESUMESUSPEND is not).
unsafe extern "system" fn power_changed(
    _context: *const c_void,
    event: u32,
    _setting: *const c_void,
) -> u32 {
    if event == PBT_APMRESUMEAUTOMATIC {
        if let Some(app) = APP.get() {
            crate::desktop::notify_power_resume(app);
        }
    }
    ERROR_SUCCESS
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    APP.set(app.clone())
        .map_err(|_| "Windows wake observer was installed more than once".to_owned())?;
    // Windows reads the parameters for as long as the registration lives, which is the whole
    // run, so they are leaked; the registration handle is never needed to unregister.
    let parameters = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(power_changed),
        Context: ptr::null_mut(),
    }));
    let mut registration = ptr::null_mut();
    let status = unsafe {
        PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            ptr::from_mut(parameters).cast(),
            &mut registration,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Cannot register for Windows resume notifications (error {status})"
        ));
    }
    Ok(())
}

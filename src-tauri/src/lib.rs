//! Tauri entry point: wires the plugins, the sidecar backend, tray and hotkeys, wake
//! observers, the macOS scroll gesture monitor, and the `backend_request` /
//! `desktop_action` commands the webview invokes.
mod backend;
mod backup;
mod desktop;
#[cfg(target_os = "macos")]
mod macos_gesture;
#[cfg(target_os = "macos")]
mod macos_wake;
mod vault;
#[cfg(windows)]
mod windows_wake;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn atv_round_window_corners(ns_window: *mut std::ffi::c_void, radius: f64);
}

use backend::Backend;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, ShortcutState};

#[tauri::command]
async fn backend_request(
    state: tauri::State<'_, Backend>,
    vault: tauri::State<'_, vault::Vault>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    match method.as_str() {
        "finishPair" | "finishCompanionPair" => {
            let companion_paired = method == "finishCompanionPair";
            if let Some(saved) = vault.retry_pending_pair(companion_paired)? {
                return serde_json::to_value(saved).map_err(|error| error.to_string());
            }
            let result = state.request(method, params).await?;
            if result.is_null() {
                Ok(Value::Null)
            } else {
                serde_json::to_value(vault.save_sidecar_pair(result, companion_paired)?)
                    .map_err(|error| error.to_string())
            }
        }
        "connect" | "reconnect" => {
            let identifier = params
                .as_object()
                .and_then(|params| params.get("identifier"))
                .and_then(Value::as_str)
                .ok_or("connect requires a saved device identifier")?;
            if params.as_object().is_none_or(|params| params.len() != 1) {
                return Err("Credentials may only be supplied by the native vault".into());
            }
            vault.clear_pending_pair()?;
            state
                .request(method, vault.connection_params(identifier)?)
                .await
        }
        "startPair" | "startCompanionPair" | "cancelCompanionPair" | "disconnect" => {
            vault.clear_pending_pair()?;
            state.request(method, params).await
        }
        _ => state.request(method, params).await,
    }
}

#[tauri::command]
async fn desktop_action(
    app: tauri::AppHandle,
    action: String,
    args: Value,
    context: tauri::State<'_, Arc<Mutex<Option<desktop::ContextMenuConfig>>>>,
    vault: tauri::State<'_, vault::Vault>,
) -> Result<Value, String> {
    desktop::desktop_action(app, action, args, context, vault).await
}

pub fn run() {
    let menu_context = Arc::new(Mutex::new(None::<desktop::ContextMenuConfig>));
    let application = tauri::Builder::default()
        .plugin(
            GlobalShortcutBuilder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        desktop::toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = desktop::show_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&menu_context))
        .manage(vault::Vault::native())
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            macos_wake::install(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            macos_gesture::install(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                // Same radius as windowEffects in tauri.conf.json; see corners.m.
                unsafe { atv_round_window_corners(window.ns_window()?, 16.0) };
            }
            // Wake reconnect is a convenience: the sidecar still reconnects after a dropped connection.
            #[cfg(windows)]
            if let Err(error) = windows_wake::install(app.handle()) {
                eprintln!("{error}");
            }
            // Never fails or blocks: a sidecar startup error is returned by backend requests.
            app.manage(Backend::start(app.handle()));
            desktop::setup(app.handle(), Arc::clone(&menu_context))
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            if matches!(event, WindowEvent::Focused(false)) {
                desktop::hide_on_blur(window.app_handle().clone());
            }
        })
        .invoke_handler(tauri::generate_handler![backend_request, desktop_action])
        .build(tauri::generate_context!())
        .expect("error while building Apple TV Remote");

    application.run(|app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(backend) = app.try_state::<Backend>() {
                backend.shutdown();
            }
        }
        _ => {}
    });
}

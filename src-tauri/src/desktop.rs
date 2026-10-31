//! Native desktop behaviour behind the `desktop_action` command: the main and hotkey windows,
//! tray icon and context menu, global hotkeys (saved in the 0.5.x hotkey.txt), and credential
//! files.
use crate::backup::write_private;
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

const MAIN_WINDOW: &str = "main";
const HOTKEY_WINDOW: &str = "hotkey";
const DEFAULT_SHORTCUTS: &[&str] = &["SUPER+SHIFT+R", "SUPER+CONTROL+R"];

/// Set while one of the app's native file dialogs is open. The dialog takes focus from the
/// main window, which must stay visible to show the import or export result.
static FILE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct RegisteredHotkeys(Mutex<Vec<Shortcut>>);

#[derive(Default)]
struct BlurHide {
    generation: AtomicU64,
    pending: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuConfig {
    devices: Vec<DeviceMenuItem>,
    ui_mode: String,
    always_on_top: bool,
    #[serde(default)]
    speakers: Vec<SpeakerMenuItem>,
}

/// An AirPlay speaker; `id` is the output ID that picking it sends back with `toggleSpeaker`.
#[derive(Clone, Deserialize)]
pub struct SpeakerMenuItem {
    label: String,
    id: String,
    checked: bool,
}

/// A saved Apple TV: its name, and the identifier it is saved under, which picking it sends back.
#[derive(Clone, Deserialize)]
pub struct DeviceMenuItem {
    label: String,
    identifier: String,
    checked: bool,
}

#[derive(serde::Serialize, Clone)]
struct ContextMenuAction {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<String>,
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "Main window is unavailable".to_owned())
}

fn emit_action(app: &AppHandle, action: impl Into<String>, payload: Option<String>) {
    let _ = app.emit(
        "context-menu-action",
        ContextMenuAction {
            action: action.into(),
            payload,
        },
    );
}

pub fn show_window(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Logical top-left that puts the window next to the tray icon, clamped to the icon's monitor,
/// plus that monitor's scale. The window drops below an icon in the top half of its monitor
/// (the macOS menu bar) and rises above one in the bottom half (a bottom Windows taskbar).
/// macOS reports the icon rect and each monitor in that monitor's own physical pixels, so a
/// 1x external display and a 2x Retina display can't share one physical space: find the
/// icon's monitor by its centre, convert to logical points there, and position in points.
/// Windows positions in physical pixels, so the caller scales back with the returned scale.
fn tray_window_position(
    icon: (tauri::PhysicalPosition<f64>, tauri::PhysicalSize<f64>),
    window: tauri::LogicalSize<f64>,
    monitors: &[(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, f64)],
) -> (tauri::LogicalPosition<f64>, f64) {
    let (origin, size) = icon;
    let (cx, cy) = (origin.x + size.width / 2.0, origin.y + size.height / 2.0);
    let monitor = monitors.iter().find(|(p, s, _)| {
        cx >= p.x as f64
            && cx < p.x as f64 + s.width as f64
            && cy >= p.y as f64
            && cy < p.y as f64 + s.height as f64
    });
    // ponytail: no monitor holds the icon only if macOS reports nonsense; assume 1x.
    let scale = monitor.map_or(1.0, |(_, _, scale)| *scale);
    let below_middle = monitor.is_some_and(|(p, s, _)| cy >= p.y as f64 + s.height as f64 / 2.0);
    let mut x = cx / scale - window.width / 2.0;
    let mut y = if below_middle {
        origin.y / scale - window.height
    } else {
        (origin.y + size.height) / scale
    };
    if let Some((p, s, _)) = monitor {
        let (left, top) = (p.x as f64 / scale, p.y as f64 / scale);
        let (right, bottom) = (left + s.width as f64 / scale, top + s.height as f64 / scale);
        x = x.clamp(left, (right - window.width).max(left));
        y = y.clamp(top, (bottom - window.height).max(top));
    }
    (tauri::LogicalPosition::new(x, y), scale)
}

pub fn hide_window(app: &AppHandle) -> Result<(), String> {
    main_window(app)?.hide().map_err(|error| error.to_string())
}

pub fn toggle_window(app: &AppHandle) {
    let result = main_window(app).and_then(|window| {
        if window.is_visible().map_err(|error| error.to_string())? {
            window.hide().map_err(|error| error.to_string())
        } else {
            show_window(app)
        }
    });
    if result.is_ok() {
        let _ = app.emit("shortcutWin", ());
    }
}

/// The Electron app's support directory, exactly as it chose it: `%APPDATA%` whenever set, on
/// every platform, else `$HOME/Library/Application Support` on macOS and `$HOME/.local/share`
/// elsewhere (ignoring XDG_DATA_HOME). The folder keeps the old "ATV Remote" name on purpose.
fn legacy_support_dir(
    appdata: Option<PathBuf>,
    home: Option<PathBuf>,
    macos: bool,
) -> Option<PathBuf> {
    let base = appdata.or_else(|| {
        home.map(|home| {
            home.join(if macos {
                "Library/Application Support"
            } else {
                ".local/share"
            })
        })
    })?;
    Some(base.join("ATV Remote"))
}

fn legacy_hotkey_path() -> Result<PathBuf, String> {
    // Electron tested `process.env.APPDATA ||`, so an empty value counts as unset.
    let appdata = std::env::var_os("APPDATA").filter(|value| !value.is_empty());
    legacy_support_dir(
        appdata.map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
        cfg!(target_os = "macos"),
    )
    .map(|dir| dir.join("hotkey.txt"))
    .ok_or_else(|| "Neither APPDATA nor HOME is set".to_owned())
}

/// hotkey.txt holds comma-separated hotkeys; only the first is editable in the hotkey window.
fn read_hotkey_file() -> Result<String, String> {
    match fs::read_to_string(legacy_hotkey_path()?) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn hotkey_list(contents: &str) -> Vec<&str> {
    contents
        .split(',')
        .map(str::trim)
        .filter(|shortcut| !shortcut.is_empty())
        .collect()
}

fn read_hotkeys() -> Result<Vec<String>, String> {
    Ok(hotkey_list(&read_hotkey_file()?)
        .into_iter()
        .map(normalize_shortcut)
        .collect())
}

/// File contents after saving `combo`. The hotkey window edits only the first hotkey, so any
/// extra ones added to the file by hand are kept.
fn saved_hotkeys(existing: &str, combo: &str) -> String {
    let mut hotkeys = hotkey_list(existing);
    if hotkeys.len() > 1 {
        hotkeys[0] = combo;
        hotkeys.join(",")
    } else {
        combo.to_owned()
    }
}

fn normalize_shortcut(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "super" | "command" | "cmd" | "meta" => "SUPER".to_owned(),
            "ctrl" | "control" => "CONTROL".to_owned(),
            "alt" | "option" => "ALT".to_owned(),
            "shift" => "SHIFT".to_owned(),
            key => key.to_ascii_uppercase(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn parsed_hotkeys(contents: &str) -> Result<Vec<Shortcut>, String> {
    let mut shortcuts = Vec::new();
    for value in hotkey_list(contents) {
        let shortcut = normalize_shortcut(value)
            .parse::<Shortcut>()
            .map_err(|error| format!("Invalid shortcut {value}: {error}"))?;
        if !shortcuts.contains(&shortcut) {
            shortcuts.push(shortcut);
        }
    }
    Ok(shortcuts)
}

/// Register replacements before retiring old bindings. Track each successful OS operation so
/// a later failure can restore the previous set, including a failed persistence operation.
fn replace_hotkeys(
    current: &mut Vec<Shortcut>,
    desired: &[Shortcut],
    mut register: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    fn reconcile(
        current: &mut Vec<Shortcut>,
        desired: &[Shortcut],
        register: &mut impl FnMut(Shortcut) -> Result<(), String>,
        unregister: &mut impl FnMut(Shortcut) -> Result<(), String>,
    ) -> Result<(), String> {
        for shortcut in desired {
            if !current.contains(shortcut) {
                register(*shortcut)?;
                current.push(*shortcut);
            }
        }
        for index in (0..current.len()).rev() {
            if !desired.contains(&current[index]) {
                unregister(current[index])?;
                current.remove(index);
            }
        }
        Ok(())
    }
    let previous = current.clone();
    let result =
        reconcile(current, desired, &mut register, &mut unregister).and_then(|()| persist());
    if let Err(error) = result {
        return match reconcile(current, &previous, &mut register, &mut unregister) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}. Could not fully restore previous shortcuts: {rollback}"
            )),
        };
    }
    Ok(())
}

/// Startup is best effort; interactive saves use replace_hotkeys and propagate conflicts.
fn register_hotkeys(app: &AppHandle) {
    let shortcuts = read_hotkeys().unwrap_or_else(|error| {
        eprintln!("Cannot read saved hotkeys: {error}");
        Vec::new()
    });
    let state = app.state::<RegisteredHotkeys>();
    let mut current = state.0.lock().unwrap();
    let mut all_registered = !shortcuts.is_empty();
    for value in &shortcuts {
        let result = value
            .parse::<Shortcut>()
            .map_err(|error| error.to_string())
            .and_then(|shortcut| {
                if !current.contains(&shortcut) {
                    app.global_shortcut()
                        .register(shortcut)
                        .map_err(|error| error.to_string())?;
                    current.push(shortcut);
                }
                Ok(())
            });
        if let Err(error) = result {
            eprintln!("Cannot register hotkey {value}: {error}");
            all_registered = false;
        }
    }
    if !all_registered {
        for value in DEFAULT_SHORTCUTS {
            let shortcut = value.parse::<Shortcut>().expect("valid default shortcut");
            if current.contains(&shortcut) {
                continue;
            }
            match app.global_shortcut().register(shortcut) {
                Ok(()) => current.push(shortcut),
                Err(error) => eprintln!("Cannot register hotkey {value}: {error}"),
            }
        }
    }
}

fn change_hotkey(app: &AppHandle, combo: Option<&str>) -> Result<(), String> {
    let state = app.state::<RegisteredHotkeys>();
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Hotkey settings are unavailable")?;
    let path = legacy_hotkey_path()?;
    let contents = match combo {
        Some(combo) => Some(saved_hotkeys(&read_hotkey_file()?, combo)),
        None => None,
    };
    let desired = match &contents {
        Some(contents) => parsed_hotkeys(contents)?,
        None => parsed_hotkeys(&DEFAULT_SHORTCUTS.join(","))?,
    };
    if desired.is_empty() {
        return Err("Choose a shortcut before saving".into());
    }
    replace_hotkeys(
        &mut current,
        &desired,
        |shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| error.to_string())
        },
        |shortcut| {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|error| error.to_string())
        },
        || {
            if let Some(contents) = contents {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                write_private(&path, &contents).map_err(|error| error.to_string())
            } else {
                match fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error.to_string()),
                }
            }
        },
    )
}

fn open_hotkey_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(HOTKEY_WINDOW) {
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(app, HOTKEY_WINDOW, WebviewUrl::App("hotkey.html".into()))
        .title("Change Hotkey")
        .inner_size(400.0, 340.0)
        .resizable(false)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn menu_item(app: &AppHandle, id: &str, label: &str) -> Result<MenuItem<tauri::Wry>, String> {
    MenuItem::with_id(app, id, label, true, None::<&str>).map_err(|error| error.to_string())
}

fn check_item(
    app: &AppHandle,
    id: &str,
    label: &str,
    checked: bool,
) -> Result<tauri::menu::CheckMenuItem<tauri::Wry>, String> {
    tauri::menu::CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>)
        .map_err(|error| error.to_string())
}

fn build_device_menu(
    app: &AppHandle,
    config: &ContextMenuConfig,
) -> Result<Submenu<tauri::Wry>, String> {
    let devices_menu = Submenu::new(app, "Devices", true).map_err(|error| error.to_string())?;
    for (index, device) in config.devices.iter().enumerate() {
        devices_menu
            .append(&check_item(
                app,
                &format!("device:{index}"),
                &device.label,
                device.checked,
            )?)
            .map_err(|error| error.to_string())?;
    }
    if !config.devices.is_empty() {
        devices_menu
            .append(&PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    devices_menu
        .append(&menu_item(app, "pair-new", "Pair new device...")?)
        .map_err(|error| error.to_string())?;
    devices_menu
        .append(&menu_item(app, "repair-current", "Re-pair current device")?)
        .map_err(|error| error.to_string())?;
    Ok(devices_menu)
}

fn build_context_menu(
    app: &AppHandle,
    config: &ContextMenuConfig,
) -> Result<Menu<tauri::Wry>, String> {
    let devices_menu = build_device_menu(app, config)?;

    let appearance_menu =
        Submenu::new(app, "Appearance", true).map_err(|error| error.to_string())?;
    for (id, label, mode) in [
        ("theme-system", "Follow system settings", "systemmode"),
        ("theme-dark", "Dark mode", "darkmode"),
        ("theme-light", "Light mode", "lightmode"),
    ] {
        appearance_menu
            .append(&check_item(app, id, label, config.ui_mode == mode)?)
            .map_err(|error| error.to_string())?;
    }

    let root = Menu::new(app).map_err(|error| error.to_string())?;
    root.append(&devices_menu)
        .map_err(|error| error.to_string())?;
    // Shown once a scan, after connecting, has found AirPlay speakers.
    if !config.speakers.is_empty() {
        let speakers_menu =
            Submenu::new(app, "Speakers", true).map_err(|error| error.to_string())?;
        for (index, speaker) in config.speakers.iter().enumerate() {
            speakers_menu
                .append(&check_item(
                    app,
                    &format!("speaker:{index}"),
                    &speaker.label,
                    speaker.checked,
                )?)
                .map_err(|error| error.to_string())?;
        }
        root.append(&speakers_menu)
            .map_err(|error| error.to_string())?;
    }
    root.append(&check_item(
        app,
        "always-on-top",
        "Always on-top",
        config.always_on_top,
    )?)
    .map_err(|error| error.to_string())?;
    root.append(&PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    root.append(&appearance_menu)
        .map_err(|error| error.to_string())?;
    root.append(&menu_item(app, "settings", "Settings")?)
        .map_err(|error| error.to_string())?;
    root.append(&PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    root.append(&menu_item(app, "check-for-updates", "Check for Updates…")?)
        .map_err(|error| error.to_string())?;
    root.append(
        &PredefinedMenuItem::about(app, Some("About Apple TV Remote"), None)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    root.append(&menu_item(app, "quit", "Quit")?)
        .map_err(|error| error.to_string())?;
    Ok(root)
}
pub fn show_context_menu(
    app: &AppHandle,
    config: ContextMenuConfig,
    popup: bool,
) -> Result<(), String> {
    let menu = build_context_menu(app, &config)?;
    app.tray_by_id("tray")
        .ok_or_else(|| "Tray icon is unavailable".to_owned())?
        .set_menu(Some(menu.clone()))
        .map_err(|error| error.to_string())?;
    if popup {
        main_window(app)?
            .popup_menu(&menu)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn handle_menu_event(
    app: &AppHandle,
    id: &str,
    context: &Arc<Mutex<Option<ContextMenuConfig>>>,
) {
    let action = match id {
        "pair-new" => {
            let _ = show_window(app);
            Some(("pairNew", None))
        }
        "repair-current" => {
            let _ = show_window(app);
            Some(("repairCurrent", None))
        }
        "always-on-top" => main_window(app)
            .ok()
            .and_then(|window| window.is_always_on_top().ok())
            .map(|value| ("toggleAlwaysOnTop", Some((!value).to_string()))),
        "theme-system" => Some(("setTheme", Some("systemmode".into()))),
        "theme-dark" => Some(("setTheme", Some("darkmode".into()))),
        "theme-light" => Some(("setTheme", Some("lightmode".into()))),
        "settings" => Some(("openSettings", None)),
        "check-for-updates" => {
            let _ = show_window(app);
            Some(("openUpdates", None))
        }
        "quit" => {
            app.exit(0);
            None
        }
        item if item.starts_with("device:") => context.lock().ok().and_then(|config| {
            config.as_ref().and_then(|config| {
                item.strip_prefix("device:")
                    .and_then(|index| index.parse::<usize>().ok())
                    .and_then(|index| config.devices.get(index))
                    .map(|device| ("selectDevice", Some(device.identifier.clone())))
            })
        }),
        item if item.starts_with("speaker:") => context.lock().ok().and_then(|config| {
            config.as_ref().and_then(|config| {
                item.strip_prefix("speaker:")
                    .and_then(|index| index.parse::<usize>().ok())
                    .and_then(|index| config.speakers.get(index))
                    .map(|speaker| ("toggleSpeaker", Some(speaker.id.clone())))
            })
        }),
        _ => None,
    };
    if let Some((action, payload)) = action {
        emit_action(app, action, payload);
    }
}

pub fn setup(
    app: &AppHandle,
    context: Arc<Mutex<Option<ContextMenuConfig>>>,
) -> Result<(), String> {
    app.manage(RegisteredHotkeys::default());
    app.manage(BlurHide::default());
    let tray_icon =
        tauri::image::Image::from_bytes(include_bytes!("../../app/images/IconTemplate.png"))
            .map_err(|error| error.to_string())?;
    let default_menu = build_context_menu(
        app,
        &ContextMenuConfig {
            devices: Vec::new(),
            ui_mode: "systemmode".into(),
            always_on_top: false,
            speakers: Vec::new(),
        },
    )?;
    TrayIconBuilder::with_id("tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&default_menu)
        .show_menu_on_left_click(false)
        .tooltip("Apple TV Remote")
        .on_menu_event({
            let context = Arc::clone(&context);
            move |app, event| handle_menu_event(app, event.id().as_ref(), &context)
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                if let Ok(window) = main_window(tray.app_handle()) {
                    if let (Ok(scale), Ok(size), Ok(monitors)) = (
                        window.scale_factor(),
                        window.outer_size(),
                        window.available_monitors(),
                    ) {
                        let monitors: Vec<_> = monitors
                            .iter()
                            .map(|m| (*m.position(), *m.size(), m.scale_factor()))
                            .collect();
                        // Both values are already physical; the scale argument is unused.
                        let icon = (
                            rect.position.to_physical::<f64>(1.0),
                            rect.size.to_physical::<f64>(1.0),
                        );
                        let (position, icon_scale) =
                            tray_window_position(icon, size.to_logical(scale), &monitors);
                        // Windows positions in physical pixels: use the icon monitor's scale,
                        // not the window's, which may still be another monitor's.
                        #[cfg(windows)]
                        let position = position.to_physical::<f64>(icon_scale);
                        #[cfg(not(windows))]
                        let _ = icon_scale;
                        let _ = window.set_position(position);
                    }
                }
                toggle_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    register_hotkeys(app);
    Ok(())
}

pub async fn desktop_action(
    app: AppHandle,
    action: String,
    args: Value,
    context: tauri::State<'_, Arc<Mutex<Option<ContextMenuConfig>>>>,
    vault: tauri::State<'_, crate::vault::Vault>,
) -> Result<Value, String> {
    match action.as_str() {
        "loadDevices" => serde_json::to_value(vault.devices()?).map_err(|error| error.to_string()),
        "activeDevice" => serde_json::to_value(vault.active()?).map_err(|error| error.to_string()),
        "selectDevice" => {
            let identifier = match args.get("identifier") {
                Some(Value::Null) => None,
                Some(Value::String(identifier)) => Some(identifier.clone()),
                _ => return Err("selectDevice requires an identifier or null".into()),
            };
            vault.select(identifier)?;
            Ok(Value::Null)
        }
        "removeDevice" => {
            let identifier = args
                .get("identifier")
                .and_then(Value::as_str)
                .ok_or("Missing device identifier")?;
            vault.remove(identifier)?;
            Ok(Value::Null)
        }
        "migrateDevices" => {
            vault.migrate(
                args.get("devices")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                args.get("active")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            )?;
            Ok(Value::Null)
        }
        "isDevelopment" => Ok(Value::Bool(cfg!(debug_assertions))),
        "restart" => {
            if let Some(backend) = app.try_state::<crate::backend::Backend>() {
                backend.shutdown();
            }
            app.restart();
        }
        "showWindow" => {
            show_window(&app)?;
            Ok(Value::Null)
        }
        "hideWindow" => {
            hide_window(&app)?;
            Ok(Value::Null)
        }
        "quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        "setAlwaysOnTop" => {
            let value = args
                .get("value")
                .and_then(Value::as_bool)
                .ok_or("setAlwaysOnTop requires boolean args.value")?;
            main_window(&app)?
                .set_always_on_top(value)
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "loadHotkeyWindow" => {
            open_hotkey_window(&app)?;
            Ok(Value::Null)
        }
        "closeHotkeyWindow" => {
            if let Some(window) = app.get_webview_window(HOTKEY_WINDOW) {
                window.close().map_err(|error| error.to_string())?;
            }
            Ok(Value::Null)
        }
        "loadHotkey" => Ok(read_hotkeys()?
            .first()
            .cloned()
            .map(Value::String)
            .unwrap_or(Value::Null)),
        "saveHotkey" => {
            let combo = args
                .get("combo")
                .and_then(Value::as_str)
                .ok_or("saveHotkey requires string args.combo")?;
            change_hotkey(&app, Some(combo))?;
            Ok(Value::Null)
        }
        "resetHotkey" => {
            change_hotkey(&app, None)?;
            Ok(Value::Null)
        }
        // wry cancels webview downloads, so the credential backup is saved natively.
        "exportCredentials" => {
            let preferences = serde_json::from_value(
                args.get("settings")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )
            .map_err(|error| error.to_string())?;
            let contents = vault.export_backup(preferences)?;
            let picked = file_dialog(&app, || {
                rfd::FileDialog::new()
                    .set_file_name("atv-remote-credentials.json")
                    .add_filter("JSON", &["json"])
                    .save_file()
            })
            .await?;
            let Some(path) = picked else {
                return Ok(Value::Bool(false));
            };
            write_private(&path, &contents).map_err(|error| error.to_string())?;
            Ok(Value::Bool(true))
        }
        // Picked natively like the export, so the window doesn't hide behind the dialog.
        "importCredentials" => {
            let picked = file_dialog(&app, || {
                rfd::FileDialog::new()
                    .add_filter("JSON", &["json"])
                    .pick_file()
            })
            .await?;
            let Some(path) = picked else {
                return Ok(Value::Null);
            };
            let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
            serde_json::to_value(vault.import_backup(&contents)?).map_err(|error| error.to_string())
        }
        "showDeviceMenu" => {
            let config: ContextMenuConfig =
                serde_json::from_value(args.clone()).map_err(|error| error.to_string())?;
            let x = args
                .get("x")
                .and_then(Value::as_f64)
                .ok_or("Missing menu x")?;
            let y = args
                .get("y")
                .and_then(Value::as_f64)
                .ok_or("Missing menu y")?;
            *context
                .lock()
                .map_err(|_| "Context menu state lock poisoned")? = Some(config.clone());
            main_window(&app)?
                .popup_menu_at(
                    &build_device_menu(&app, &config)?,
                    tauri::LogicalPosition::new(x, y),
                )
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "showContextMenu" => {
            let popup = args.get("popup").and_then(Value::as_bool).unwrap_or(false);
            let config: ContextMenuConfig =
                serde_json::from_value(args).map_err(|error| error.to_string())?;
            *context
                .lock()
                .map_err(|_| "Context menu state lock poisoned")? = Some(config.clone());
            show_context_menu(&app, config, popup)?;
            Ok(Value::Null)
        }
        unsupported => Err(format!("Unsupported desktop action: {unsupported}")),
    }
}

/// Runs a native file dialog on the main thread (macOS requires it; commands run on async
/// workers) while `FILE_DIALOG_OPEN` keeps hide-on-blur from hiding the main window.
async fn file_dialog<T: Send + 'static>(
    app: &AppHandle,
    dialog: impl FnOnce() -> Option<T> + Send + 'static,
) -> Result<Option<T>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    FILE_DIALOG_OPEN.store(true, Ordering::SeqCst);
    let picked = match app.run_on_main_thread(move || {
        let _ = sender.send(dialog());
    }) {
        Ok(()) => receiver
            .await
            .map_err(|_| "File dialog closed unexpectedly".to_owned()),
        Err(error) => Err(error.to_string()),
    };
    FILE_DIALOG_OPEN.store(false, Ordering::SeqCst);
    picked
}

pub fn handle_focus_change(app: &AppHandle, focused: bool) {
    let Some(state) = app.try_state::<BlurHide>() else {
        return;
    };
    let generation = state
        .generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let mut pending = state.pending.lock().unwrap();
    if let Some(task) = pending.take() {
        task.abort();
    }
    if focused {
        return;
    }
    let app = app.clone();
    *pending = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let check = app.clone();
        let _ = app.run_on_main_thread(move || {
            if check.state::<BlurHide>().generation.load(Ordering::Acquire) != generation {
                return;
            }
            if let Ok(window) = main_window(&check) {
                if window.is_always_on_top().unwrap_or(false)
                    || FILE_DIALOG_OPEN.load(Ordering::SeqCst)
                    || window.is_focused().unwrap_or(true)
                {
                    return;
                }
                let _ = window.hide();
            }
        });
    }));
}

/// Tells the webview the system woke, so it replaces the stale Apple TV connection. macOS
/// (macos_wake.rs) and Windows (windows_wake.rs) report wake; Linux has no wake hook yet.
#[cfg(any(target_os = "macos", windows))]
pub fn notify_power_resume(app: &AppHandle) {
    let _ = app.emit("powerResume", ());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

    // Built-in Retina (2x) with a 1x external display above it, as macOS reports them.
    fn monitors() -> Vec<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)> {
        vec![
            (
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(3420, 2224),
                2.0,
            ),
            (
                PhysicalPosition::new(-1544, -1200),
                PhysicalSize::new(3840, 1200),
                1.0,
            ),
        ]
    }

    fn place(x: f64, y: f64, w: f64, h: f64) -> LogicalPosition<f64> {
        tray_window_position(
            (PhysicalPosition::new(x, y), PhysicalSize::new(w, h)),
            LogicalSize::new(280.0, 420.0),
            &monitors(),
        )
        .0
    }

    #[test]
    fn tray_window_drops_below_icon_on_1x_external_display() {
        // Icon top sits 4px above the monitor edge; the window must still land under it.
        assert_eq!(
            place(1533.0, -1204.0, 34.0, 38.0),
            LogicalPosition::new(1410.0, -1166.0)
        );
    }

    #[test]
    fn tray_window_drops_below_icon_on_2x_retina_display() {
        assert_eq!(
            place(3000.0, 0.0, 60.0, 48.0),
            LogicalPosition::new(1375.0, 24.0)
        );
    }

    #[test]
    fn tray_window_is_clamped_to_the_icon_monitor_edge() {
        assert_eq!(
            place(3380.0, 0.0, 40.0, 48.0),
            LogicalPosition::new(1430.0, 24.0)
        );
    }

    #[test]
    fn context_menu_config_reads_speakers_and_defaults_to_none() {
        let config: ContextMenuConfig = serde_json::from_value(serde_json::json!({
            "devices": [],
            "uiMode": "systemmode",
            "alwaysOnTop": false,
            "speakers": [{ "label": "Kitchen", "id": "psi-kitchen", "checked": true }],
        }))
        .unwrap();
        assert_eq!(config.speakers[0].id, "psi-kitchen");
        assert!(config.speakers[0].checked);
        let config: ContextMenuConfig = serde_json::from_value(serde_json::json!({
            "devices": [],
            "uiMode": "systemmode",
            "alwaysOnTop": false,
        }))
        .unwrap();
        assert!(config.speakers.is_empty());
    }

    #[test]
    fn context_menu_config_reads_each_devices_identifier() {
        // Picking a device sends back the identifier it is saved under, not its name.
        let config: ContextMenuConfig = serde_json::from_value(serde_json::json!({
            "devices": [{ "label": "Living Room", "identifier": "tv", "checked": true }],
            "uiMode": "darkmode",
            "alwaysOnTop": false,
            "popup": true,
        }))
        .unwrap();
        assert_eq!(config.devices[0].label, "Living Room");
        assert_eq!(config.devices[0].identifier, "tv");
    }

    #[test]
    fn tray_window_rises_above_a_bottom_taskbar_icon() {
        // Windows: a 1.5x panel with the taskbar, and so the tray icon, along the bottom.
        let (position, scale) = tray_window_position(
            (
                PhysicalPosition::new(1992.0, 1560.0),
                PhysicalSize::new(36.0, 60.0),
            ),
            LogicalSize::new(280.0, 420.0),
            &[(
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(2880, 1620),
                1.5,
            )],
        );
        assert_eq!(position, LogicalPosition::new(1200.0, 620.0));
        assert_eq!(
            position.to_physical::<f64>(scale),
            PhysicalPosition::new(1800.0, 930.0)
        );
    }

    #[test]
    fn tray_window_uses_the_icon_monitor_scale_on_mixed_dpi_windows() {
        // A 1x monitor right of a 1.5x one; the icon sits at its bottom-right corner.
        let (position, scale) = tray_window_position(
            (
                PhysicalPosition::new(4780.0, 1040.0),
                PhysicalSize::new(24.0, 40.0),
            ),
            LogicalSize::new(280.0, 420.0),
            &[
                (
                    PhysicalPosition::new(0, 0),
                    PhysicalSize::new(2880, 1620),
                    1.5,
                ),
                (
                    PhysicalPosition::new(2880, 0),
                    PhysicalSize::new(1920, 1080),
                    1.0,
                ),
            ],
        );
        assert_eq!(scale, 1.0);
        assert_eq!(position, LogicalPosition::new(4520.0, 620.0));
    }

    #[test]
    fn hotkey_directory_prefers_appdata_on_every_platform() {
        let appdata = Some(PathBuf::from("/appdata"));
        let home = Some(PathBuf::from("/home/me"));
        for macos in [true, false] {
            assert_eq!(
                legacy_support_dir(appdata.clone(), home.clone(), macos),
                Some(PathBuf::from("/appdata/ATV Remote"))
            );
        }
        assert_eq!(
            legacy_support_dir(None, home.clone(), true),
            Some(PathBuf::from(
                "/home/me/Library/Application Support/ATV Remote"
            ))
        );
        assert_eq!(
            legacy_support_dir(None, home, false),
            Some(PathBuf::from("/home/me/.local/share/ATV Remote"))
        );
        assert_eq!(legacy_support_dir(None, None, false), None);
    }

    #[test]
    fn saving_a_hotkey_keeps_extra_comma_separated_hotkeys() {
        assert_eq!(saved_hotkeys("", "Super+Shift+A"), "Super+Shift+A");
        assert_eq!(
            saved_hotkeys("Super+Shift+R\n", "Super+Shift+A"),
            "Super+Shift+A"
        );
        assert_eq!(
            saved_hotkeys(" Super+Shift+R , Ctrl+Alt+T,", "Super+Shift+A"),
            "Super+Shift+A,Ctrl+Alt+T"
        );
    }

    #[test]
    fn a_conflicting_replacement_preserves_working_shortcuts_and_settings() {
        use std::cell::{Cell, RefCell};
        let old = parsed_hotkeys("Super+Shift+R,Ctrl+Alt+T").unwrap();
        let desired = parsed_hotkeys("Super+Shift+A,Super+Shift+B,Ctrl+Alt+T").unwrap();
        let blocked = desired[1];
        let registered = RefCell::new(old.clone());
        let persisted = Cell::new(false);
        let mut current = old.clone();
        let result = replace_hotkeys(
            &mut current,
            &desired,
            |shortcut| {
                if shortcut == blocked {
                    return Err("Shortcut is already in use".into());
                }
                registered.borrow_mut().push(shortcut);
                Ok(())
            },
            |shortcut| {
                registered.borrow_mut().retain(|value| *value != shortcut);
                Ok(())
            },
            || {
                persisted.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!persisted.get());
        assert_eq!(current, old);
        assert_eq!(*registered.borrow(), old);
    }

    #[test]
    fn a_failed_hotkey_save_restores_the_previous_registered_set() {
        use std::cell::RefCell;
        let old = parsed_hotkeys("Super+Shift+R,Ctrl+Alt+T").unwrap();
        let desired = parsed_hotkeys("Super+Shift+A,Ctrl+Alt+T").unwrap();
        let registered = RefCell::new(old.clone());
        let mut current = old.clone();
        let result = replace_hotkeys(
            &mut current,
            &desired,
            |shortcut| {
                let mut registered = registered.borrow_mut();
                if registered.contains(&shortcut) {
                    return Err("Duplicate shortcut registration".into());
                }
                registered.push(shortcut);
                Ok(())
            },
            |shortcut| {
                registered.borrow_mut().retain(|value| *value != shortcut);
                Ok(())
            },
            || Err("Cannot save hotkey settings".into()),
        );
        assert!(result.is_err());
        assert_eq!(current.len(), old.len());
        assert!(old.iter().all(|shortcut| current.contains(shortcut)));
        assert_eq!(registered.borrow().len(), old.len());
        assert!(old
            .iter()
            .all(|shortcut| registered.borrow().contains(shortcut)));
    }

    #[test]
    fn a_successful_hotkey_replacement_keeps_unchanged_extra_bindings() {
        use std::cell::{Cell, RefCell};
        let mut current = parsed_hotkeys("Super+Shift+R,Ctrl+Alt+T").unwrap();
        let desired = parsed_hotkeys("Super+Shift+A,Ctrl+Alt+T").unwrap();
        let registered = RefCell::new(current.clone());
        let persisted = Cell::new(false);
        replace_hotkeys(
            &mut current,
            &desired,
            |shortcut| {
                let mut registered = registered.borrow_mut();
                if registered.contains(&shortcut) {
                    return Err("Duplicate shortcut registration".into());
                }
                registered.push(shortcut);
                Ok(())
            },
            |shortcut| {
                registered.borrow_mut().retain(|value| *value != shortcut);
                Ok(())
            },
            || {
                persisted.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(persisted.get());
        assert_eq!(registered.borrow().len(), desired.len());
        assert!(desired
            .iter()
            .all(|shortcut| registered.borrow().contains(shortcut)));
        assert_eq!(current.len(), desired.len());
        assert!(desired.iter().all(|shortcut| current.contains(shortcut)));
    }
    #[test]
    fn legacy_command_aliases_preserve_the_registered_shortcut() {
        let expected = "Super+Shift+R".parse::<Shortcut>().unwrap();
        for saved in [
            "Super+Shift+R",
            "Command+Shift+R",
            "Cmd+Shift+R",
            "META+SHIFT+R",
        ] {
            assert_eq!(
                normalize_shortcut(saved).parse::<Shortcut>().unwrap(),
                expected
            );
        }
        assert_eq!(
            normalize_shortcut("Command+Control+R")
                .parse::<Shortcut>()
                .unwrap(),
            "Super+Ctrl+R".parse::<Shortcut>().unwrap()
        );
    }
}

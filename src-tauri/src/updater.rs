//! Signed application update checks, verified downloads, and explicit installation.
use crate::backend::Backend;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const SETTINGS_FILE: &str = "updater-settings.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    revision: u64,
    current_version: String,
    status: UpdateStatus,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
    auto_check: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum UpdateStatus {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckAdmission {
    Start,
    Ignore,
    Recover(UpdateStatus),
}

fn check_admission(
    busy: bool,
    has_update: bool,
    status: UpdateStatus,
    has_download: bool,
) -> CheckAdmission {
    if busy {
        CheckAdmission::Ignore
    } else if has_update && status == UpdateStatus::Error {
        CheckAdmission::Recover(if has_download {
            UpdateStatus::Ready
        } else {
            UpdateStatus::Available
        })
    } else if has_update {
        CheckAdmission::Ignore
    } else {
        CheckAdmission::Start
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    auto_check: bool,
}

struct Inner {
    state: UpdateState,
    update: Option<Arc<Update>>,
    download: Option<Vec<u8>>,
    busy: bool,
}

pub struct Updater {
    inner: Mutex<Inner>,
}

impl Updater {
    pub fn new(app: &AppHandle) -> Self {
        let auto_check = load_settings(app);
        Self {
            inner: Mutex::new(Inner {
                state: UpdateState {
                    revision: 0,
                    current_version: app.package_info().version.to_string(),
                    status: UpdateStatus::Idle,
                    version: None,
                    notes: None,
                    downloaded: 0,
                    total: None,
                    error: None,
                    auto_check,
                },
                update: None,
                download: None,
                busy: false,
            }),
        }
    }

    pub fn snapshot(&self) -> Result<UpdateState, String> {
        self.inner
            .lock()
            .map(|inner| inner.state.clone())
            .map_err(|_| "Updater state lock poisoned".to_owned())
    }

    fn publish(&self, app: &AppHandle, change: impl FnOnce(&mut Inner)) {
        let state = match self.inner.lock() {
            Ok(mut inner) => {
                change(&mut inner);
                inner.state.revision = inner.state.revision.saturating_add(1);
                inner.state.clone()
            }
            Err(_) => return,
        };
        let _ = app.emit("updater-state", state);
    }

    fn record_progress(
        &self,
        app: &AppHandle,
        chunk: usize,
        total: Option<u64>,
        last_event: &mut Instant,
    ) {
        let now = Instant::now();
        let state = match self.inner.lock() {
            Ok(mut inner) => {
                inner.state.downloaded = inner.state.downloaded.saturating_add(chunk as u64);
                inner.state.total = total;
                inner.state.revision = inner.state.revision.saturating_add(1);
                if now.duration_since(*last_event) < Duration::from_millis(100) {
                    None
                } else {
                    *last_event = now;
                    Some(inner.state.clone())
                }
            }
            Err(_) => None,
        };
        if let Some(state) = state {
            let _ = app.emit("updater-state", state);
        }
    }

    pub fn set_auto_check(&self, app: &AppHandle, value: bool) -> Result<UpdateState, String> {
        let state = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Updater state lock poisoned")?;
            save_settings(app, value)?;
            inner.state.auto_check = value;
            inner.state.revision = inner.state.revision.saturating_add(1);
            inner.state.clone()
        };
        let _ = app.emit("updater-state", state.clone());
        Ok(state)
    }

    pub fn check(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let recovered = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Updater state lock poisoned")?;
            match check_admission(
                inner.busy,
                inner.update.is_some(),
                inner.state.status,
                inner.download.is_some(),
            ) {
                CheckAdmission::Start => {
                    inner.busy = true;
                    None
                }
                CheckAdmission::Ignore => return Ok(()),
                CheckAdmission::Recover(status) => {
                    inner.state.status = status;
                    inner.state.error = None;
                    inner.state.revision = inner.state.revision.saturating_add(1);
                    Some(inner.state.clone())
                }
            }
        };
        if let Some(state) = recovered {
            let _ = app.emit("updater-state", state);
            return Ok(());
        }
        self.publish(&app, |inner| {
            inner.state.status = UpdateStatus::Checking;
            inner.state.error = None;
            inner.state.downloaded = 0;
            inner.state.total = None;
        });
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let result = app
                .updater_builder()
                .on_before_exit({
                    let app = app.clone();
                    move || {
                        if let Some(backend) = app.try_state::<Backend>() {
                            backend.shutdown();
                        }
                    }
                })
                .build()
                .map_err(|error| error.to_string());
            let result = match result {
                Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
                Err(error) => Err(error),
            };
            match result {
                Ok(Some(update)) => updater.publish(&app, |inner| {
                    inner.download = None;
                    inner.state.status = UpdateStatus::Available;
                    inner.state.version = Some(update.version.clone());
                    inner.state.notes = update.body.clone();
                    inner.update = Some(Arc::new(update));
                    inner.state.downloaded = 0;
                    inner.state.total = None;
                    inner.state.error = None;
                    inner.busy = false;
                }),
                Ok(None) => updater.publish(&app, |inner| {
                    inner.state.status = UpdateStatus::UpToDate;
                    inner.state.version = None;
                    inner.state.notes = None;
                    inner.state.downloaded = 0;
                    inner.state.total = None;
                    inner.state.error = None;
                    inner.busy = false;
                }),
                Err(error) => updater.publish(&app, |inner| {
                    inner.state.status = UpdateStatus::Error;
                    inner.state.error = Some(format!("Could not check for updates: {error}"));
                    inner.busy = false;
                }),
            }
        });
        Ok(())
    }

    pub fn download(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let update = match self.inner.lock() {
            Ok(mut inner) if !inner.busy && inner.download.is_none() => {
                let update = inner.update.clone();
                if update.is_some() {
                    inner.busy = true;
                }
                update
            }
            Ok(_) => None,
            Err(_) => return Err("Updater state lock poisoned".to_owned()),
        };
        let Some(update) = update else { return Ok(()) };
        self.publish(&app, |inner| {
            inner.state.status = UpdateStatus::Downloading;
            inner.state.error = None;
            inner.state.downloaded = 0;
            inner.state.total = None;
        });
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let progress = Arc::clone(&updater);
            let progress_app = app.clone();
            let mut last_progress_event = Instant::now();
            let downloaded = update
                .download(
                    move |chunk, total| {
                        progress.record_progress(
                            &progress_app,
                            chunk,
                            total,
                            &mut last_progress_event,
                        );
                    },
                    || {},
                )
                .await;
            match downloaded {
                Ok(bytes) => updater.publish(&app, |inner| {
                    inner.download = Some(bytes);
                    inner.state.status = UpdateStatus::Ready;
                    inner.state.error = None;
                    inner.busy = false;
                }),
                Err(error) => updater.publish(&app, |inner| {
                    inner.state.status = UpdateStatus::Error;
                    inner.state.error = Some(format!("Could not download update: {error}"));
                    inner.state.downloaded = 0;
                    inner.state.total = None;
                    inner.busy = false;
                }),
            }
        });
        Ok(())
    }

    pub fn install(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let (update, bytes) = match self.inner.lock() {
            Ok(inner) if inner.busy => return Ok(()),
            Ok(mut inner) => {
                if inner.update.is_none() || inner.download.is_none() {
                    return Err("No verified update is ready to install".to_owned());
                }
                inner.busy = true;
                (
                    inner.update.take().expect("checked above"),
                    inner.download.take().expect("checked above"),
                )
            }
            Err(_) => return Err("Updater state lock poisoned".to_owned()),
        };
        self.publish(&app, |inner| {
            inner.state.status = UpdateStatus::Installing;
            inner.state.error = None;
        });
        let updater = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // On Windows the plugin exits the process itself only after the installer launches.
            // Its configured on_before_exit hook stops the backend at that exact point.
            match update.install(&bytes) {
                Ok(()) => {
                    if let Some(backend) = app.try_state::<Backend>() {
                        backend.shutdown();
                    }
                    #[cfg(not(windows))]
                    app.restart();
                }
                Err(error) => updater.publish(&app, |inner| {
                    inner.update = Some(update);
                    inner.download = Some(bytes);
                    inner.state.status = UpdateStatus::Error;
                    inner.state.error = Some(format!("Could not install update: {error}"));
                    inner.busy = false;
                }),
            }
        });
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    fn automatic_check(self: &Arc<Self>, app: AppHandle) {
        if self.snapshot().is_ok_and(|state| state.auto_check) {
            let _ = self.check(app);
        }
    }
}

pub fn schedule(app: AppHandle, updater: Arc<Updater>) {
    #[cfg(not(debug_assertions))]
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        updater.automatic_check(app.clone());
        let mut interval = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        interval.tick().await;
        loop {
            interval.tick().await;
            updater.automatic_check(app.clone());
        }
    });
    #[cfg(debug_assertions)]
    {
        let _ = (app, updater);
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE))
        .map_err(|error| format!("Could not locate application settings: {error}"))
}

fn load_settings(app: &AppHandle) -> bool {
    let Ok(path) = settings_path(app) else {
        return true;
    };
    match fs::read(&path) {
        Ok(contents) => serde_json::from_slice::<Settings>(&contents)
            .map(|settings| settings.auto_check)
            .unwrap_or(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => true,
    }
}

fn save_settings(app: &AppHandle, auto_check: bool) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path.parent().ok_or("Updater settings path has no parent")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create application settings: {error}"))?;
    let contents = serde_json::to_vec(&Settings { auto_check })
        .map_err(|error| format!("Could not encode updater settings: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not save updater settings: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Could not save updater settings: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::{check_admission, CheckAdmission, UpdateStatus};

    #[test]
    fn check_is_single_flight_and_preserves_an_offered_update() {
        assert_eq!(
            check_admission(false, false, UpdateStatus::Idle, false),
            CheckAdmission::Start
        );
        assert_eq!(
            check_admission(true, false, UpdateStatus::Checking, false),
            CheckAdmission::Ignore
        );
        assert_eq!(
            check_admission(false, true, UpdateStatus::Available, false),
            CheckAdmission::Ignore
        );
    }

    #[test]
    fn retrying_an_error_restores_the_offered_update_state() {
        assert_eq!(
            check_admission(false, true, UpdateStatus::Error, false),
            CheckAdmission::Recover(UpdateStatus::Available)
        );
        assert_eq!(
            check_admission(false, true, UpdateStatus::Error, true),
            CheckAdmission::Recover(UpdateStatus::Ready)
        );
    }
}

//! Runs the packaged Node sidecar (src/sidecar) and speaks its line-delimited JSON protocol:
//! correlates replies by id, times requests out, and forwards sidecar events to the webview.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

type Reply = Result<Value, String>;
type Pending = Mutex<HashMap<u64, oneshot::Sender<Reply>>>;

/// Bounds every request so one hung library call cannot leave the UI waiting forever. The
/// sidecar's own timeouts are at most 30 s (pairing); this is longer so their more specific
/// errors arrive first.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const TIMEOUT_MESSAGE: &str = "The Apple TV did not respond in time. Please try again.";

struct Inner {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Pending,
    next_id: AtomicU64,
    closing: AtomicBool,
    failure: Mutex<Option<String>>,
    app: AppHandle,
}

/// One launch attempt's outcome. The outer `Arc` identifies the attempt, so concurrent
/// requests that find the same dead sidecar relaunch it only once.
type Launched = Arc<Result<Arc<Inner>, String>>;

/// Handle to the Node sidecar. It launches on a background thread so a slow or broken
/// sidecar cannot block or abort app launch; requests wait for startup and report its error.
/// A sidecar that failed to launch or has since exited is relaunched by the next request.
pub struct Backend {
    /// `None` while the sidecar is (re)starting, then that launch's outcome.
    startup: watch::Sender<Option<Launched>>,
    launch: Arc<dyn Fn() -> Result<Arc<Inner>, String> + Send + Sync>,
}

fn resource_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("sidecar");
    if bundled.join("sidecar.mjs").is_file() {
        return Ok(bundled);
    }
    if cfg!(debug_assertions) {
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => return Err(format!("Unsupported Node architecture: {other}")),
        };
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else {
            "linux"
        };
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../dist/sidecar/{platform}-{arch}"));
        if development.join("sidecar.mjs").is_file() {
            return Ok(development);
        }
    }
    Err("Bundled Apple TV backend is missing. Run pnpm build:sidecar before building the desktop app.".into())
}

impl Inner {
    fn fail(&self, message: String) {
        let mut failure = self.failure.lock().unwrap();
        if failure.is_some() {
            return;
        }
        *failure = Some(message.clone());
        drop(failure);
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(message.clone()));
        }
        if !self.closing.load(Ordering::Acquire) {
            // It exited, or broke the protocol and must not linger: end and reap it. The next
            // request relaunches it. (shutdown reaps a sidecar that is closing.)
            let mut child = self.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
            drop(child);
            let _ = self.app.emit(
                "backend-event",
                json!({"event":"connection-lost","data":null}),
            );
            let _ = self.app.emit(
                "backend-event",
                json!({"event":"error","data":{"message":message}}),
            );
        }
    }
}

/// Drains the sidecar's diagnostics line by line. Bytes, not `lines()`: invalid UTF-8 would
/// end that iterator, and an undrained pipe eventually blocks the sidecar's writes.
fn log_lines(reader: impl BufRead, mut log: impl FnMut(&str)) {
    for line in reader.split(b'\n').map_while(Result::ok) {
        log(&String::from_utf8_lossy(&line));
    }
}

/// Spawns the sidecar and blocks until its `ready` frame, failure, or a 10 s timeout.
fn launch(app: &AppHandle) -> Result<Arc<Inner>, String> {
    let directory = resource_directory(app)?;
    let executable = directory.join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut command = Command::new(executable);
    command
        .arg(directory.join("sidecar.mjs"))
        .current_dir(&directory)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start Apple TV backend: {e}"))?;
    let input = child.stdin.take().ok_or("Missing backend input")?;
    let output = child.stdout.take().ok_or("Missing backend output")?;
    let errors = child.stderr.take().ok_or("Missing backend diagnostics")?;
    let inner = Arc::new(Inner {
        input: Mutex::new(Some(input)),
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        closing: AtomicBool::new(false),
        failure: Mutex::new(None),
        app: app.clone(),
    });
    let (ready_send, ready_receive) = mpsc::sync_channel(1);
    let reader = inner.clone();
    thread::spawn(move || {
        let mut ready = Some(ready_send);
        for line in BufReader::new(output).lines() {
            let message = match line
                .map_err(|e| e.to_string())
                .and_then(|line| serde_json::from_str::<Value>(&line).map_err(|e| e.to_string()))
            {
                Ok(value) => value,
                Err(error) => {
                    reader.fail(format!("Invalid backend output: {error}"));
                    break;
                }
            };
            if message.get("event").and_then(Value::as_str) == Some("ready") {
                if message
                    .pointer("/data/protocolVersion")
                    .and_then(Value::as_u64)
                    != Some(1)
                {
                    reader.fail("Unsupported Apple TV backend protocol".into());
                    break;
                }
                if let Some(sender) = ready.take() {
                    let _ = sender.send(());
                }
            } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(reply) = reader.pending.lock().unwrap().remove(&id) {
                    let result = if let Some(error) = message.get("error") {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Apple TV backend error")
                            .to_owned())
                    } else if let Some(value) = message.get("result") {
                        Ok(value.clone())
                    } else {
                        Err("Backend response contains neither a result nor an error".into())
                    };
                    let _ = reply.send(result);
                }
            } else if message.get("event").and_then(Value::as_str).is_some() {
                let _ = reader.app.emit("backend-event", message);
            } else {
                reader.fail("Unrecognized Apple TV backend message".into());
                break;
            }
        }
        // End of output means the sidecar exited (or closed stdout); fail() reaps it.
        reader.fail("Apple TV backend disconnected".into());
    });
    thread::spawn(move || {
        log_lines(BufReader::new(errors), |line| {
            eprintln!("Apple TV backend: {line}")
        })
    });
    if ready_receive.recv_timeout(Duration::from_secs(10)).is_err() {
        inner.shutdown();
        return Err(inner
            .failure
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "Apple TV backend did not become ready".into()));
    }
    Ok(inner)
}

/// Waits up to `REQUEST_TIMEOUT` for request `id`'s reply. On timeout the pending entry is
/// removed, so the reader drops a late reply instead of delivering it.
async fn await_reply(pending: &Pending, id: u64, reply: oneshot::Receiver<Reply>) -> Reply {
    match tokio::time::timeout(REQUEST_TIMEOUT, reply).await {
        Ok(reply) => reply.map_err(|_| "Apple TV backend response channel closed".to_owned())?,
        Err(_) => {
            pending.lock().unwrap().remove(&id);
            Err(TIMEOUT_MESSAGE.into())
        }
    }
}

impl Backend {
    pub fn start(app: &AppHandle) -> Self {
        let app = app.clone();
        let backend = Self {
            startup: watch::Sender::new(None),
            launch: Arc::new(move || launch(&app)),
        };
        backend.spawn_launch();
        backend
    }

    fn spawn_launch(&self) {
        let startup = self.startup.clone();
        let launch = Arc::clone(&self.launch);
        thread::spawn(move || {
            let launched = launch();
            if let Err(error) = &launched {
                eprintln!("{error}");
            }
            startup.send_replace(Some(Arc::new(launched)));
        });
    }

    async fn launched(&self) -> Result<Launched, String> {
        self.startup
            .subscribe()
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "Apple TV backend startup was interrupted".to_owned())?
            .clone()
            .ok_or_else(|| "Apple TV backend did not start".into())
    }

    /// The running sidecar. One that failed to launch or has exited is relaunched once, so a
    /// crash fails only the requests in flight. The new sidecar has no connection, so the
    /// renderer sends `reconnect` with the saved device on `connection-lost`.
    async fn started(&self) -> Result<Arc<Inner>, String> {
        let launched = self.launched().await?;
        let dead = match launched.as_ref() {
            Ok(inner) => {
                !inner.closing.load(Ordering::Acquire) && inner.failure.lock().unwrap().is_some()
            }
            Err(_) => true,
        };
        if !dead {
            return (*launched).clone();
        }
        // Only the first request to see this outcome relaunches; the rest wait for that launch.
        let relaunch = self.startup.send_if_modified(|current| {
            let same = current
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &launched));
            if same {
                *current = None;
            }
            same
        });
        if relaunch {
            self.spawn_launch();
        }
        (*self.launched().await?).clone()
    }

    pub async fn request(&self, method: String, params: Value) -> Reply {
        if !matches!(
            method.as_str(),
            "scan"
                | "startPair"
                | "finishPair"
                | "connect"
                | "reconnect"
                | "disconnect"
                | "sendKey"
                | "seek"
                | "isConnected"
        ) {
            return Err("Unsupported Apple TV operation".into());
        }
        if !params.is_object() {
            return Err("Backend parameters must be an object".into());
        }
        let inner = self.started().await?;
        if inner.closing.load(Ordering::Acquire) {
            return Err("Apple TV backend is shutting down".into());
        }
        let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            // Serialize admission with failure so a dead process cannot strand a request.
            let failure = inner.failure.lock().unwrap();
            if let Some(error) = failure.as_ref() {
                return Err(error.clone());
            }
            inner.pending.lock().unwrap().insert(id, sender);
        }
        let message = json!({"id":id,"method":method,"params":params}).to_string() + "\n";
        let written = {
            let mut input = inner.input.lock().unwrap();
            input
                .as_mut()
                .ok_or_else(|| "Apple TV backend input is closed".to_owned())
                .and_then(|input| {
                    input
                        .write_all(message.as_bytes())
                        .map_err(|e| e.to_string())
                })
        };
        if let Err(error) = written {
            inner.fail(format!("Cannot write to Apple TV backend: {error}"));
        }
        await_reply(&inner.pending, id, receiver).await
    }

    pub fn shutdown(&self) {
        // A sidecar still starting exits by itself once our end of its stdin closes at exit.
        let launched = self.startup.borrow().clone();
        if let Some(Ok(inner)) = launched.as_deref() {
            inner.shutdown();
        }
    }
}

impl Inner {
    fn shutdown(&self) {
        if self.closing.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(mut input) = self.input.lock().unwrap().take() {
            let _ = input.write_all(b"{\"id\":0,\"method\":\"shutdown\"}\n");
        }
        self.fail("Apple TV backend is shutting down".into());
        // The application is exiting: reap the child before the OS ends our threads.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let mut child = self.child.lock().unwrap();
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            drop(child);
            thread::sleep(Duration::from_millis(25));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_wait_for_startup_and_relaunch_a_dead_backend() {
        let launches = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&launches);
        let backend = Backend {
            startup: watch::Sender::new(None),
            launch: Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Err("Cannot start Apple TV backend: missing".into())
            }),
        };
        // Exiting while the sidecar is still starting must not block or panic.
        backend.shutdown();
        let startup = backend.startup.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            startup.send_replace(Some(Arc::new(Err("Apple TV backend exited".into()))));
        });
        let request = || tauri::async_runtime::block_on(backend.request("scan".into(), json!({})));
        // The failed first launch is not latched: each request relaunches once and reports that.
        assert_eq!(
            request(),
            Err("Cannot start Apple TV backend: missing".into())
        );
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert_eq!(
            request(),
            Err("Cannot start Apple TV backend: missing".into())
        );
        assert_eq!(launches.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn diagnostics_keep_draining_past_invalid_utf8() {
        let mut logged = Vec::new();
        log_lines(&b"one\n\xff\xfe bad\nthree\n"[..], |line| {
            logged.push(line.to_owned())
        });
        assert_eq!(logged, ["one", "\u{FFFD}\u{FFFD} bad", "three"]);
    }

    #[test]
    fn an_unanswered_request_times_out_and_forgets_its_reply() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap();
        runtime.block_on(async {
            let pending = Pending::default();
            let (sender, receiver) = oneshot::channel();
            pending.lock().unwrap().insert(7, sender);
            let reply = await_reply(&pending, 7, receiver).await;
            assert_eq!(reply, Err(TIMEOUT_MESSAGE.into()));
            // The reader finds no entry for a late reply, so it is dropped.
            assert!(pending.lock().unwrap().is_empty());
        });
    }
}

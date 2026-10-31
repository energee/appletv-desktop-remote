//! Runs the packaged Node sidecar (src/sidecar) and speaks its line-delimited JSON protocol:
//! correlates replies by id, times requests out, and forwards sidecar events to the webview.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc as input_channel, oneshot, watch};

type Reply = Result<Value, String>;
type Pending = Mutex<HashMap<u64, oneshot::Sender<Reply>>>;

/// Bounds every request so one hung library call cannot leave the UI waiting forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
/// Companion pairing may spend 30 s establishing HAP then 15 s completing the PIN exchange.
const COMPANION_PAIR_TIMEOUT: Duration = Duration::from_secs(50);
const TIMEOUT_MESSAGE: &str = "The Apple TV did not respond in time. Please try again.";

#[derive(Debug)]
enum InputFrame {
    Request {
        message: String,
        deadline: Instant,
        written: oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

struct Inner {
    input: input_channel::Sender<InputFrame>,
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

/// One worker owns stdin. Async callers never hold a mutex while the pipe is backpressured.
fn write_input(mut input: impl Write, mut frames: input_channel::Receiver<InputFrame>) {
    while let Some(frame) = frames.blocking_recv() {
        let InputFrame::Request {
            message,
            deadline,
            written,
        } = frame
        else {
            let _ = input.write_all(b"{\"id\":0,\"method\":\"shutdown\"}\n");
            break;
        };
        if written.is_closed() {
            continue;
        }
        if Instant::now() >= deadline {
            let _ = written.send(Err(TIMEOUT_MESSAGE.into()));
            continue;
        }
        let result = input
            .write_all(message.as_bytes())
            .map_err(|error| format!("Cannot write to Apple TV backend: {error}"));
        let failed = result.is_err();
        let _ = written.send(result);
        if failed {
            break;
        }
    }
}

async fn send_frame(
    input: &input_channel::Sender<InputFrame>,
    message: String,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let (written, received) = oneshot::channel();
    tokio::time::timeout_at(deadline, async {
        input
            .send(InputFrame::Request {
                message,
                deadline: deadline.into_std(),
                written,
            })
            .await
            .map_err(|_| "Apple TV backend input is closed".to_owned())?;
        received
            .await
            .map_err(|_| "Apple TV backend input is closed".to_owned())?
    })
    .await
    .map_err(|_| TIMEOUT_MESSAGE.to_owned())?
}

/// Killing/reaping must never depend on the stdin worker making progress.
fn stop_child(child: &Mutex<Child>, grace: Duration) {
    let deadline = Instant::now() + grace;
    loop {
        let mut child = child.lock().unwrap();
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
    let (input_send, input_receive) = input_channel::channel(32);
    let inner = Arc::new(Inner {
        input: input_send,
        child: Mutex::new(child),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        closing: AtomicBool::new(false),
        failure: Mutex::new(None),
        app: app.clone(),
    });
    thread::spawn(move || write_input(input, input_receive));
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

/// Waits for a reply, removing a timed-out request so a late reply is dropped.
async fn await_reply(
    pending: &Pending,
    id: u64,
    reply: oneshot::Receiver<Reply>,
    deadline: tokio::time::Instant,
) -> Reply {
    match tokio::time::timeout_at(deadline, reply).await {
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
                | "power"
                | "setVolume"
                | "speakers"
                | "setSpeaker"
                | "companionStatus"
                | "startCompanionPair"
                | "finishCompanionPair"
                | "cancelCompanionPair"
                | "apps"
                | "launchApp"
                | "setText"
                | "clearText"
                | "touch"
        ) {
            return Err("Unsupported Apple TV operation".into());
        }
        if !params.is_object() {
            return Err("Backend parameters must be an object".into());
        }
        let timeout = if method == "finishCompanionPair" {
            COMPANION_PAIR_TIMEOUT
        } else {
            REQUEST_TIMEOUT
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let inner = tokio::time::timeout_at(deadline, self.started())
            .await
            .map_err(|_| TIMEOUT_MESSAGE.to_owned())??;
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
        if let Err(error) = send_frame(&inner.input, message, deadline).await {
            // A write deadline means the pipe itself may be stuck. Reap the process so the
            // worker cannot later deliver an expired command after the UI reports failure.
            inner.fail(error.clone());
            return Err(error);
        }
        await_reply(&inner.pending, id, receiver, deadline).await
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
        // Best effort only: a full queue or blocked writer must not delay the kill deadline.
        let _ = self.input.try_send(InputFrame::Shutdown);
        self.fail("Apple TV backend is shutting down".into());
        stop_child(&self.child, Duration::from_secs(3));
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
            let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
            let reply = await_reply(&pending, 7, receiver, deadline).await;
            assert_eq!(reply, Err(TIMEOUT_MESSAGE.into()));
            // The reader finds no entry for a late reply, so it is dropped.
            assert!(pending.lock().unwrap().is_empty());
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_nonreading_child_cannot_block_the_write_deadline_or_shutdown() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let child = Mutex::new(child);
        let (send, receive) = input_channel::channel(1);
        let worker = thread::spawn(move || write_input(input, receive));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            send_frame(
                &send,
                "x".repeat(8 * 1024 * 1024),
                tokio::time::Instant::now() + Duration::from_millis(100),
            )
            .await
        });
        // The stdin worker may still be blocked. Shutdown owns the child independently.
        stop_child(&child, Duration::from_millis(50));
        drop(send);
        worker.join().unwrap();
        assert_eq!(result, Err(TIMEOUT_MESSAGE.into()));
        assert!(!child.lock().unwrap().try_wait().unwrap().unwrap().success());
    }

    #[test]
    fn expired_or_abandoned_queued_commands_are_not_written() {
        #[derive(Clone)]
        struct Output(Arc<Mutex<Vec<u8>>>);
        impl Write for Output {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let output = Output(Arc::new(Mutex::new(Vec::new())));
        let (send, receive) = input_channel::channel(3);
        let (abandoned, received) = oneshot::channel();
        drop(received);
        send.try_send(InputFrame::Request {
            message: "abandoned".into(),
            deadline: Instant::now() + Duration::from_secs(5),
            written: abandoned,
        })
        .unwrap();
        let (expired, expired_reply) = oneshot::channel();
        send.try_send(InputFrame::Request {
            message: "expired".into(),
            deadline: Instant::now() - Duration::from_secs(1),
            written: expired,
        })
        .unwrap();
        let (current, current_reply) = oneshot::channel();
        send.try_send(InputFrame::Request {
            message: "current".into(),
            deadline: Instant::now() + Duration::from_secs(5),
            written: current,
        })
        .unwrap();
        drop(send);
        write_input(output.clone(), receive);
        assert_eq!(
            expired_reply.blocking_recv().unwrap(),
            Err(TIMEOUT_MESSAGE.into())
        );
        assert_eq!(current_reply.blocking_recv().unwrap(), Ok(()));
        assert_eq!(*output.0.lock().unwrap(), b"current");
    }
}

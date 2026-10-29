# ATV Desktop Remote

ATV Desktop Remote controls an Apple TV from a native Tauri desktop application. The browser-based remote UI runs in the system webview, while a packaged Node sidecar uses [node-appletv-remote](https://github.com/energee/node-appletv-remote) for discovery, pairing, and control. No Python or pyatv installation is required.

<p align="center">
  <img src="screenshots/light.png" alt="ATV Remote in light mode" width="270"/>
  <img src="screenshots/dark.png" alt="ATV Remote in dark mode" width="270"/>
</p>

## Usage

- Pair an Apple TV on first launch by entering the PIN it shows, then use the touchpad, buttons, or keyboard controls. Pairing is AirPlay only, with one PIN: every remote key and now-playing work over MRP, so Companion pairing is not used. Credentials saved by earlier versions, which paired Companion with a second PIN, still work; their Companion keys are ignored.
- On the touchpad, a two-finger swipe moves one item per gesture: scrolling after the move, including the trackpad's momentum, is ignored until the fingers start a new gesture (macOS reports this through an `NSEvent` monitor in `src-tauri/src/gesture.m`) or, for mouse wheels and on other platforms, until the events stop for 150 ms. A click selects, and holding for a second also selects.
- The play button (and Space) pauses while the Apple TV reports that something is playing and plays while it reports paused, stopped, or interrupted, using the explicit MRP play and pause commands so it never toggles the wrong way. With no reported state, while seeking, or while the TV reports its empty default player (apps such as Plex report through it, and it ignores those commands), it sends the play/pause key press, as the Siri Remote does. The button shows a pause icon while playing and a play icon otherwise, including whenever the remote is not connected. A press flips the icon at once, since the Apple TV can report the change seconds late; if no report confirms it within 3 seconds, the icon goes back to the last reported state. Now-playing shows the title and artist, and, when the item has a length, a seek bar with the elapsed time and duration; dropping the bar moves playback there (MRP `setPosition`). The position advances on a local clock between the Apple TV's reports, which it sends only on changes.
- The window is as tall as its content, up to the screen height, so the now-playing panel and settings never scroll.
- On macOS the window is Liquid Glass (macOS 26 and later; `windowEffects` in `src-tauri/tauri.conf.json`): the page draws no background of its own, secondary text uses translucent label colors so it stays readable over any backdrop, and the window's appearance follows the app's Light/Dark setting, since the glass follows the window rather than the page. The content view is clipped to the glass's 16 pt radius (`src-tauri/src/corners.m`) so the glass's shadow never shows as square corners. Transparent windows need Tauri's `macOSPrivateApi`, which is fine for the DMG but would block a Mac App Store build. Windows and Linux keep the opaque background.
- Hold Option (Alt on Windows) to show keyboard labels.
- Use **Settings** to select the theme, keep the window on top, manage saved remotes, and change the global hotkey.
- The default hotkey is `Cmd+Shift+R` on macOS and `Win+Shift+R` on Windows.
- Close hides the remote without destroying it; the tray icon or hotkey reopens it. Use **Quit** to stop the application and its Node backend.

| Key             | Action                  |
| --------------- | ----------------------- |
| Arrow keys      | Navigate                |
| Enter           | Select                  |
| Space           | Play / pause            |
| Esc / Backspace | Menu                    |
| T / L           | Home / long-press Home  |
| G               | Top menu                |
| [ / ]           | Skip backward / forward |
| + / -           | Volume up / down        |

## Moving from Electron

Tauri webview storage is separate from Electron's localStorage, so saved Apple TV credentials are **not imported automatically**. Existing Electron releases do not have the new export button: pair your devices again, or import an existing compatible JSON backup using **Settings → Import Credentials**, which opens a native file dialog. Tauri's **Export Credentials** button saves a backup through a native save dialog for subsequent moves; on macOS and Linux the file is written readable only by you (mode 0600). The backup contains saved remote credentials, the active remote, appearance, and always-on-top settings; handle it as a secret. Importing applies its appearance and always-on-top settings immediately. Existing hotkey settings are read from the prior `ATV Remote` application-support directory, chosen as Electron did: `%APPDATA%` whenever it is set (on any platform), otherwise `~/Library/Application Support` on macOS or `~/.local/share` elsewhere; `hotkey.txt` may list several comma-separated hotkeys, and changing the hotkey replaces only the first. If there are none, or any of them cannot be registered, the default hotkeys are registered as well.

## Running from source

Prerequisites:

- Node.js 24
- pnpm
- Rust stable and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
pnpm install
pnpm --dir app install --frozen-lockfile
pnpm start
```

`pnpm start` prepares the webview frontend and packaged Node sidecar, and waits for both, before launching Tauri; without the wait, the dev build can copy the previous sidecar. `pnpm build` creates a bundle for the current host architecture; `pnpm build:mac` builds for Apple silicon (`aarch64-apple-darwin`) on either Mac architecture. `pnpm build:sidecar` builds for the target Tauri passes in `TAURI_ENV_TARGET_TRIPLE` (the host when run directly), keeps that target's artifacts in `dist/sidecar/<platform>-<arch>/`, and stages them in `dist/desktop-backend/` for Tauri packaging. The checksum-verified Node runtime is downloaded once per version and target into `dist/node-runtime/`; delete that directory to fetch it again. `pnpm typecheck` type-checks all TypeScript sources without emitting files, since esbuild bundles the webview and sidecar.

The Tauri Rust host starts one persistent packaged Node process on a background thread, so launch never waits on it. Frontend requests use Tauri's `backend_request` command, which waits for the sidecar's `ready` frame; if the sidecar cannot start, requests fail with that error, which the remote displays. If the sidecar fails to start or later exits, the next request relaunches it; the host reports the exit as `connection-lost`, and the remote sends `reconnect` with the saved device, since the new sidecar has no connection. Each request times out after 35 s, a little longer than the sidecar's own timeouts (at most 30 s, for pairing), so their more specific errors arrive first. Sidecar events are forwarded to the webview as `backend-event` payloads containing `{ event, data }`. Window actions, context menus, hotkey management, credential import and export, and native wake events use the `desktop_action` command and Tauri events. The window hides when it loses focus unless it is always on top or one of its own file dialogs is open. A tray click opens the window below the icon when the icon is in the top half of its screen (the macOS menu bar) and above it otherwise (a bottom Windows taskbar). Frontend settings and credentials remain in webview localStorage.

The CI workflow (`.github/workflows/ci.yml`) runs typecheck, lint, the format check, vitest, `cargo test`, and clippy on every pull request and push to `main`. The release workflow builds native bundles on macOS x64, macOS arm64, and Windows x64. The Node sidecar is built for the same target as the bundle and included as a Tauri resource.

### Connection state

The sidecar's `ATVService` is the only owner of the Apple TV connection; the webview renders its state and forwards user actions. It reports every change as a `state` event, `{ "status": ... }`:

| Status         | Meaning                                           | Remote shows                                 |
| -------------- | ------------------------------------------------- | -------------------------------------------- |
| `idle`         | No device chosen yet, or disconnected on request  | Remote screen, red dot                       |
| `connecting`   | Connecting, or waiting to retry                   | "Connecting to ATV..." or "Reconnecting..."  |
| `connected`    | Connected; keys are sent                          | Remote controls                              |
| `disconnected` | Gave up after five retries                        | "Connection lost. Right-click to reconnect." |
| `pairing`      | Scanning or pairing; no connect or reconnect runs | Pairing screen; Enter submits the PIN        |

- `connect` (startup, picking a device from the menu, importing credentials, finishing pairing) makes that device current and starts a fresh connection. It answers at once; progress arrives as `state`. The latest request wins: it closes the device of any connect in flight and ends pairing.
- After a dropped connection the sidecar reconnects by itself, 0.5 s after the drop and then doubling, five times, before reporting `disconnected`.
- On macOS and Windows wake the remote sends `reconnect`, which replaces the possibly dead connection unless pairing is under way; Linux has no wake detection.
- `scan` starts pairing: it closes the connection and stops reconnecting until the next `connect`. Every connect, pairing step, and disconnect starts a new epoch, and work from an older one is ignored, so a connect that settles after pairing began (for example **Re-pair current device**) cannot mark the remote connected.
- The Settings panel stays in front of state changes; leaving it shows the screen for the current state.

### macOS packaging and verification

The application requires macOS 13.5 or newer, matching its bundled Node 24 runtime.
The arm64 Tauri `.app` measured approximately 97.21 MiB including the Node sidecar;
Chromium and Electron are no longer included. The local bundle is written to
`src-tauri/target/release/bundle/macos/ATV Remote.app`.

Local builds use ad-hoc signing. Developer ID signing and notarization require
release credentials; override `bundle.macOS.signingIdentity` with the Developer ID
identity when distributing a notarized release. The checked-in entitlements apply
only to the Tauri host binary, which Tauri signs with the hardened runtime. The bundled
`node` is signed separately by `pnpm build:sidecar`: ad-hoc and without the hardened
runtime, so V8's JIT needs no entitlements. Tauri does not re-sign it, so a notarized
release must re-sign `node` with the Developer ID identity, the hardened runtime, and JIT
entitlements, as the upstream Node binary is signed. An ad-hoc signature is not
equivalent to Apple notarization.

Verification included TypeScript checking, lint, 27 JavaScript regression tests,
and a Rust shortcut regression test. The first native launch exposed an unsupported
`META` shortcut modifier; normalization now uses the parser's supported `SUPER`
modifier. A live run completed the earlier two-PIN AirPlay/Companion pairing and
established both connections; the current one-PIN AirPlay pairing has not yet been
exercised against a live Apple TV. Windows/x64 and macOS/x64 bundles have not been exercised locally.

## Sidecar protocol

stdin and stdout carry one JSON object per line. Requests contain an `id`, `method`, and object `params`; responses contain either `result` or `error`. Requests are handled concurrently, so responses can arrive in any order and are matched by `id`. Logs go only to stderr, including uncaught exceptions and unhandled rejections, which the sidecar logs and survives. `connect` and `reconnect` reply at once and report progress as `state` events (see [Connection state](#connection-state)); `sendKey`, `seek`, and `disconnect` fail after 5 s without an answer from the Apple TV. When stdin closes (the host exited or crashed), the sidecar answers requests that finish within a second, then exits. The sidecar methods are `scan`, `startPair`, `finishPair`, `connect`, `reconnect`, `disconnect`, `sendKey`, `seek` (`{ seconds }`), `isConnected`, and `shutdown`. Unsolicited frames have `{ "event": "...", "data": ... }`: `state`, `now-playing`, and `error`.

## License

This project is licensed under [CC BY-NC-SA 4.0](LICENSE).

<p align="center">
  <img src="docs/icon.png" alt="" width="96" height="96"/>
</p>

<h1 align="center">Apple TV Remote</h1>

<p align="center">Your Apple TV, one click away in the menu bar.</p>

<p align="center">
  <a href="https://github.com/energee/appletv-desktop-remote/releases/latest"><img src="https://badgen.net/github/release/energee/appletv-desktop-remote" alt="Latest release"/></a>
  <a href="https://github.com/energee/appletv-desktop-remote/actions/workflows/ci.yml"><img src="https://badgen.net/github/checks/energee/appletv-desktop-remote" alt="CI checks"/></a>
  <img src="https://badgen.net/badge/platform/macOS%20%7C%20Windows/blue" alt="Platforms: macOS and Windows"/>
  <a href="LICENSE"><img src="https://badgen.net/badge/license/GPL-3.0-only/grey" alt="License: GPL-3.0-only"/></a>
</p>

<p align="center">
  <a href="https://energ.ee/appletv-desktop-remote/#downloads"><b>Choose your download: Mac Apple silicon · Mac Intel · Windows x64</b></a>
  <br/>
  <a href="https://energ.ee/appletv-desktop-remote/#stage">Practice with the simulated website remote</a> · <a href="https://github.com/energee/appletv-desktop-remote/issues/new/choose">Report a problem or share feedback</a>
</p>

<p align="center">
  <img width="301" height="530" src="https://github.com/user-attachments/assets/68cbe526-46ec-493d-8ac4-9753024da6ee" alt="The remote window, showing a touchpad, playback buttons, and the show that's playing"/>
</p>

## Everything the Siri Remote does. Nothing to pick up.

- **Touchpad.** Scroll with two fingers to navigate, click to select, and hold for a second to open context menus. Enable **Settings → Touchpad → Smooth scrolling** for continuous Companion gestures; otherwise, scrolling sends one arrow press per gesture. Smooth scrolling coalesces obsolete positions when the backend is busy instead of replaying every sample after the gesture ends. Sent gestures retain their final position and release even when another gesture begins during a slow release.
- **Now playing.** See what's on, then play, pause, and scrub from the seek bar. The current item is requested on connection rather than waiting for a playback change.
- **Always handy.** Press `Cmd+Shift+R` (`Win+Shift+R` on Windows) to show or hide it from any app, or click the menu bar icon. Keep it on top, or let it tuck away. **Settings → Change Hotkey** uses platform-appropriate labels and reports conflicts or storage errors without silently replacing a working shortcut; failed operations can be retried. Returning focus cancels a pending automatic hide.
- **Device picker.** Click the device name to switch Apple TVs or pair another. Right-click for theme, always-on-top, speakers, updates, and other actions. **Settings** manages saved remotes, scrolling, the hotkey, backups, and update preferences.

## Or just use the keyboard

Hold Option (Alt on Windows) and the remote labels every button with its key. You can also Tab through named remote buttons, including Select, and activate the focused button with Enter or Space. Holding Enter acts once for playback, Select, Menu, Home, and skip controls; volume buttons keep repeating. Remote shortcuts do not send commands from Settings. Pending presses are canceled when focus, connection, or the selected TV changes, before waiting for device selection to save. Canceled mouse releases stay canceled across reconnects without blocking fresh mouse or keyboard activation. Selection and removal are ordered so a stale Settings action cannot control the wrong device.

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

## Set up in a minute

1. **Choose your installer** below, or use the [download chooser](https://energ.ee/appletv-desktop-remote/#downloads). These links always download the matching installer from the latest release, without needing JavaScript.

   | Computer                      | Download choice                                                                                                                                      | Filename ending                  |
   | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
   | Mac, Apple silicon (M-series) | [Download for Mac Apple silicon](https://github.com/energee/appletv-desktop-remote/releases/latest/download/Apple-TV-Remote-macOS-Apple-silicon.dmg) | `_aarch64.dmg`                   |
   | Mac, Intel                    | [Download for Mac Intel](https://github.com/energee/appletv-desktop-remote/releases/latest/download/Apple-TV-Remote-macOS-Intel.dmg)                 | `_x64.dmg`                       |
   | Windows x64                   | [Download for Windows x64](https://github.com/energee/appletv-desktop-remote/releases/latest/download/Apple-TV-Remote-Windows-x64-setup.exe)         | `_x64-setup.exe` (or `_x64.msi`) |

   **Mac requirements:** macOS **13.5 or later**. To choose a CPU, open **Apple menu → About This Mac**: **Chip: Apple M…** means Apple silicon; **Processor: Intel…** means Intel. Open the DMG and drag Apple TV Remote to Applications. On Windows x64, run the EXE installer; the MSI is an alternative on the [latest release page](https://github.com/energee/appletv-desktop-remote/releases/latest). That page also has the original versioned installers with the filename endings above.

2. **Review the first-launch warning.** macOS builds are not notarized; Windows may show SmartScreen's “unrecognized app” warning. These are not Apple- or Microsoft-trusted OS builds; updater signatures are separate from OS code signing. Only proceed if you trust the source and downloaded from this project's GitHub release. On macOS, try opening the app, then use **System Settings → Privacy & Security → Open Anyway** if offered. On Windows, **More info → Run anyway** may be offered. If your organization's security policy blocks installation, don't bypass it; [tell us what happened](https://github.com/energee/appletv-desktop-remote/issues/new?template=bug_report.yml).
3. **Pair on the same network.** Pick your Apple TV and type the code it shows on screen. The code is sent on the fourth digit, and a wrong one brings up a new code. Your computer and Apple TV need to be on the same local network; a guest network, VPN, or client isolation can prevent discovery.

The website's interactive remote is a **practice simulation**. It does not connect to an Apple TV and is not footage or proof of a real-TV session.

### Tell us how it went

[Report an install, pairing, or remote-control problem](https://github.com/energee/appletv-desktop-remote/issues/new?template=bug_report.yml) or [share your use case, feature idea, and whether you'd keep using it](https://github.com/energee/appletv-desktop-remote/issues/new?template=usage_feedback.yml). A GitHub account is needed to submit an issue. Reports are public: never attach pairing keys, credential backups, PINs, or private network details. Logs are optional and should be redacted.

### Apps, text input, and scrolling

The **Apps** grid icon, **Keyboard**, and **Settings → Touchpad → Smooth scrolling** use Apple's Companion connection. If Companion isn't paired, opening Apps or Keyboard, or enabling smooth scrolling, offers **Show pairing code** for the second code displayed on the TV. Ordinary remote pairing still needs only the original AirPlay code; scrolling never starts another pairing.

**Apps** lists installed apps to launch. **Keyboard** is always available on the remote. Open it, then select a text field on the Apple TV; the desktop input enables and receives focus once the TV's current text is loaded. The sheet stays open while waiting for a field, including when the TV leaves one. With Companion connected, an inline text box also appears while a TV field is focused. Edits are debounced; typing, spaces, and cursor keys stay in the text field instead of sending remote shortcuts. **Smooth scrolling** is saved separately for each selected device.

The header groups the device picker and power control. The device dot is green when connected, steady amber while asleep, pulsing amber while connecting, and red when disconnected. The main remote and Companion reconnect separately, with slower background retries after quick attempts fail. A Companion feature waits for saved-pairing recovery rather than asking for another PIN; **Pair again** remains an explicit option if keys need replacing. Explicit authentication rejection stops automatic retries and offers pairing without disconnecting the main remote. If opening a pairing prompt fails, the feature offers an explicit retry rather than claiming automatic recovery. Canceling pairing releases its session and does not adopt unsaved Companion keys. Old Companion warnings clear when the next Companion status has no error.

On macOS, pairing keys are stored in `pairings.json` in the app's data folder, readable only by your user account, and the app never uses Keychain, so it never asks for a password. Keychain approval is tied to the exact build, and ad-hoc signed builds would ask again after every update. The file is not encrypted: any process running as your user can read it, and it is included in backups of your home folder. Pairings saved in Keychain by older versions are not read, because reading them can prompt, so pair each Apple TV again after updating. The old items can be deleted in Keychain Access by searching for `com.tedslesinski.atv-desktop-remote`.

On Windows, pairing keys stay in Credential Manager.

Existing renderer-stored pairings migrate on startup and are removed from browser storage only after secure storage acknowledges them. If secure storage is locked or unavailable, the app retains the old data and offers a retry. A failed save after pairing can be retried without requesting another TV code. Replacement keys are staged separately, so a failed import or save leaves existing pairings usable. Cleanup of superseded keys is retried without treating an already-committed import or removal as a failure.

Credential backups are read and written through native file dialogs; the renderer receives device names and IDs, not pairing keys. Exported backups contain keys in plaintext: keep them private. Export writes a complete private replacement before atomically replacing an existing backup. Importing replaces the saved-device list and active selection with the backup only after its keys have been staged successfully.

### Upgrading from the Electron version (0.5.x)

Saved Apple TVs don't carry over: pair again, or use **Settings → Import Credentials** with a backup. **Export Credentials** saves one for next time; treat the file as a secret. Your hotkey is kept.

### Software updates

Release builds check for updates in the background after startup and once a day while running. An **Update available** button appears above the remote without opening a dialog or interrupting playback. You can also choose **Check for Updates…** from the native menu or Settings.

The update sheet shows release notes and download progress. Downloads are signature-verified; installation only starts when you choose **Install & restart**. Saved devices and settings are retained, except that updating a Mac from v0.7.6 or earlier requires pairing each Apple TV again. Dismiss the sheet to keep using the remote while downloading, then return through **Update ready**. Downloads are held for the current app session; quitting before installation requires downloading again.

**Settings → Automatically check for updates** disables background checks without disabling manual checks. Development builds only check when requested. Existing versions without an updater need a one-time manual installation of an updater-enabled release.

## Free and open source

Found a problem? [Report a bug](https://github.com/energee/appletv-desktop-remote/issues/new?template=bug_report.yml) or [share usage feedback](https://github.com/energee/appletv-desktop-remote/issues/new?template=usage_feedback.yml). Pull requests are welcome. If you'd like to find the project again, bookmark the [download page](https://energ.ee/appletv-desktop-remote/#downloads) or optionally star it on GitHub.

Apple TV Remote is built with Tauri and talks to the Apple TV through a bundled Node backend using [node-appletv-remote](https://github.com/energee/node-appletv-remote), so there's nothing else to install. Development requires Node.js 24, pnpm, and Rust with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm --dir app install --frozen-lockfile
pnpm start        # run in development
pnpm test         # vitest; also: pnpm typecheck, pnpm lint, cargo test in src-tauri
pnpm build        # bundle for this machine (pnpm build:mac for Apple silicon)
```

The webview (`src/renderer`) displays connection state and owns the standard Tauri updater resource; the Node backend (`src/sidecar`) owns the Apple TV connection, and the Rust host (`src-tauri`) handles the tray, window, hotkeys, native update verification/installation, and macOS Liquid Glass. Host request deadlines cover startup, queue admission, stdin writes, and replies; a blocked stdin worker cannot prevent the shutdown deadline from terminating the child. CI runs the checks on every pull request; version tags build the macOS and Windows releases. The landing page lives in `docs/` and is served by GitHub Pages.

The sidecar's pnpm patch opens the Companion remote-service session before `TVRCSessionStart`, matching the [required protocol order](https://github.com/postlund/pyatv/pull/2855). It also adds Companion-only teardown, guards stale setup completion, and tags authentication rejection separately from transient failures, so cancellation and recovery preserve the healthy main transport. Keep this patch until the dependency includes these changes; frozen installs apply it from `app/patches`.

Local macOS builds are ad-hoc signed. A notarized release needs a Developer ID identity (`bundle.macOS.signingIdentity`) and must re-sign the bundled `node` (see `scripts/build-sidecar.mjs`). The transparent glass window uses Tauri's `macOSPrivateApi`, which rules out the Mac App Store.

### Publishing signed updates

The release workflow builds macOS Apple silicon, macOS Intel, and Windows x64. Tag pushes require the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has a password). The matching public key is committed in `src-tauri/tauri.conf.json`; never commit the private key. Keep a secure backup of the signing key: generating a replacement key does not let already-installed apps verify it.

Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` versions in sync with the `v` tag. The official `tauri-apps/tauri-action` builds and uploads installers, signed updater bundles, signatures, and `latest.json` with release notes. Builds run sequentially so the action's metadata merge preserves every platform. The release stays a draft until its manifest has the tagged version, all three platforms pointing to actual release assets, and non-empty signatures. Architecture-specific asset names prevent collisions.

**Settings → What’s new** shows the installed version’s release notes offline, without checking for an update. Update `app/release-notes.md` before tagging a release: the renderer bundles it, and the release workflow uses the same file for GitHub and updater notes. Notes render as sanitized Markdown text, including headings, lists, emphasis, code, and tables; images and link navigation are disabled.

Normal local builds and manual workflow runs do not generate updater artifacts and require no signing secret. To create signed updater artifacts locally:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.config/atv-desktop-remote/updater.key"
pnpm build --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

Updater signatures authenticate the download; they are separate from Apple Developer ID signing/notarization and Windows code signing. See the [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).

## License

Copyright (c) 2026 Ted Slesinski. Licensed under the [GNU General Public License, version 3 only (GPL-3.0-only)](LICENSE). Apple TV and Siri Remote are trademarks of Apple Inc. This app isn't made by or affiliated with Apple.

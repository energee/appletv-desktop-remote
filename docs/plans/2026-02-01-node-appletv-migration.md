# Migrate from pyatv to node-appletv-remote — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Python/WebSocket backend (`pyatv` + `wsserver.py`) with a pure Node.js Apple TV service using `node-appletv-remote`, communicating via Electron IPC instead of WebSocket.

**Architecture:** A new `app/atv_service.js` module wraps `node-appletv-remote` and runs in the Electron main process. It exposes async methods called via `ipcMain.handle`. The renderer calls `ipcRenderer.invoke('atv:*')` instead of sending WebSocket messages. The Python server, shell scripts, WebSocket client, and all Python-related infrastructure are removed.

**Tech Stack:** Electron 38, node-appletv-remote (npm), Electron IPC

**Key library API reference (node-appletv-remote):**
- `scan({ timeout, filter })` → `DiscoveredDevice[]` — each has `.name`, `.address`, `.port`, `.deviceId`, `.model`
- `new AppleTV(discoveredDevice)` then `.startPairing()` → `PairSetup`
- `pairSetup.finish(pin)` → `HAPCredentials`
- `new Credentials(hapCreds)` then `.serialize()` / `Credentials.deserialize(json)`
- `atv.connect(credentials)` → void
- `atv.sendKeyCommand(Key.PlayPause)` etc — Key enum: `Up, Down, Left, Right, Select, Menu, Home, HomeHold, TopMenu, PlayPause, Play, Pause, Next, Previous, SkipForward, SkipBackward, VolumeUp, VolumeDown, Suspend, Wake`
- Events: `connect`, `close`, `error`, `nowPlaying`, `supportedCommands`, `playbackQueue`, `message`
- `atv.close()` — disconnect

**Credential format change:** pyatv credentials (AirPlay + Companion protocol strings + identifier) are NOT compatible with `node-appletv-remote` HAP credentials. Users must re-pair after migration. Old credentials in localStorage will be cleared on first run.

---

## Task 1: Install node-appletv-remote and remove Python dependencies

**Files:**
- Modify: `app/package.json` — add `node-appletv-remote`, remove `ws`
- Modify: `package.json` — remove `embed` script

**Step 1: Update app/package.json**

Replace the dependencies block:
```json
{
  "dependencies": {
    "@electron/remote": "^2.1.2",
    "bluebird": "^3.7.2",
    "electron-positioner": "^4.1.0",
    "jquery": "^3.5.1",
    "menubar": "^9.0.2",
    "node-appletv-remote": "latest"
  }
}
```

Note: `ws` is removed. `bluebird` can stay for now (used elsewhere or not — cleanup later).

**Step 2: Remove embed script from root package.json**

In `package.json` scripts, remove the `"embed"` line:
```
"embed": "node build/create_python_embed.js --overwrite",
```

**Step 3: Install**

Run: `cd /Users/tedslesinski/Repos/atv-remote/atv-desktop-remote && pnpm install`
Expected: Installs successfully, `node-appletv-remote` appears in `node_modules`

**Step 4: Verify the library loads**

Run: `cd /Users/tedslesinski/Repos/atv-remote/atv-desktop-remote && node -e "const atv = require('node-appletv-remote'); console.log(Object.keys(atv))"`
Expected: Prints array including `scan`, `AppleTV`, `Key`, `Credentials`, etc. If this fails with ESM errors, the library may be ESM-only — in that case use dynamic `import()` in atv_service.js instead of `require()`.

**Step 5: Commit**

```bash
git add app/package.json package.json pnpm-lock.yaml
git commit -m "deps: add node-appletv-remote, remove ws dependency"
```

---

## Task 2: Create `app/atv_service.js` — the core Apple TV service

**Files:**
- Create: `app/atv_service.js`

This module runs in the main process. It wraps `node-appletv-remote` and exposes methods that `main.js` will bind to IPC handlers.

**Step 1: Create the service module**

Create `app/atv_service.js` with this content:

```javascript
const EventEmitter = require('events');

// node-appletv-remote may be ESM-only. Use dynamic import wrapper.
let atvLib = null;
async function getLib() {
  if (!atvLib) {
    atvLib = await import('node-appletv-remote');
  }
  return atvLib;
}

class ATVService extends EventEmitter {
  constructor() {
    super();
    this.device = null;         // AppleTV instance
    this.scanResults = {};      // name → DiscoveredDevice
    this.pairingSession = null; // PairSetup instance
    this.reconnecting = false;
  }

  async scan(timeout = 5000) {
    const { scan } = await getLib();
    const devices = await scan({
      timeout,
      filter: (d) => d.model && d.model.toLowerCase().includes('tv')
    });
    this.scanResults = {};
    const results = devices.map(d => {
      const label = `${d.name} (${d.address})`;
      this.scanResults[label] = d;
      return label;
    });
    return results;
  }

  async startPair(deviceLabel) {
    const { AppleTV } = await getLib();
    const discoveredDevice = this.scanResults[deviceLabel];
    if (!discoveredDevice) throw new Error(`Device not found: ${deviceLabel}`);
    this.device = new AppleTV(discoveredDevice);
    this.pairingSession = await this.device.startPairing();
  }

  async finishPair(pin) {
    if (!this.pairingSession) throw new Error('No active pairing session');
    const { Credentials } = await getLib();
    const hapCreds = await this.pairingSession.finish(pin);
    const credentials = new Credentials(hapCreds);
    const serialized = credentials.serialize();
    const deviceId = Object.keys(this.scanResults).find(
      k => this.scanResults[k] === this._getPairedDiscoveredDevice()
    );
    this.pairingSession = null;
    return {
      credentials: serialized,
      identifier: this.device.deviceId || deviceId || 'unknown'
    };
  }

  _getPairedDiscoveredDevice() {
    // Find the DiscoveredDevice that matches current device
    for (const [label, d] of Object.entries(this.scanResults)) {
      if (this.device && d.address === this.device.address) return d;
    }
    return null;
  }

  async connect(credsData) {
    const { AppleTV, Credentials, scan } = await getLib();

    // Parse stored credentials
    const credentials = Credentials.deserialize(credsData.credentials);

    // If we don't have a device instance, scan for it
    if (!this.device) {
      const devices = await scan({ timeout: 5000 });
      const match = devices.find(d => d.deviceId === credsData.identifier);
      if (!match) {
        this.emit('connection-failure');
        throw new Error('Device not found on network');
      }
      this.device = new AppleTV(match);
    }

    try {
      await this.device.connect(credentials);
      this._setupListeners();
      this.emit('connected');
    } catch (err) {
      this.emit('connection-failure');
      throw err;
    }
  }

  _setupListeners() {
    if (!this.device) return;

    this.device.removeAllListeners();

    this.device.on('close', () => {
      this.emit('connection-lost');
      // Could attempt reconnection here in future
    });

    this.device.on('error', (err) => {
      console.error('ATV error:', err);
      this.emit('error', err);
    });

    this.device.on('nowPlaying', (info) => {
      this.emit('now-playing', info);
    });
  }

  async sendKey(keyName, action) {
    if (!this.device) throw new Error('Not connected');
    const { Key } = await getLib();

    // Map string key names to Key enum values
    const keyMap = {
      'play_pause': Key.PlayPause,
      'left': Key.Left,
      'right': Key.Right,
      'down': Key.Down,
      'up': Key.Up,
      'select': Key.Select,
      'menu': Key.Menu,
      'top_menu': Key.TopMenu,
      'home': Key.Home,
      'home_hold': Key.HomeHold,
      'skip_backward': Key.SkipBackward,
      'skip_forward': Key.SkipForward,
      'volume_up': Key.VolumeUp,
      'volume_down': Key.VolumeDown,
    };

    const key = keyMap[keyName];
    if (key === undefined) throw new Error(`Unknown key: ${keyName}`);

    await this.device.sendKeyCommand(key);
  }

  async disconnect() {
    if (this.device) {
      try {
        await this.device.close();
      } catch (err) {
        console.error('Error closing device:', err);
      }
      this.device = null;
    }
    this.emit('disconnected');
  }

  isConnected() {
    return this.device !== null;
  }

  async destroy() {
    await this.disconnect();
    this.scanResults = {};
    this.pairingSession = null;
    this.removeAllListeners();
  }
}

module.exports = ATVService;
```

**Step 2: Verify it loads**

Run: `cd /Users/tedslesinski/Repos/atv-remote/atv-desktop-remote && node -e "const ATVService = require('./app/atv_service'); const s = new ATVService(); console.log('loaded, methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter(m => m !== 'constructor'))"`
Expected: Prints method names without errors

**Step 3: Commit**

```bash
git add app/atv_service.js
git commit -m "feat: add ATVService wrapping node-appletv-remote"
```

---

## Task 3: Wire IPC handlers in `app/main.js`

**Files:**
- Modify: `app/main.js`

Replace all Python server references with ATVService IPC handlers. The renderer will call `ipcRenderer.invoke('atv:scan')`, `ipcRenderer.invoke('atv:connect', creds)`, etc.

**Step 1: Replace server_runner imports and startup with ATVService**

At the top of `main.js`, replace:
```javascript
const server_runner = require('./server_runner')
server_runner.startServer();

global["server_runner"] = server_runner;
```

With:
```javascript
const ATVService = require('./atv_service');
const atvService = new ATVService();

global["atvService"] = atvService;
```

**Step 2: Remove all server_runner references throughout the file**

Remove these lines/blocks:
- `server_runner.stopServer();` in the `quit` handler (~line 166)
- `server_runner.stopServer();` in `before-quit` handler (~line 377)
- `server_runner.isServerRunning()` checks and `wsserver_started` sends (~lines 187-232)
- `server_runner.testPythonExists()` block (~lines 355-359)
- `ipcMain.handle('isWSRunning', ...)` handler
- `ipcMain.handle('kbfocus', ...)` handler (keyboard focus polling — stub for now)
- `ipcMain.handle('kbfocus-status', ...)` handler

**Step 3: Add IPC handlers for ATVService**

After the existing `ipcMain.handle` blocks inside the `mb.on(readyEvent, ...)` callback, add:

```javascript
// --- ATV Service IPC Handlers ---
ipcMain.handle('atv:scan', async () => {
  return await atvService.scan();
});

ipcMain.handle('atv:startPair', async (event, deviceLabel) => {
  await atvService.startPair(deviceLabel);
});

ipcMain.handle('atv:finishPair', async (event, pin) => {
  return await atvService.finishPair(pin);
});

ipcMain.handle('atv:connect', async (event, creds) => {
  await atvService.connect(creds);
});

ipcMain.handle('atv:disconnect', async () => {
  await atvService.disconnect();
});

ipcMain.handle('atv:sendKey', async (event, key, action) => {
  await atvService.sendKey(key, action);
});

ipcMain.handle('atv:isConnected', () => {
  return atvService.isConnected();
});

// Forward ATVService events to renderer
atvService.on('connected', () => {
  win.webContents.send('atv:connected');
});
atvService.on('connection-failure', () => {
  win.webContents.send('atv:connection-failure');
});
atvService.on('connection-lost', () => {
  win.webContents.send('atv:connection-lost');
});
atvService.on('disconnected', () => {
  win.webContents.send('atv:disconnected');
});
atvService.on('now-playing', (info) => {
  win.webContents.send('atv:now-playing', info);
});
```

**Step 4: Update quit and before-quit to use atvService**

Replace `server_runner.stopServer()` calls with:
```javascript
atvService.destroy();
```

**Step 5: Remove the "wsserver_started" readiness gate**

The Python server needed a startup signal. The Node service is ready immediately. Remove the `wsserver_started` IPC send calls and the `isWSRunning` handler. The renderer will be updated in the next task to not wait for this signal.

**Step 6: Commit**

```bash
git add app/main.js
git commit -m "feat: wire ATVService IPC handlers in main process, remove server_runner"
```

---

## Task 4: Rewrite `app/ws_remote.js` → `app/atv_remote.js` (renderer-side IPC client)

**Files:**
- Create: `app/atv_remote.js` (replaces `ws_remote.js`)
- Modify: `app/index.html` — change script reference

This replaces all WebSocket communication with direct IPC calls. The public function names stay the same where possible so `web_remote.js` needs minimal changes.

**Step 1: Create `app/atv_remote.js`**

```javascript
const { ipcRenderer } = require('electron');
const EventEmitter = require('events');

var atv_connected = false;
var connection_failure = false;
var ws_pairDevice = "";

var atv_events = new EventEmitter();

// Listen for main process events
ipcRenderer.on('atv:connected', () => {
  atv_connected = true;
  connection_failure = false;
  atv_events.emit('connected', true);
});

ipcRenderer.on('atv:connection-failure', () => {
  atv_connected = false;
  connection_failure = true;
  atv_events.emit('connection_failure');
});

ipcRenderer.on('atv:connection-lost', () => {
  atv_connected = false;
  atv_events.emit('connected', false);
});

ipcRenderer.on('atv:disconnected', () => {
  atv_connected = false;
  atv_events.emit('connected', false);
});

ipcRenderer.on('atv:now-playing', (event, info) => {
  atv_events.emit('now-playing', info);
});

// --- Public API (same names as ws_remote.js for compatibility) ---

async function ws_startScan() {
  connection_failure = false;
  try {
    var results = await ipcRenderer.invoke('atv:scan');
    createDropdown(results);
  } catch (err) {
    console.error('Scan failed:', err);
  }
}

function ws_sendCommand(cmd) {
  ipcRenderer.invoke('atv:sendKey', cmd).catch(err => {
    console.error('sendKey failed:', err);
  });
}

function ws_sendCommandAction(cmd, taction) {
  // taction: 'Hold', 'DoubleTap', 'SingleTap'
  // node-appletv-remote doesn't support input actions yet — send as normal key
  ipcRenderer.invoke('atv:sendKey', cmd, taction).catch(err => {
    console.error('sendKey failed:', err);
  });
}

function ws_connect(creds) {
  return new Promise((resolve, reject) => {
    ipcRenderer.invoke('atv:connect', creds).then(() => {
      resolve();
    }).catch(err => {
      connection_failure = true;
      atv_events.emit('connection_failure');
      reject(err);
    });
  });
}

function ws_startPair(dev) {
  connection_failure = false;
  ws_pairDevice = dev;
  ipcRenderer.invoke('atv:startPair', dev).catch(err => {
    console.error('startPair failed:', err);
  });
}

// Single-step pairing (replaces ws_finishPair1 + ws_finishPair2)
async function ws_finishPair1(code) {
  connection_failure = false;
  try {
    var result = await ipcRenderer.invoke('atv:finishPair', code);
    // result = { credentials, identifier }
    saveRemote(ws_pairDevice, result);
    localStorage.setItem('atvcreds', JSON.stringify(result));
    connectToATV();
  } catch (err) {
    console.error('finishPair failed:', err);
  }
}

// finishPair2 is no longer needed — single-step pairing
// Keep as no-op in case UI calls it during transition
function ws_finishPair2(code) {
  console.warn('ws_finishPair2 called but single-step pairing is active — this is a no-op');
}

function ws_is_connected() {
  return ipcRenderer.invoke('atv:isConnected');
}

// --- Initialization ---
// No WebSocket to start. Service is ready immediately.
function ws_init() {
  console.log('atv_remote init (no WebSocket needed)');
  // Trigger init flow directly
  init().then(() => {
    console.log('init complete');
  });
}

function ws_server_started() {
  // No-op — kept for compatibility during transition
  console.log('ws_server_started called (no-op in IPC mode)');
}

function incReady() {
  // Simplified: just call ws_init when DOM is ready
}

$(function() {
  ws_init();
});
```

**Step 2: Update `app/index.html`**

Find the `<script>` tag that loads `ws_remote.js` and change it to `atv_remote.js`:
```html
<script src="atv_remote.js"></script>
```

**Step 3: Commit**

```bash
git add app/atv_remote.js app/index.html
git commit -m "feat: replace WebSocket client with IPC-based atv_remote.js"
```

---

## Task 5: Update `app/web_remote.js` for single-step pairing and IPC

**Files:**
- Modify: `app/web_remote.js`

**Step 1: Simplify the pairing UI flow**

The old flow had two PIN steps (AirPlay then Companion). Now it's one step. Modify `submitCode()`:

```javascript
function submitCode() {
  var code = $("#pairCode").val();
  $("#pairCode").val("");
  ws_finishPair1(code);
}
```

Remove the step 2 UI logic. In `createDropdown()`, change the initial protocol name:
```javascript
$("#pairStepNum").html("1");
$("#pairProtocolName").html("Apple TV");
```

**Step 2: Remove the `startPair2` message handler**

In `ws_remote.js` (now `atv_remote.js`), the `startPair2` response no longer exists. The old `ws_remote.js` handled `j.command == "startPair2"` to switch to step 2 — this is already gone since we rewrote that file.

**Step 3: Remove `wsserver_started` IPC listener**

In `initIPC()`, remove:
```javascript
ipcRenderer.on('wsserver_started', () => {
    ws_server_started();
});
```

**Step 4: Remove `kbfocus` polling and inline keyboard (temporary)**

In `showKeyMap()`, remove or comment out the keyboard focus polling block (~lines 592-605):
```javascript
// Keyboard focus detection requires Companion protocol support in node-appletv-remote
// TODO: Re-enable when library adds keyboard focus API
```

Keep the `showInlineKeyboard()` and `hideInlineKeyboard()` functions — they'll be re-enabled later.

**Step 5: Remove the `sendMessage` calls for `kbfocus`, `gettext`, `settext`**

In `initIPC()`, remove:
```javascript
ipcRenderer.on('kbfocus', () => {
    sendMessage('kbfocus')
})
```

In the `input-change` handler, replace `sendMessage("settext", ...)` with a TODO comment:
```javascript
ipcRenderer.on('input-change', (event, data) => {
    // TODO: Re-enable when node-appletv-remote adds text input API
    // ipcRenderer.invoke('atv:setText', data);
});
```

**Step 6: Remove the `readyCount` / `incReady` / `ws_server_started` startup gate**

The old startup waited for both DOM ready AND server started. Now the service is immediately available. The new `atv_remote.js` handles this — just make sure `web_remote.js` doesn't reference `readyCount` or `incReady` (those are defined in `ws_remote.js` which is now replaced).

**Step 7: Commit**

```bash
git add app/web_remote.js
git commit -m "feat: update web_remote for single-step pairing and IPC"
```

---

## Task 6: Delete Python infrastructure files

**Files:**
- Delete: `build/wsserver.py`
- Delete: `build/start_server.sh`
- Delete: `build/start_server.bat`
- Delete: `build/create_python_embed.js`
- Delete: `app/server_runner.js`
- Delete: `app/pyscripts.js`
- Delete: `app/ws_remote.js`
- Modify: `build/entitlements.mac.plist` — remove Python-specific entitlements if present

**Step 1: Delete the files**

```bash
cd /Users/tedslesinski/Repos/atv-remote/atv-desktop-remote
git rm build/wsserver.py build/start_server.sh build/start_server.bat build/create_python_embed.js app/server_runner.js app/pyscripts.js app/ws_remote.js
```

**Step 2: Check entitlements.mac.plist**

Read `build/entitlements.mac.plist`. If it contains entitlements that were only needed for the Python runtime (like `com.apple.security.cs.allow-dyld-environment-variables`), consider removing them. If unsure, leave them — they don't cause harm.

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove Python server, WebSocket client, and related build scripts"
```

---

## Task 7: Update `app/main.js` input window handling

**Files:**
- Modify: `app/main.js`

The input window (`input.html`) was used for keyboard text entry via the Companion protocol. Since that feature is pending upstream library support, simplify the input window handling.

**Step 1: Keep `createInputWindow()` but disable the kbfocus IPC**

Remove these handlers from main.js since they referenced the old WebSocket flow:
```javascript
ipcMain.handle('current-text', ...)
ipcMain.handle('kbfocus-status', ...)
ipcMain.handle('kbfocus', ...)
```

The input window can stay created but hidden — it will be reactivated when the library adds keyboard focus support.

**Step 2: Commit**

```bash
git add app/main.js
git commit -m "chore: disable keyboard focus IPC handlers pending library support"
```

---

## Task 8: Handle credential migration

**Files:**
- Modify: `app/atv_remote.js`

Old pyatv credentials stored in localStorage are incompatible. On first run after migration, detect and clear them.

**Step 1: Add migration check to `ws_init()`**

In `atv_remote.js`, at the start of `ws_init()`:

```javascript
function ws_init() {
  console.log('atv_remote init');

  // Migrate from pyatv credentials format
  var existingCreds = localStorage.getItem('atvcreds');
  if (existingCreds) {
    try {
      var parsed = JSON.parse(existingCreds);
      // pyatv creds have "identifier" + "credentials" as a protocol string
      // node-appletv-remote creds have "credentials" as a JSON-serialized HAP object
      // Detect old format: old creds.credentials is a short opaque string, not JSON
      if (parsed.credentials && typeof parsed.credentials === 'string') {
        try {
          JSON.parse(parsed.credentials);
          // If it parses as JSON, it's new format — keep it
        } catch {
          // Not JSON — old pyatv format, clear it
          console.log('Clearing incompatible pyatv credentials');
          localStorage.removeItem('atvcreds');
          localStorage.removeItem('remote_credentials');
        }
      }
    } catch {
      localStorage.removeItem('atvcreds');
    }
  }

  init().then(() => {
    console.log('init complete');
  });
}
```

**Step 2: Commit**

```bash
git add app/atv_remote.js
git commit -m "feat: detect and clear incompatible pyatv credentials on startup"
```

---

## Task 9: Smoke test the full flow

**Files:** None (manual testing)

**Step 1: Start the app**

Run: `cd /Users/tedslesinski/Repos/atv-remote/atv-desktop-remote && pnpm start`
Expected: App launches in menubar without errors. No Python process spawned.

**Step 2: Check for console errors**

Open DevTools (Cmd+Option+I in the app window). Look for:
- No `WebSocket` errors
- No `server_runner` errors
- No `python` references
- The init flow should log `atv_remote init` then `init complete`

**Step 3: Test scan**

Click "Pair new device". Should trigger a 5-second mDNS scan and show discovered Apple TVs in the dropdown (or empty list if none on network).

**Step 4: Test pairing**

Select a device from the dropdown. Enter the PIN shown on the TV screen. Should complete in a single step (no "Step 2" prompt). Credentials should be saved to localStorage.

**Step 5: Test remote control**

After pairing, the remote UI should appear. Test:
- Arrow keys → navigation
- Enter → select
- Space → play/pause
- Backspace → menu
- t → home
- Touchpad gestures

**Step 6: Test reconnection**

Quit and relaunch the app. It should auto-connect using saved credentials without re-pairing.

**Step 7: Commit final state**

```bash
git add -A
git commit -m "chore: smoke test passed — migration to node-appletv-remote complete"
```

---

## Summary of files changed

| Action | File | Purpose |
|--------|------|---------|
| Create | `app/atv_service.js` | Core Apple TV service wrapping node-appletv-remote |
| Create | `app/atv_remote.js` | Renderer-side IPC client (replaces ws_remote.js) |
| Modify | `app/main.js` | Replace server_runner with ATVService + IPC handlers |
| Modify | `app/web_remote.js` | Single-step pairing, remove kbfocus polling |
| Modify | `app/index.html` | Script tag: ws_remote.js → atv_remote.js |
| Modify | `app/package.json` | Add node-appletv-remote, remove ws |
| Modify | `package.json` | Remove embed script |
| Delete | `build/wsserver.py` | Python WebSocket server |
| Delete | `build/start_server.sh` | macOS server launcher |
| Delete | `build/start_server.bat` | Windows server launcher |
| Delete | `build/create_python_embed.js` | Python script embedder |
| Delete | `app/server_runner.js` | Python process manager |
| Delete | `app/pyscripts.js` | Embedded Python scripts |
| Delete | `app/ws_remote.js` | WebSocket client |

## Features temporarily disabled (pending library support)

- Keyboard focus detection (Companion protocol `kbfocus`)
- Text input get/set (Companion protocol `settext` / `gettext`)
- Power state change events
- Input action types (Hold, DoubleTap) — keys sent as simple presses for now

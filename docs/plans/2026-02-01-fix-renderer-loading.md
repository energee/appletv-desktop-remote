# Fix Renderer Script Loading — Bug Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the renderer crash that prevents the app from working after the node-appletv-remote migration.

**Root cause:** After migrating from `ws_remote.js` to `atv_remote.js`, the renderer scripts fail to initialize properly. Debug logging revealed: `Uncaught ReferenceError: init is not defined` — meaning `web_remote.js` is not executing in the renderer, so its globally-scoped functions (`initIPC`, `init`, `connectToATV`, etc.) are undefined when `atv_remote.js` tries to call them.

**Architecture context:** This is an Electron menubar app. The renderer loads two script files via `<script src>` tags in `app/index.html`. Both scripts define functions in global scope that cross-reference each other. The `<script>` tags are loaded synchronously in order.

**Current file state:**
- `app/index.html` loads `web_remote.js` then `atv_remote.js` (line 117-118)
- `app/atv_remote.js` — defines `atv_events`, `ws_startScan`, `ws_sendCommand`, `ws_connect`, etc. Has `$(function() { initIPC(); ws_init(); })` at bottom
- `app/web_remote.js` — defines `initIPC`, `init`, `connectToATV`, `startScan`, UI handlers. Has no `$(function(){})` at bottom (removed during migration, was previously `$(function(){ initIPC(); })`)

---

## Diagnosis needed

The key question: **why does `web_remote.js` not execute?**

Possible causes:
1. **A `require()` call at the top of `web_remote.js` is failing** — e.g. `require('./js/lodash.min')`, `require('electron')`, `require('@electron/remote')`, or `require('path')`. If any throws, the entire script stops and no functions get defined.
2. **The `require('electron')` or `require('@electron/remote')` calls work fine on their own** but something else at the module top level crashes (unlikely since syntax check passes).
3. **Electron's script loading with `nodeIntegration: true`** may scope scripts as modules, preventing global function definitions. This seems unlikely since the old code worked the same way.

## Task 1: Investigate why `web_remote.js` doesn't execute

**Files:**
- Read: `app/web_remote.js` (lines 1-30 — the top-level code)
- Read: `app/index.html` (verify script tags)

**Step 1: Wrap `web_remote.js` top-level code in try/catch to catch silent failures**

Temporarily wrap the entire contents of `web_remote.js` in:
```javascript
try {
// ... existing code ...
} catch(e) {
  document.title = 'ERROR: ' + e.message;
  console.error('web_remote.js failed to load:', e);
}
```

Or, alternatively, add a `window.onerror` handler at the very top of `index.html` before any script tags:
```html
<script>
window.onerror = function(msg, src, line, col, err) {
  document.title = 'ERR: ' + msg + ' at ' + src + ':' + line;
  return false;
};
</script>
```

This approach catches errors from ANY script and puts them in the window title (visible in the menubar app even if console isn't accessible).

**Step 2: Launch the app**

Run: `pnpm start`
Check the window title for the error message.

**Step 3: Identify the failing line**

The error message and line number will reveal which `require()` or top-level statement is failing.

---

## Task 2: Fix the identified issue

Once we know which line crashes, fix it. Common scenarios:

**Scenario A: `require()` path is wrong in the renderer context**

The renderer runs from the `app/` directory when loaded via `loadFile`. If `require('./js/lodash.min')` fails, the working directory may differ. Fix by using `__dirname`:
```javascript
var lodash = _ = require(path.join(__dirname, 'js', 'lodash.min'));
```

**Scenario B: `require('@electron/remote')` is not enabled yet**

The `@electron/remote` module requires `require("@electron/remote/main").enable(webContents)` to be called in the main process BEFORE the renderer tries to `require('@electron/remote')`. In the old flow, the Python server startup delay ensured this happened in time. Now, the preloaded window may try to load scripts before `enable()` runs.

Fix: Move the `@electron/remote` require inside `initializeRemote()` (already the case) and ensure `initializeRemote()` retries. Or add a `preload` script to the BrowserWindow config that handles this.

**Scenario C: Module scoping issue**

If Electron treats `<script src>` files as CommonJS modules (putting them in their own scope), functions defined with `function foo(){}` won't be global. Fix by explicitly attaching to `window`:
```javascript
window.initIPC = function() { ... }
window.init = async function() { ... }
```

Or consolidate both scripts into one file.

---

## Task 3: Consolidation alternative (if root cause is scoping)

If the issue is module scoping, the cleanest fix is to merge `atv_remote.js` and `web_remote.js` into a single `app/remote.js` file, or have one `require()` the other:

In `app/index.html`:
```html
<script>
  require('./atv_remote.js');
  require('./web_remote.js');
</script>
```

Or use a single entry point:
```html
<script src="remote_init.js"></script>
```

Where `remote_init.js` does:
```javascript
require('./atv_remote.js');
require('./web_remote.js');
$(function() {
    initIPC();
    ws_init();
});
```

---

## Task 4: Verify both original issues are fixed

1. **Scanning**: App should scan, find devices, and show dropdown (not spin forever)
2. **Right-click menu**: Right-clicking the menubar icon should show the context menu (Devices, Appearance, etc.)
3. **No console errors**: DevTools should show no uncaught errors

---

## Task 5: Remove debug artifacts and commit

- Remove any try/catch wrappers or `window.onerror` handlers added for diagnosis
- Remove `getWorkingPath()` in `main.js` if still unused
- Clean up any empty lines from debug removal
- Commit the fix

---

## Key files reference

| File | Role | Key globals it defines |
|------|------|----------------------|
| `app/atv_remote.js` | IPC client (replaces ws_remote.js) | `atv_events`, `atv_connected`, `ws_startScan`, `ws_sendCommand`, `ws_connect`, `ws_startPair`, `ws_finishPair1`, `ws_finishPair2`, `ws_init` |
| `app/web_remote.js` | UI logic, remote control | `initIPC`, `init`, `connectToATV`, `startScan`, `sendCommand`, `createDropdown`, `showKeyMap`, `handleContextMenu`, `isConnected`, `getCreds`, `saveRemote` |
| `app/index.html` | HTML, loads both scripts | — |
| `app/main.js` | Main process, IPC handlers | `atvService` (global), `mb` (menubar) |
| `app/atv_service.js` | Apple TV service | ATVService class |

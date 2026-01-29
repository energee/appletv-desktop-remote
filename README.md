# ATV Desktop Remote

A menubar app to control an Apple TV from your desktop.

<p align="center">
  <img src="light.png" alt="ATV Remote — Light Mode" width="270"/>
  &nbsp;&nbsp;
  <img src="dark.png" alt="ATV Remote — Dark Mode" width="270"/>
</p>

## Installation

macOS and Windows builds are available on the [releases page](https://github.com/energee/appletv-desktop-remote/releases).

## Usage

- The app runs in the menubar — click the remote icon to open, right-click for options.
- Use the **touchpad** to swipe or tap, just like a real Apple TV remote.
- **Long-press** any button to simulate a long press on the remote.
- Hold **Option** (or **Alt** on Windows) to reveal keyboard shortcuts.
- Press `Cmd+Shift+R` to open the app from anywhere (`Win+Shift+R` on Windows).

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow keys | Navigate |
| Enter | Select |
| Space | Play / Pause |
| Esc / Backspace | Menu |
| T | Home (TV) |
| L | Long-press Home |
| G | Top Menu |
| [ / ] | Skip backward / forward |
| + / - | Volume up / down |

## Running from Source

1. `pnpm install` 
2. `pnpm start`
3. The first time the app runs it will pair with an Apple TV. You can pair with more than one device.

## Building

`electron-builder` is used to create a standalone application.
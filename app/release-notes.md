## More reliable pairing and remote controls

- Companion reconnects with saved pairing keys independently of the main remote. Rejected keys and failed pairing prompts offer an explicit pairing retry.
- Canceling pairing releases its session and pending transport without adopting canceled credentials.
- Device switches and removals are ordered, and pending holds and mouse releases cannot activate the newly selected TV.
- Remote buttons are named, keyboard-accessible controls. Settings navigation no longer sends TV commands; holding Enter activates playback and other non-repeating buttons once.
- Smooth scrolling coalesces busy-backend movement while preserving final positions and releases, including successive gestures during a slow release.
- Secure-storage replacement and backup export preserve existing data when a write fails. Hotkey errors remain visible and retryable without silently replacing a working shortcut.
- Backend requests have bounded I/O deadlines, and returning focus cancels a pending automatic window hide.

## Downloads and feedback

- Clear Apple silicon, Intel Mac, and Windows download choices are available on the project page, with structured bug reports and usage feedback.
- The website's interactive remote is a practice simulation; it does not control a real Apple TV.

## Installation caveats

The Mac app is not notarized. macOS may require **System Settings → Privacy & Security → Open Anyway** for its first launch. Windows may show a SmartScreen warning. Your computer and Apple TV must be on the same network.

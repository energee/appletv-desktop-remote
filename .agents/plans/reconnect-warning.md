# Stale Companion warning after Wi-Fi recovery

## Observation

- User returned to the Wi-Fi network and reports the remote works, but Connection lost remains visible.
- Read-only native accessibility inspection confirmed the warning alongside playback information. No TV commands were sent.
- The exact current Companion backend state was not captured; working basic controls do not establish that Companion has recovered.

## Cause and change

- The inline Companion banner previously cleared only on connected, leaving an old error visible through error-free connecting or unpaired transitions.
- Clear the inline banner on every error-free Companion state. Current errors still render, including errors attached to connected states.
- One production-line change. No reconnection, pairing, transport, or playback logic changes.

## Verification

- Before: regression cases for connecting and unpaired failed; connected recovery and current-error display passed.
- After: all four regressions and the full 141-test suite pass. TypeScript, targeted ESLint, and renderer compilation pass.
- Actual browser smoke confirms stale errors clear for connecting, unpaired, and connected; a new current error remains visible. Screenshot captured after recovery.
- Source simplification review kept the existing error-first branch and removed only the overly narrow connected condition.

## Delivery limits

- Open a focused PR; do not auto-merge or publish a release.
- The installed app is unchanged. A real Wi-Fi reconnect on the updated native build has not been exercised.

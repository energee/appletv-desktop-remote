# Initial playback metadata

## Observation

- User reports a persistent missing playing title and seek bar on Master Bedroom.
- The same controls work on Family Room, a newer Apple TV. Exact receiver/tvOS compatibility cause is not established.
- Live acceptance ended at the user's request. No further TV commands or pairing changes are required for this work.

## Source-proved gap and change

- Connection previously subscribed to playback updates but did not request the current playback queue.
- The SDK connection handshake does not guarantee a metadata snapshot. Its cache-first getNowPlaying() also accepts a state-only snapshot, so it cannot reliably fill this gap.
- Request getState() once after connection. The SDK's existing bounded request decodes the response through its normal now-playing event path; no polling, duplicate events, renderer retention, or new dependency.
- Ignore protocol error 35 (no current now-playing client) for idle receivers; forward unexpected errors without disconnecting the remote. Ignore a replaced device's late failure.

## Verification

- [x] Reproduced missing metadata before the fix with the real SDK handshake and protobuf decoder against an offline peer: both silent and state-only startup cases failed to deliver the already-playing item.
- [x] The same cases pass after the initial queue read, including title, duration, elapsed time, playback state, and app identity.
- [x] Idle and unexpected-error cases preserve the connection with appropriate error handling.
- [x] All 137 tests pass; TypeScript, targeted ESLint, renderer build, and native sidecar packaging pass.
- [x] Standalone Node protocol smoke emits title 'Offline playback fixture', duration 600, and elapsed time 30 through the actual service and SDK decoder, without network sockets.
- [x] Actual browser renderer displays that normalized payload: title visible, seek visible, maximum 600, duration 10:00, seek height 28px. Empty metadata hides both; complete metadata restores both. Browser screenshot capture timed out, so no screenshot proof is claimed.
- [ ] Confirm title and seeking on the older Master Bedroom TV when the user is back on its network. The offline regression proves the startup gap, not that it is the exact live cause.

## Delivery

- Focused source fix, behavioral regressions, and README update; no release/version change.
- Prior live acceptance results are merged in PR #80 and recorded in v0.7.3.md.

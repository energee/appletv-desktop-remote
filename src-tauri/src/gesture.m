// Watches the app's scroll events for macos_gesture.rs, which calls atv_scroll_gesture_began when
// fingers start a new trackpad scroll. Momentum events, sent after the fingers lift, carry no
// phase (only a momentumPhase), so they never call it.
#import <Cocoa/Cocoa.h>

extern void atv_scroll_gesture_began(void);

void atv_register_scroll_gesture_monitor(void) {
  [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                        handler:^NSEvent *(NSEvent *event) {
    // MayBegin: fingers touched the trackpad (this also stops running momentum).
    if (event.phase & (NSEventPhaseMayBegin | NSEventPhaseBegan)) atv_scroll_gesture_began();
    return event;
  }];
}

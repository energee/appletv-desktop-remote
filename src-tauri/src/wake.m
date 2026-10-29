// Registers the NSWorkspace wake observer for macos_wake.rs, which calls atv_power_did_wake.
#import <Cocoa/Cocoa.h>

extern void atv_power_did_wake(void);

void atv_register_wake_observer(void) {
  NSNotificationCenter *center = [[NSWorkspace sharedWorkspace] notificationCenter];
  [center addObserverForName:NSWorkspaceDidWakeNotification
                      object:nil
                       queue:[NSOperationQueue mainQueue]
                  usingBlock:^(__unused NSNotification *notification) {
    atv_power_did_wake();
  }];
}

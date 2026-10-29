// Rounds the main window for lib.rs. The window is transparent with a Liquid Glass background
// (tauri.conf.json windowEffects); the glass draws a soft shadow around its rounded edge, which
// the square window would cut off into visible square corners. Clipping the content view to the
// glass's radius removes everything outside the rounded shape.
#import <Cocoa/Cocoa.h>

void atv_round_window_corners(void *ns_window, double radius) {
  NSView *view = [(__bridge NSWindow *)ns_window contentView];
  view.wantsLayer = YES;
  view.layer.cornerRadius = radius;
  view.layer.masksToBounds = YES;
}

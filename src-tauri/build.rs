//! Compiles the macOS wake observer (src/wake.m), scroll gesture monitor (src/gesture.m), and
//! window corner clipping (src/corners.m) when targeting macOS, then runs Tauri's build step, which generates the app context from
//! tauri.conf.json.
fn main() {
    // A build script's own cfg!(target_os) is the host's, so read the target from cargo.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // tauri_build emits rerun-if-changed lines, which turn off cargo's default of rerunning
        // on any package change, so the Objective-C source must be listed explicitly.
        println!("cargo:rerun-if-changed=src/wake.m");
        println!("cargo:rerun-if-changed=src/gesture.m");
        println!("cargo:rerun-if-changed=src/corners.m");
        cc::Build::new()
            .file("src/wake.m")
            .file("src/gesture.m")
            .file("src/corners.m")
            .flag("-fblocks")
            .compile("atv_macos_native");
        println!("cargo:rustc-link-lib=framework=Cocoa");
    }
    tauri_build::build()
}

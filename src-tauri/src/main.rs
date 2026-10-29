//! Binary entry point; the app lives in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    atv_desktop_remote_lib::run();
}

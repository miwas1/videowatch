fn main() {
    #[cfg(feature = "tauri-app")]
    describeops_companion::run();

    #[cfg(not(feature = "tauri-app"))]
    eprintln!("Build with --features tauri-app to run the Tauri desktop shell.");
}

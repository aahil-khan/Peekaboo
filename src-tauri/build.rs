fn main() {
    // Built-in plugins are embedded with include_dir!, which cargo cannot see
    // through — without this, editing a plugin's JS leaves the old copy baked
    // into the binary and the change appears to do nothing.
    println!("cargo:rerun-if-changed=../plugins");

    tauri_build::build()
}

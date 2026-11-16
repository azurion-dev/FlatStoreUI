# FlatStore (Rust + Tauri v2)

A Flathub store client: browse, search, install, open and remove apps (via the `flatpak` CLI).
Icons are already in `src-tauri/icons/` (generated from `src/assets/flatstore-icon.svg`).

    cd src-tauri
    cargo tauri dev
    cargo tauri build --no-bundle    # release binary: target/release/flatstore

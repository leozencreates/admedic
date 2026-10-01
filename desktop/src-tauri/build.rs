fn main() {
    // Uygulama komutları ACL'ye bağlanır: her komut yetenek dosyasında ayrıca izinlenmelidir
    // (`allow-set-server-origin`, capabilities/default.json). Uzak panel hiçbir uygulama komutunu çağıramaz.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["set_server_origin"])),
    )
    .expect("tauri derleme betiği başarısız oldu");
}

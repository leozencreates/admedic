// ADR-0003 (desktop/README.md): Bu kabuk yalnızca web paneli host eden REST'i sarar.
// Tüm veri/http köprüleri frontend (../ui) üzerinden @admedic/api REST'ine gider;
// Rust tarafında REST istemcisi/iş mantığı barındırılmaz (delegasyon — ÇMK).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("admedic masaüstü başlatılamadı");
}

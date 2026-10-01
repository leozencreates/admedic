// ADR-0025: kabuk, sunucudaki web panelini saran ince istemcidir.
// Gömülü bağlantı ekranı (../ui) sunucu adresini sorar ve pencereyi o adresteki panele götürür.
// Rust tarafında REST istemcisi ya da iş mantığı yoktur; uzak panele IPC yetkisi verilmez.
// Tek komut `set_server_origin`: yalnızca gömülü bağlantı ekranı çağırabilir; mikrofon izni o origin'e bağlanır
// (mic_permission.rs, ADR-0028 Faz 5).

mod mic_permission;

use mic_permission::{normalize_server_origin, ServerOrigin};

#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
const CHANGE_SERVER_MENU_ID: &str = "change-server";

/// Gömülü bağlantı ekranının adresi. Tauri yerel dosyaları Windows'ta `http://tauri.localhost`,
/// diğer masaüstü platformlarda `tauri://localhost` altında sunar (`useHttpsScheme` kapalıyken).
#[cfg(desktop)]
fn setup_screen_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html?change=1"
    } else {
        "tauri://localhost/index.html?change=1"
    }
}

/// Panel açıkken bağlantı ekranına dönmenin tek yolu bu menüdür (telefonda menü yoktur; bkz. ui/index.js).
#[cfg(desktop)]
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};

    let change = MenuItemBuilder::with_id(CHANGE_SERVER_MENU_ID, "Sunucu adresini değiştir…").build(app)?;
    let connection = SubmenuBuilder::new(app, "Bağlantı").item(&change).build()?;
    // macOS'ta kopyala/yapıştır kısayolları varsayılan menüden gelir; o menü korunur.
    let menu = if cfg!(target_os = "macos") {
        Menu::default(app.handle())?
    } else {
        Menu::new(app)?
    };
    menu.append(&connection)?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        if event.id().as_ref() != CHANGE_SERVER_MENU_ID {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Ok(url) = tauri::Url::parse(setup_screen_url()) {
            let _ = window.navigate(url);
        }
    });
    Ok(())
}

/// Bağlantı ekranı paneli açmadan hemen önce sunucu origin'ini bildirir. Adres `ui/server-url.js` kurallarıyla
/// yeniden doğrulanır; geçersizse kayıt değişmez ve mikrofon o adrese verilmez.
#[tauri::command]
fn set_server_origin(origin: String, state: tauri::State<'_, ServerOrigin>) -> Result<(), String> {
    let origin = normalize_server_origin(&origin).ok_or_else(|| "geçersiz sunucu adresi".to_string())?;
    state.set(origin);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerOrigin::default())
        .invoke_handler(tauri::generate_handler![set_server_origin])
        .setup(|_app| {
            #[cfg(desktop)]
            {
                // Pencere başlığı ürün adıdır; ad koda yazılmaz, derlemede APP_NAME'den gelir (scripts/build-ci.mjs).
                if let (Some(window), Some(name)) = (_app.get_webview_window("main"), _app.config().product_name.clone()) {
                    window.set_title(&name)?;
                }
                install_menu(_app)?;
            }
            #[cfg(windows)]
            if let Some(window) = _app.get_webview_window("main") {
                mic_permission::install(&window, _app.state::<ServerOrigin>().inner().clone())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("masaüstü kabuğu başlatılamadı");
}

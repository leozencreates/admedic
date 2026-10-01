// ADR-0028 Faz 5 / ADR-0025: sesli asistan için mikrofon izni.
//
// YALNIZCA WINDOWS (WebView2). Windows kabuğu yalnızca kullanıcının bağlantı ekranında seçtiği sunucunun origin'ine
// mikrofon verir. Adresi bağlantı
// ekranı (`ui/index.js`) paneli açmadan hemen önce `set_server_origin` komutuyla bildirir; bu komut yalnızca gömülü
// yerel sayfadan çağrılabilir (yetenek dosyasında `remote` yoktur, bkz. capabilities/default.json).
//
// Karar tablosu (`decide`):
// - Mikrofon: istek origin'i kayıtlı sunucu origin'iyle aynıysa izin, değilse ret (Meta OAuth sayfaları,
//   yönlendirme ara sayfaları ve başka origin'deki iframe'ler mikrofon alamaz).
// - Kamera, konum, diğer sensörler: her origin için ret. Panel bunları kullanmaz; sunucu da
//   `Permissions-Policy: camera=(), geolocation=()` gönderir (web/next.config.ts).
// - Diğer tüm türler (bildirim, pano, otomatik oynatma…): dokunulmaz, WebView2'nin varsayılan davranışı sürer.
//
// Bu dosyadaki karar mantığı platformdan bağımsızdır ve birim testlidir; WebView2'ye bağlayan kod yalnızca
// Windows'ta derlenir.
//
// macOS/iOS: bu kural UYGULANMAZ. wry 0.55.1'in WKWebView temsilcisi (`wry_web_view_ui_delegate.rs`,
// `webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:`) origin, çerçeve ve türe
// bakmadan her isteğe izin verir (kamera dahil). Bu yüzden Apple paketlerine mikrofon yetkisi
// (`com.apple.security.device.audio-input`) ve kullanım metni (NSMicrophoneUsageDescription) eklenmez; hazır dosyalar
// `src-tauri/apple-mic-disabled/` altındadır ve bağlı değildir. Apple'da mikrofon, WKWebView temsilcisinde `decide()`
// ile aynı origin denetimi yapılana dek kapalı kalır; asistan yazıyla çalışır (desktop/README.md "Mikrofon").

use std::sync::{Arc, Mutex};

use tauri::Url;

/// Bağlantı ekranının bildirdiği sunucu origin'i (ör. `https://panel.ornek.com`). Uygulama başına tek değer.
#[derive(Default, Clone)]
pub struct ServerOrigin(Arc<Mutex<Option<String>>>);

impl ServerOrigin {
    pub fn set(&self, origin: String) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(origin);
        }
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

/// İzin türleri; WebView2 sabitlerinden bağımsız tutulur ki karar mantığı her platformda sınanabilsin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    Microphone,
    Camera,
    Geolocation,
    OtherSensors,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    /// WebView2'nin varsayılan davranışı (genellikle kullanıcıya sorar).
    Default,
}

const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Bağlantı ekranından gelen adresi doğrular ve origin'e indirger. Kurallar `ui/server-url.js` ile aynıdır:
/// uzak sunucu `https://` olmalı, `http://` yalnızca bu bilgisayar için; kullanıcı adı/parola içeren adres reddedilir.
pub fn normalize_server_origin(input: &str) -> Option<String> {
    let url = Url::parse(input.trim()).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let local = LOCAL_HOSTS.contains(&host);
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return None,
    }
    Some(url.origin().ascii_serialization())
}

/// `request_uri` (WebView2'nin `Uri` değeri: isteyen içeriğin adresi/origin'i) sunucu origin'iyle aynı mı?
/// Şema, ana makine ve kapı birlikte karşılaştırılır; alt alan adı ya da farklı kapı eşleşmez.
pub fn same_origin(request_uri: &str, server_origin: &str) -> bool {
    let (Ok(request), Ok(server)) = (Url::parse(request_uri), Url::parse(server_origin)) else {
        return false;
    };
    let request = request.origin();
    request.is_tuple() && request == server.origin()
}

/// Tek bir izin isteği için karar. `server_origin` henüz bildirilmemişse mikrofon verilmez.
pub fn decide(kind: PermissionKind, request_uri: &str, server_origin: Option<&str>) -> Decision {
    match kind {
        PermissionKind::Microphone => match server_origin {
            Some(server) if same_origin(request_uri, server) => Decision::Allow,
            _ => Decision::Deny,
        },
        PermissionKind::Camera | PermissionKind::Geolocation | PermissionKind::OtherSensors => Decision::Deny,
        PermissionKind::Other => Decision::Default,
    }
}

/// WebView2 `PermissionRequested` olayına karar işleyicisini bağlar (yalnızca Windows).
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow, server: ServerOrigin) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        // SAFETY: with_webview işlevi ana iş parçacığında, WebView2 denetleyicisi canlıyken çağırır.
        if let Err(error) = unsafe { windows_impl::register(&webview.controller(), server) } {
            // İşleyici bağlanamazsa WebView2 varsayılanı (kullanıcıya sorma) sürer; uygulama yine açılır.
            eprintln!("mikrofon izin işleyicisi bağlanamadı: {error}");
        }
    })
}

#[cfg(windows)]
mod windows_impl {
    use super::{decide, Decision, PermissionKind, ServerOrigin};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2PermissionRequestedEventArgs3, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::{Interface, PWSTR};

    fn kind_of(kind: COREWEBVIEW2_PERMISSION_KIND) -> PermissionKind {
        match kind {
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => PermissionKind::Microphone,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA => PermissionKind::Camera,
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => PermissionKind::Geolocation,
            COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => PermissionKind::OtherSensors,
            _ => PermissionKind::Other,
        }
    }

    pub(super) unsafe fn register(
        controller: &ICoreWebView2Controller,
        server: ServerOrigin,
    ) -> windows::core::Result<()> {
        let core = unsafe { controller.CoreWebView2()? };
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            let mut uri = PWSTR::null();
            unsafe {
                args.PermissionKind(&mut kind)?;
                args.Uri(&mut uri)?;
            }
            let uri = take_pwstr(uri);
            let state = match decide(kind_of(kind), &uri, server.get().as_deref()) {
                Decision::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                Decision::Deny => COREWEBVIEW2_PERMISSION_STATE_DENY,
                Decision::Default => return Ok(()),
            };
            unsafe {
                // Karar profile yazılmaz: sunucu adresi değişirse eski izin taşınmaz ve olay her istekte yeniden
                // tetiklenir (ICoreWebView2PermissionRequestedEventArgs3, çalışma zamanı 1.0.1661.34+).
                if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    args3.SetSavesInProfile(false)?;
                }
                args.SetState(state)?;
            }
            Ok(())
        }));
        let mut token = 0_i64;
        unsafe { core.add_PermissionRequested(&handler, &mut token) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://panel.ornek.com";

    #[test]
    fn normalizes_server_origin_like_the_setup_screen() {
        assert_eq!(normalize_server_origin("https://panel.ornek.com/").as_deref(), Some(SERVER));
        assert_eq!(normalize_server_origin(" https://panel.ornek.com/giris?x=1 ").as_deref(), Some(SERVER));
        assert_eq!(
            normalize_server_origin("https://panel.ornek.com:8443").as_deref(),
            Some("https://panel.ornek.com:8443")
        );
        assert_eq!(normalize_server_origin("http://localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(normalize_server_origin("http://127.0.0.1:3000").as_deref(), Some("http://127.0.0.1:3000"));
        assert_eq!(normalize_server_origin("http://[::1]:3000").as_deref(), Some("http://[::1]:3000"));
    }

    #[test]
    fn rejects_insecure_or_odd_server_addresses() {
        assert_eq!(normalize_server_origin("http://panel.ornek.com"), None);
        assert_eq!(normalize_server_origin("https://kullanici:parola@panel.ornek.com"), None);
        assert_eq!(normalize_server_origin("https://kullanici@panel.ornek.com"), None);
        assert_eq!(normalize_server_origin("ftp://panel.ornek.com"), None);
        assert_eq!(normalize_server_origin("file:///C:/panel"), None);
        assert_eq!(normalize_server_origin("http://tauri.localhost"), None);
        assert_eq!(normalize_server_origin("panel.ornek.com"), None);
        assert_eq!(normalize_server_origin(""), None);
    }

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        assert!(same_origin("https://panel.ornek.com/", SERVER));
        assert!(same_origin("https://panel.ornek.com/kampanyalar?id=1", SERVER));
        assert!(same_origin("https://PANEL.ornek.com", SERVER));
        assert!(same_origin("https://panel.ornek.com:443", SERVER));
        assert!(!same_origin("http://panel.ornek.com", SERVER));
        assert!(!same_origin("https://panel.ornek.com:8443", SERVER));
        assert!(!same_origin("https://alt.panel.ornek.com", SERVER));
        assert!(!same_origin("https://panel.ornek.com.kotu.example", SERVER));
        assert!(!same_origin("https://www.facebook.com", SERVER));
        assert!(!same_origin("", SERVER));
        assert!(!same_origin("data:text/html,x", "data:text/html,x"));
    }

    #[test]
    fn microphone_only_for_the_configured_server() {
        assert_eq!(decide(PermissionKind::Microphone, "https://panel.ornek.com/", Some(SERVER)), Decision::Allow);
        assert_eq!(
            decide(PermissionKind::Microphone, "http://localhost:3000/", Some("http://localhost:3000")),
            Decision::Allow
        );
        assert_eq!(decide(PermissionKind::Microphone, "https://www.facebook.com/", Some(SERVER)), Decision::Deny);
        assert_eq!(decide(PermissionKind::Microphone, "https://panel.ornek.com/", None), Decision::Deny);
        assert_eq!(decide(PermissionKind::Microphone, "http://tauri.localhost/", Some(SERVER)), Decision::Deny);
    }

    #[test]
    fn camera_location_and_sensors_are_always_denied() {
        for kind in [PermissionKind::Camera, PermissionKind::Geolocation, PermissionKind::OtherSensors] {
            assert_eq!(decide(kind, "https://panel.ornek.com/", Some(SERVER)), Decision::Deny);
        }
    }

    #[test]
    fn other_permissions_keep_the_webview_default() {
        assert_eq!(decide(PermissionKind::Other, "https://panel.ornek.com/", Some(SERVER)), Decision::Default);
    }

    #[test]
    fn server_origin_state_round_trips() {
        let state = ServerOrigin::default();
        assert_eq!(state.get(), None);
        state.set(SERVER.to_string());
        assert_eq!(state.get().as_deref(), Some(SERVER));
    }
}

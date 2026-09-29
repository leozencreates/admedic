<#
  Admedic yerel veritabani kurulumu (Windows). Cift tikla: scripts\setup-postgres.cmd
  1) PostgreSQL yoksa winget ile kurar (sessiz), varsa hizmeti baslatir.
  2) admedic kullanicisini ve admedic_dev veritabanini olusturur (varsa dokunmaz).
  3) .env icindeki DATABASE_URL satirini bu veritabanina ayarlar (.env yoksa .env.example'dan olusturur).
  Yerel deneme kurulumudur: yonetici parolasi "postgres", uygulama parolasi "admedic". Sunucuda KULLANMAYIN.
  Bu dosya bilincli olarak yalnizca ASCII karakter icerir (Windows PowerShell 5.1 kodlama sorunu).
#>
$ErrorActionPreference = "Stop"

function Step([string]$t) { Write-Host ""; Write-Host ("==> " + $t) -ForegroundColor Cyan }
function Fail([string]$t) {
  Write-Host ""; Write-Host ("HATA: " + $t) -ForegroundColor Red
  Write-Host "Bu pencerenin ekran goruntusunu Claude'a gonderin. Kapatmak icin Enter." -ForegroundColor Yellow
  Read-Host | Out-Null; exit 1
}

# ---- Yonetici yetkisi (kurulum ve hizmet baslatma icin) ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Yonetici izni isteniyor (Evet'e tiklayin)..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$superPassword = "postgres"

# ---- 1) PostgreSQL hizmeti ----
Step "PostgreSQL kontrol ediliyor"
function Find-Service {
  Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "postgresql*" -or $_.DisplayName -like "*postgres*" } | Select-Object -First 1
}
function Find-Bin {
  $i = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\initdb.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($i) { return $i.DirectoryName } else { return $null }
}
function Install-Pg {
  winget install --id PostgreSQL.PostgreSQL.17 -e --silent --accept-package-agreements --accept-source-agreements `
    --override "--mode unattended --unattendedmodeui none --superpassword $superPassword --serverport 5432"
  Start-Sleep -Seconds 5
}

$service = Find-Service
if (-not $service) {
  if (-not (Find-Bin)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Fail "winget bulunamadi. Microsoft Store'dan 'Uygulama Yukleyicisi' (App Installer) kurulup tekrar denenmeli."
    }
    Step "PostgreSQL 17 kuruluyor (birkac dakika surer, pencereyi kapatmayin)"
    Install-Pg
    $service = Find-Service
    if (-not $service -and -not (Find-Bin)) {
      # winget paketi 'kurulu' saniyor ama dosyalar yok: yarim kalmis kurulum. Kaldirip yeniden kur.
      Step "Yarim kalmis kurulum bulundu; kaldirilip yeniden kuruluyor"
      winget uninstall --id PostgreSQL.PostgreSQL.17 -e --silent --accept-source-agreements
      Start-Sleep -Seconds 5
      Install-Pg
      $service = Find-Service
    }
  }
  if (-not $service) {
    # Programlar kurulu ama hizmet yok: kendi veri klasorumuzu olusturup hizmeti kaydediyoruz.
    $bin = Find-Bin
    if (-not $bin) { Fail "PostgreSQL kurulamadi (C:\Program Files\PostgreSQL altinda program yok)." }
    $busy = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
    if ($busy) { Fail "5432 portunu baska bir program kullaniyor; PostgreSQL hizmeti bu portta baslatilamaz." }
    $data = "C:\ProgramData\AdmedicPostgres\data"
    Step ("PostgreSQL hizmeti olusturuluyor (" + $data + ")")
    if ((Test-Path $data) -and (Get-ChildItem $data -Force | Select-Object -First 1)) {
      Write-Host "    Veri klasoru zaten dolu, yeniden kullaniliyor"
    } else {
      New-Item -ItemType Directory -Force -Path $data | Out-Null
      $pwFile = Join-Path $env:TEMP "admedic-pg-pw.txt"
      [IO.File]::WriteAllText($pwFile, $superPassword)
      & (Join-Path $bin "initdb.exe") -D $data -U postgres --pwfile=$pwFile -A scram-sha-256 -E UTF8 --no-locale 2>&1 | Out-Host
      $code = $LASTEXITCODE
      Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
      if ($code -ne 0) { Fail "initdb basarisiz oldu (yukaridaki cikti)." }
    }
    & icacls (Split-Path -Parent $data) /grant "*S-1-5-20:(OI)(CI)F" /T /Q | Out-Null
    & (Join-Path $bin "pg_ctl.exe") register -N "postgresql-admedic" -D $data -S auto 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "PostgreSQL hizmeti kaydedilemedi (pg_ctl register)." }
    $service = Get-Service -Name "postgresql-admedic" -ErrorAction SilentlyContinue
    if (-not $service) { Fail "Kurulum tamamlandi gorunuyor ama PostgreSQL hizmeti bulunamadi." }
    Write-Host "    Hizmet olusturuldu: postgresql-admedic"
  }
} else {
  Write-Host ("    Kurulu: " + $service.Name + " (" + $service.Status + ")")
}
if ($service.Status -ne "Running") {
  Step "PostgreSQL baslatiliyor"
  Start-Service $service.Name
  $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(60))
}
Set-Service $service.Name -StartupType Automatic

# ---- 2) Kullanici ve veritabani ----
$psql = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $psql) { Fail "psql.exe bulunamadi (C:\Program Files\PostgreSQL\...\bin)." }
$env:PGPASSWORD = $superPassword
function Sql([string]$q) {
  $out = & $psql.FullName -h localhost -p 5432 -U postgres -d postgres -tAc $q 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail ("Veritabanina baglanilamadi: " + ($out | Out-String) + " (PostgreSQL daha once farkli bir yonetici parolasiyla kurulmus olabilir.)")
  }
  return ($out | Out-String).Trim()
}
Step "Proje veritabani hazirlaniyor"
if ((Sql "SELECT 1 FROM pg_roles WHERE rolname = 'admedic'") -ne "1") {
  Sql "CREATE USER admedic WITH PASSWORD 'admedic' CREATEDB" | Out-Null
  Write-Host "    admedic kullanicisi olusturuldu"
} else { Write-Host "    admedic kullanicisi zaten var" }
if ((Sql "SELECT 1 FROM pg_database WHERE datname = 'admedic_dev'") -ne "1") {
  Sql "CREATE DATABASE admedic_dev OWNER admedic" | Out-Null
  Write-Host "    admedic_dev veritabani olusturuldu"
} else { Write-Host "    admedic_dev veritabani zaten var" }

# ---- 3) .env ----
Step ".env ayarlaniyor"
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $root ".env.example") $envFile; Write-Host "    .env, .env.example'dan olusturuldu" }
$url = 'DATABASE_URL="postgresql://admedic:admedic@localhost:5432/admedic_dev"'
$lines = @(Get-Content $envFile)
if ($lines -match '^\s*DATABASE_URL\s*=') { $lines = $lines -replace '^\s*DATABASE_URL\s*=.*', $url } else { $lines += $url }
[IO.File]::WriteAllLines($envFile, [string[]]$lines)
Write-Host "    DATABASE_URL ayarlandi"

Write-Host ""
Write-Host "TAMAM. Simdi scripts\dev-up.cmd dosyasina cift tiklayin." -ForegroundColor Green
Write-Host "Giris: http://localhost:3000 - admin@admedic.io / demo1234" -ForegroundColor Green
Write-Host "Kapatmak icin Enter." ; Read-Host | Out-Null

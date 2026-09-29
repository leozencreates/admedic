<#
.SYNOPSIS
  Admedic'i yerelde ayağa kaldırır: bağımlılıklar, Prisma client, migration, demo seed, paket derlemesi, web (ve isteğe bağlı API/worker).

.USAGE
  scripts\dev-up.cmd            # çift tıkla ya da PowerShell'den çalıştır
  scripts\dev-up.ps1 -NoSeed    # demo veriyi yeniden yükleme
  scripts\dev-up.ps1 -WithApi -WithWorker   # Fastify API ve meta-sync worker'ı ayrı pencerelerde de başlat
  scripts\dev-up.ps1 -SkipInstall           # pnpm install adımını atla

  Gereksinimler: Node 20+, pnpm 11 (corepack enable), PostgreSQL (kök .env içindeki DATABASE_URL'e erişilebilir olmalı;
  `docker compose up -d` ile de başlatılabilir).
#>
[CmdletBinding()]
param(
  [switch]$NoSeed,
  [switch]$WithApi,
  [switch]$WithWorker,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host ("==> " + $text) -ForegroundColor Cyan
}

function Fail([string]$text) {
  Write-Host ""
  Write-Host ("HATA: " + $text) -ForegroundColor Red
  Write-Host "Pencereyi kapatmadan önce Enter'a basın." -ForegroundColor Yellow
  Read-Host | Out-Null
  exit 1
}

function Invoke-Step([string]$label, [string]$command) {
  Write-Step $label
  Write-Host ("    $ " + $command) -ForegroundColor DarkGray
  cmd /c $command
  if ($LASTEXITCODE -ne 0) { Fail ("'" + $command + "' başarısız oldu (çıkış kodu " + $LASTEXITCODE + ")." ) }
}

Write-Host "Admedic yerel geliştirme ortamı - " -NoNewline
Write-Host $root -ForegroundColor Green

# ---- 0. Ön kontroller -------------------------------------------------------
Write-Step "Ön kontroller"
foreach ($tool in @("node", "pnpm")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail ("'" + $tool + "' bulunamadı. Node 20+ ve pnpm 11 kurulu olmalı (pnpm için: corepack enable).")
  }
}
Write-Host ("    node " + (node -v) + ", pnpm " + (pnpm -v))

if (-not (Test-Path (Join-Path $root ".env"))) {
  Fail ".env dosyası yok. .env.example dosyasını .env olarak kopyalayıp DATABASE_URL, AUTH_URL ve ENCRYPTION_KEY alanlarını doldurun."
}

# DATABASE_URL -> host:port erişilebilir mi?
$envLine = Get-Content (Join-Path $root ".env") | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if ($envLine) {
  $url = ($envLine -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
  if ($url -match '@([^/:]+)(?::(\d+))?/') {
    $dbHost = $Matches[1]
    $dbPort = 5432
    if ($Matches[2]) { $dbPort = [int]$Matches[2] }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $async = $client.BeginConnect($dbHost, $dbPort, $null, $null)
      $ok = $async.AsyncWaitHandle.WaitOne(3000, $false)
      if (-not $ok -or -not $client.Connected) { throw "timeout" }
      $client.EndConnect($async)
      Write-Host ("    PostgreSQL erişilebilir: " + $dbHost + ":" + $dbPort)
    } catch {
      Fail ("PostgreSQL'e ulaşılamıyor (" + $dbHost + ":" + $dbPort + "). Veritabanını başlatın (örn. 'docker compose up -d') ve tekrar deneyin.")
    } finally {
      $client.Close()
    }
  }
}

# ---- 1. Artık dosyalar -------------------------------------------------------
Write-Step "Artık dosyalar temizleniyor"
$stale = @(
  "web\app\api\billing\invoices\[id]\pay\route.ts",
  "packages\database\prisma\seed.ts.bakZ7"
)
foreach ($rel in $stale) {
  $p = Join-Path $root $rel
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Force
    Write-Host ("    silindi: " + $rel)
  }
}
# Boş kalan klasörleri de kaldır (Next.js boş route klasörünü sorun etmez, temizlik için).
$payDir = Join-Path $root "web\app\api\billing\invoices\[id]\pay"
$idDir  = Join-Path $root "web\app\api\billing\invoices\[id]"
foreach ($d in @($payDir, $idDir)) {
  if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $d -Force
  }
}

# ---- 2. Bağımlılıklar --------------------------------------------------------
if (-not $SkipInstall) {
  Invoke-Step "Bağımlılıklar (pnpm install)" "pnpm install"
}

# ---- 3. Veritabanı -----------------------------------------------------------
Invoke-Step "Prisma client üretiliyor" "pnpm db:generate"
Invoke-Step "@admedic/database derleniyor" "pnpm --filter @admedic/database build"
Invoke-Step "Migration'lar uygulanıyor (prisma migrate deploy)" "pnpm db:deploy"
if (-not $NoSeed) {
  Invoke-Step "Demo veri yükleniyor (yalnızca 'askmed-demo' organizasyonu sıfırlanır)" "pnpm db:seed"
}

# ---- 4. Paketler -------------------------------------------------------------
Invoke-Step "Paketler derleniyor (web ve worker dist üzerinden çözer)" "pnpm turbo run build --filter=./packages/* --env-mode=loose"

# ---- 5. Sunucular ------------------------------------------------------------
if ($WithApi) {
  Write-Step "Fastify API ayrı pencerede başlatılıyor (http://127.0.0.1:3001)"
  Start-Process powershell -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '" + $root + "'; pnpm api:dev")
}
if ($WithWorker) {
  Write-Step "meta-sync worker ayrı pencerede başlatılıyor"
  Start-Process powershell -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '" + $root + "'; pnpm worker:sync")
}

# Sunucu hazır olunca varsayılan tarayıcıyı aç (arka planda bekler).
$opener = {
  param($target)
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -ge 200) { Start-Process $target; return }
    } catch { }
  }
}
Start-Job -ScriptBlock $opener -ArgumentList "http://localhost:3000/login" | Out-Null

Write-Step "Web paneli başlatılıyor: http://localhost:3000  (durdurmak için Ctrl+C)"
Write-Host "    Giriş: yukarıdaki demo verisi çıktısındaki 'Demo girişi' bağlantısı (çalışma alanı kimliği dolu gelir)." -ForegroundColor DarkGray
Write-Host "    Değişiklikleri görmek için: docs/remaining-work.md §0 ve README 'Bu turda değişenler'." -ForegroundColor DarkGray
cmd /c "pnpm web:dev"

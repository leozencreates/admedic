<#
.SYNOPSIS
  Admedic'i yerelde ayaga kaldirir: bagimliliklar, Prisma client, migration, demo seed, paket derlemesi, web (ve istege bagli API/worker).

.USAGE
  scripts\dev-up.cmd            # cift tikla ya da PowerShell'den calistir
  scripts\dev-up.ps1 -NoSeed    # demo veriyi yeniden yukleme
  scripts\dev-up.ps1 -WithApi -WithWorker   # Fastify API ve meta-sync worker'i ayri pencerelerde de baslat
  scripts\dev-up.ps1 -SkipInstall           # pnpm install adimini atla

  Gereksinimler: Node 20+, pnpm 11 (corepack enable), PostgreSQL (kok .env icindeki DATABASE_URL'e erisilebilir olmali;
  `docker compose up -d` ile de baslatilabilir).
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
  Write-Host "Pencereyi kapatmadan once Enter'a basin." -ForegroundColor Yellow
  Read-Host | Out-Null
  exit 1
}

function Invoke-Step([string]$label, [string]$command) {
  Write-Step $label
  Write-Host ("    $ " + $command) -ForegroundColor DarkGray
  cmd /c $command
  if ($LASTEXITCODE -ne 0) { Fail ("'" + $command + "' basarisiz oldu (cikis kodu " + $LASTEXITCODE + ")." ) }
}

Write-Host "Admedic yerel gelistirme ortami - " -NoNewline
Write-Host $root -ForegroundColor Green

# ---- 0. On kontroller -------------------------------------------------------
Write-Step "On kontroller"
foreach ($tool in @("node", "pnpm")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail ("'" + $tool + "' bulunamadi. Node 20+ ve pnpm 11 kurulu olmali (pnpm icin: corepack enable).")
  }
}
Write-Host ("    node " + (node -v) + ", pnpm " + (pnpm -v))

if (-not (Test-Path (Join-Path $root ".env"))) {
  $example = Join-Path $root ".env.example"
  if (-not (Test-Path $example)) {
    Fail (".env ve .env.example bulunamadi (" + $root + "). Betik proje klasorunun icindeki scripts klasorunden calistirilmali.")
  }
  # Yerel gelistirme icin ornek dosya yeterli (DATABASE_URL: admedic/admedic@localhost:5432/admedic_dev, deneme modu).
  Copy-Item $example (Join-Path $root ".env")
  Write-Host "    .env dosyasi .env.example'dan olusturuldu (yerel deneme ayarlari)."
}

# DATABASE_URL -> host:port erisilebilir mi?
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
      Write-Host ("    PostgreSQL erisilebilir: " + $dbHost + ":" + $dbPort)
    } catch {
      Fail ("PostgreSQL'e ulasilamiyor (" + $dbHost + ":" + $dbPort + "). Once scripts\setup-postgres.cmd dosyasina cift tiklayin (PostgreSQL'i kurar ve baslatir), sonra bu betigi tekrar calistirin.")
    } finally {
      $client.Close()
    }
  }
}

# ---- 1. Artik dosyalar -------------------------------------------------------
Write-Step "Artik dosyalar temizleniyor"
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
# Bos kalan klasorleri de kaldir (Next.js bos route klasorunu sorun etmez, temizlik icin).
$payDir = Join-Path $root "web\app\api\billing\invoices\[id]\pay"
$idDir  = Join-Path $root "web\app\api\billing\invoices\[id]"
foreach ($d in @($payDir, $idDir)) {
  if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $d -Force
  }
}

# ---- 2. Bagimliliklar --------------------------------------------------------
if (-not $SkipInstall) {
  Invoke-Step "Bagimliliklar (pnpm install)" "pnpm install"
}

# ---- 3. Veritabani -----------------------------------------------------------
Invoke-Step "Prisma client uretiliyor" "pnpm db:generate"
Invoke-Step "@admedic/database ve bagimliliklari derleniyor" "pnpm --filter @admedic/database... build"
Invoke-Step "Migration'lar uygulaniyor (prisma migrate deploy)" "pnpm db:deploy"
if (-not $NoSeed) {
  Invoke-Step "Demo veri yukleniyor (yalnizca 'askmed-demo' organizasyonu sifirlanir)" "pnpm db:seed"
}

# ---- 4. Paketler -------------------------------------------------------------
Invoke-Step "Paketler derleniyor (web ve worker dist uzerinden cozer)" "pnpm turbo run build --filter=./packages/* --env-mode=loose"

# ---- 5. Sunucular ------------------------------------------------------------
if ($WithApi) {
  Write-Step "Fastify API ayri pencerede baslatiliyor (http://127.0.0.1:3001)"
  Start-Process powershell -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '" + $root + "'; pnpm api:dev")
}
if ($WithWorker) {
  Write-Step "meta-sync worker ayri pencerede baslatiliyor"
  Start-Process powershell -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '" + $root + "'; pnpm worker:sync")
}

# Sunucu hazir olunca varsayilan tarayiciyi ac (arka planda bekler).
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

Write-Step "Web paneli baslatiliyor: http://localhost:3000  (durdurmak icin Ctrl+C)"
Write-Host "    Giris: admin@admedic.io / demo1234 (demo hesap sahibi)." -ForegroundColor DarkGray
Write-Host "    Degisiklikleri gormek icin: docs/remaining-work.md bolum 0 ve README 'Bu turda degisenler'." -ForegroundColor DarkGray
cmd /c "pnpm web:dev"

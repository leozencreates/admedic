// Urun adini surec ortamindaki veya kok .env dosyasindaki APP_NAME'den Tauri'ye aktarir.
//
// Neden bu adim var: onceki is `tauri build --config "{\"productName\":\"$APP_NAME\"}"`
// seklindeydi. deger kabuk (cmd.exe / pnpm shell emulator) uzerinden gecerken Windows
// konsol kod sayfasiyla cift/defa kodlaniyor, `ü` gibi karakterler bozuluyordu
// ("Stüdyosu" -> "StÃƒÂ¼dyosu"). Burada deger hicbir kabuktan gecmez: dogrudan
// surec ortamindan veya UTF-8 kok .env dosyasindan okunur ve UTF-8 bir JSON dosyasina yazilir, Tauri'ye dosya
// yolu argv icinde gecer. Boylece karakterler bozulmaz.
//
// Kod tabani kurali: urun adi hicbir yere sabit yazilmaz (AGENTS.md), yalnizca
// ortam degiskeninden okunur. Bu dosya da hicbir ad icermez.

import childProcess from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const defaultDesktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readAppName(desktopDir, env) {
  if (env.APP_NAME !== undefined) return env.APP_NAME.trim()
  try {
    // Yalnizca urun adi alinir; .env'deki diger degerler surec ortamina aktarilmaz.
    const source = readFileSync(path.join(desktopDir, '..', '.env'), 'utf8')
    return (parse(source).APP_NAME ?? '').trim()
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

// Tauri CLI giris noktasi; kabuk uzerinden `.bin/tauri.cmd` cagirmak yerine
// dogrudan node ile calistiriyoruz (ayri kod sayfasi katmani birakilmasin).
function resolveTauriEntry(desktopDir) {
  const require = createRequire(path.join(desktopDir, 'package.json'))
  try {
    const manifestPath = require.resolve('@tauri-apps/cli/package.json')
    const manifest = require(manifestPath)
    const bin = typeof manifest.bin === 'string' ? { tauri: manifest.bin } : manifest.bin
    if (bin?.tauri) return path.resolve(path.dirname(manifestPath), bin.tauri)
  } catch {
    // asagidaki dosya yoluna duser
  }
  return path.join(desktopDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
}

// tauriArgs: Tauri CLI alt komutu. Varsayilan `build`; `dev`, `ios init`, `ios dev`, `ios build` de ayni
// yoldan gecer ki urun adi her komutta APP_NAME'den gelsin (ADR-0025).
export function runBuild({
  desktopDir = defaultDesktopDir,
  env = process.env,
  tauriArgs = ['build'],
  platform = process.platform,
} = {}) {
  let configDir
  try {
    if (tauriArgs[0] === 'ios' && platform !== 'darwin') {
      console.error('Hata: iOS komutlari yalnizca macOS + Xcode ile calisir (bkz. desktop/README.md "iOS").')
      return 1
    }
    const appName = readAppName(desktopDir, env)
    if (appName === '') {
      console.error('Hata: APP_NAME tanimli degil; surec ortaminda veya kok .env dosyasinda ayarlayin.')
      console.error('PowerShell:  $env:APP_NAME = "<urun adi>"; pnpm --filter @admedic/desktop build:ci')
      console.error('bash/zsh  :  APP_NAME="<urun adi>" pnpm --filter @admedic/desktop build:ci')
      return 1
    }

    configDir = mkdtempSync(path.join(tmpdir(), 'admedic-tauri-'))
    const configPath = path.join(configDir, 'product-name.json')
    writeFileSync(configPath, `${JSON.stringify({ productName: appName }, null, 2)}\n`, 'utf8')

    const result = childProcess.spawnSync(
      process.execPath,
      [resolveTauriEntry(desktopDir), ...tauriArgs, '--config', configPath],
      { cwd: desktopDir, stdio: 'inherit', env, shell: false },
    )

    if (result.error) {
      console.error(`Hata: Tauri calistirilamadi — ${result.error.message}`)
      return 1
    }
    return result.status ?? 1
  } catch (error) {
    console.error(`Hata: Masaustu derlemesi baslatilamadi — ${error.message}`)
    return 1
  } finally {
    if (configDir) rmSync(configDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tauriArgs = process.argv.slice(2)
  process.exitCode = runBuild(tauriArgs.length > 0 ? { tauriArgs } : {})
}

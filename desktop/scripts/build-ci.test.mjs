import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runBuild } from './build-ci.mjs'

const turkishLetters = 'ÇĞİÖŞÜ çğıöşü'
const originalSpawnSync = childProcess.spawnSync
const buildScript = fileURLToPath(new URL('./build-ci.mjs', import.meta.url))

function fixture(t, envSource) {
  const root = mkdtempSync(path.join(tmpdir(), 'build-ci-test-'))
  const desktopDir = path.join(root, 'masaüstü test')
  const cliDir = path.join(desktopDir, 'node_modules', '@tauri-apps', 'cli')
  const reportPath = path.join(root, 'report.json')
  const cliEntry = path.join(cliDir, 'tauri fake.mjs')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(path.join(desktopDir, 'package.json'), '{}', 'utf8')
  writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({ bin: { tauri: 'tauri fake.mjs' } }), 'utf8')
  writeFileSync(cliEntry, `
    import { readFileSync, writeFileSync } from 'node:fs'
    const args = process.argv.slice(2)
    const configPath = args[args.indexOf('--config') + 1]
    const bytes = readFileSync(configPath)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    writeFileSync(process.env.BUILD_CI_TEST_REPORT, JSON.stringify({
      args, configPath, cwd: process.cwd(), config: JSON.parse(text),
      utf8Hex: bytes.toString('hex'),
      unrelatedValue: process.env.BUILD_CI_ENV_ONLY_TEST_VALUE ?? null,
    }), 'utf8')
    process.exitCode = Number(process.env.BUILD_CI_TEST_EXIT ?? '0')
  `, 'utf8')
  if (envSource !== undefined) writeFileSync(path.join(root, '.env'), envSource, 'utf8')
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('build-ci-test-'))
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, BUILD_CI_TEST_REPORT: reportPath }
  delete env.APP_NAME
  return {
    root, desktopDir, cliEntry, reportPath, env,
    report: () => JSON.parse(readFileSync(reportPath, 'utf8')),
  }
}

function observeSpawn(t) {
  return t.mock.method(childProcess, 'spawnSync', (...args) => originalSpawnSync(...args))
}

function captureErrors(t) {
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')))
  return errors
}

function assertCleaned(configPath) {
  assert.equal(existsSync(configPath), false, 'temporary config file must be removed')
  assert.equal(existsSync(path.dirname(configPath)), false, 'temporary config directory must be removed')
}

test('root .env preserves all Turkish letters through a real UTF-8 Tauri config', (t) => {
  const f = fixture(t, `APP_NAME="${turkishLetters}"\nBUILD_CI_ENV_ONLY_TEST_VALUE="not inherited"\n`)
  delete f.env.BUILD_CI_ENV_ONLY_TEST_VALUE
  const spawn = observeSpawn(t)
  const originalAppName = process.env.APP_NAME

  assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env }), 0)
  const report = f.report()
  assert.deepEqual(report.config, { productName: turkishLetters })
  assert.ok(report.utf8Hex.includes(Buffer.from(turkishLetters, 'utf8').toString('hex')))
  assert.equal(report.cwd, f.desktopDir)
  assert.deepEqual(report.args, ['build', '--config', report.configPath])
  assert.equal(report.unrelatedValue, null)
  assert.equal(process.env.APP_NAME, originalAppName, '.env must not mutate the process environment')
  assert.equal(spawn.mock.callCount(), 1)
  const [command, args, options] = spawn.mock.calls[0].arguments
  assert.equal(command, process.execPath)
  assert.deepEqual(args, [f.cliEntry, 'build', '--config', report.configPath])
  assert.equal(options.cwd, f.desktopDir)
  assert.equal(options.shell, false)
  assertCleaned(report.configPath)
})

test('process APP_NAME takes priority and preserves quotes and shell metacharacters', (t) => {
  const f = fixture(t, 'APP_NAME="file value"\n')
  const name = `${turkishLetters} "& $APP_NAME | ;"`
  f.env.APP_NAME = `  ${name}  `
  assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env }), 0)
  const report = f.report()
  assert.equal(report.config.productName, name)
  assertCleaned(report.configPath)
})

for (const [label, source] of [
  ['missing .env', undefined],
  ['missing APP_NAME', 'BUILD_CI_ENV_ONLY_TEST_VALUE="private test value"\n'],
  ['empty APP_NAME', 'APP_NAME=""\n'],
  ['whitespace APP_NAME', 'APP_NAME="   "\n'],
]) {
  test(`${label} fails clearly before launching Tauri`, (t) => {
    const f = fixture(t, source)
    const spawn = observeSpawn(t)
    const errors = captureErrors(t)
    assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env }), 1)
    assert.equal(spawn.mock.callCount(), 0)
    assert.equal(existsSync(f.reportPath), false)
    assert.match(errors[0], /APP_NAME.*\.env/)
    assert.equal(errors.join('\n').includes('private test value'), false)
  })
}

test('an explicitly blank process APP_NAME is not replaced by .env', (t) => {
  const f = fixture(t, `APP_NAME="${turkishLetters}"\n`)
  f.env.APP_NAME = '   '
  const errors = captureErrors(t)
  const spawn = observeSpawn(t)
  assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env }), 1)
  assert.match(errors[0], /APP_NAME/)
  assert.equal(spawn.mock.callCount(), 0)
})

test('a nonzero Tauri exit is preserved after the temporary config is removed', (t) => {
  const f = fixture(t, `APP_NAME="${turkishLetters}"\n`)
  f.env.BUILD_CI_TEST_EXIT = '7'
  assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env }), 7)
  assertCleaned(f.report().configPath)
})

test('a spawn error removes the config directory and returns exit code 1', (t) => {
  const f = fixture(t)
  f.env.APP_NAME = turkishLetters
  const errors = captureErrors(t)
  const spawn = observeSpawn(t)
  const missingDesktopDir = path.join(f.root, 'missing desktop')
  assert.equal(runBuild({ desktopDir: missingDesktopDir, env: f.env }), 1)
  assert.match(errors[0], /Tauri calistirilamadi/)
  assert.ok(spawn.mock.calls[0].result.error)
  assertCleaned(spawn.mock.calls[0].arguments[1][3])
})

test('other Tauri subcommands receive the same product-name config', (t) => {
  const f = fixture(t, `APP_NAME="${turkishLetters}"\n`)
  assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env, tauriArgs: ['ios', 'build'], platform: 'darwin' }), 0)
  const report = f.report()
  assert.deepEqual(report.args, ['ios', 'build', '--config', report.configPath])
  assert.deepEqual(report.config, { productName: turkishLetters })
  assertCleaned(report.configPath)
})

test('iOS subcommands fail clearly outside macOS without launching Tauri', (t) => {
  const f = fixture(t, `APP_NAME="${turkishLetters}"\n`)
  const errors = captureErrors(t)
  const spawn = observeSpawn(t)
  assert.equal(runBuild({ desktopDir: f.desktopDir, env: f.env, tauriArgs: ['ios', 'init'], platform: 'win32' }), 1)
  assert.equal(spawn.mock.callCount(), 0)
  assert.match(errors[0], /macOS/)
})

test('direct CLI execution exits with code 1 for an explicitly empty APP_NAME', (t) => {
  const f = fixture(t)
  const result = originalSpawnSync(process.execPath, [buildScript], {
    cwd: f.root,
    env: { ...f.env, APP_NAME: '' },
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /APP_NAME/)
})

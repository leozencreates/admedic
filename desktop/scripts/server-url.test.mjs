import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeServerUrl, readHealth } from '../ui/server-url.js'

test('an https address is reduced to its origin', () => {
  assert.deepEqual(normalizeServerUrl('  https://panel.ornek.com/login?next=/leads#x  '), {
    ok: true,
    origin: 'https://panel.ornek.com',
  })
  assert.deepEqual(normalizeServerUrl('https://panel.ornek.com:8443/'), { ok: true, origin: 'https://panel.ornek.com:8443' })
})

test('a bare host gets https, a bare local host gets http', () => {
  assert.deepEqual(normalizeServerUrl('panel.ornek.com'), { ok: true, origin: 'https://panel.ornek.com' })
  assert.deepEqual(normalizeServerUrl('localhost:3000'), { ok: true, origin: 'http://localhost:3000' })
  assert.deepEqual(normalizeServerUrl('127.0.0.1:3000'), { ok: true, origin: 'http://127.0.0.1:3000' })
})

test('http is accepted only for this computer', () => {
  assert.deepEqual(normalizeServerUrl('http://localhost:3000'), { ok: true, origin: 'http://localhost:3000' })
  assert.deepEqual(normalizeServerUrl('http://[::1]:3000'), { ok: true, origin: 'http://[::1]:3000' })
  assert.deepEqual(normalizeServerUrl('http://panel.ornek.com'), { ok: false, reason: 'insecure' })
  assert.deepEqual(normalizeServerUrl('http://192.168.1.20:3000'), { ok: false, reason: 'insecure' })
  // Yerel ada benzeyen uzak alan adı yerel sayılmaz.
  assert.deepEqual(normalizeServerUrl('http://localhost.ornek.com'), { ok: false, reason: 'insecure' })
})

test('empty, malformed, credentialed and non-web addresses are rejected', () => {
  assert.deepEqual(normalizeServerUrl(''), { ok: false, reason: 'empty' })
  assert.deepEqual(normalizeServerUrl('   '), { ok: false, reason: 'empty' })
  assert.deepEqual(normalizeServerUrl(null), { ok: false, reason: 'empty' })
  assert.deepEqual(normalizeServerUrl('https://'), { ok: false, reason: 'invalid' })
  assert.deepEqual(normalizeServerUrl('https://kullanici:parola@panel.ornek.com'), { ok: false, reason: 'invalid' })
  assert.deepEqual(normalizeServerUrl('javascript://panel.ornek.com/%0aalert(1)'), { ok: false, reason: 'invalid' })
  assert.deepEqual(normalizeServerUrl('file:///C:/Windows'), { ok: false, reason: 'invalid' })
  assert.deepEqual(normalizeServerUrl('tauri://localhost'), { ok: false, reason: 'invalid' })
})

test('health responses map to up, down or unknown', () => {
  assert.equal(readHealth({ status: 'ok' }), 'up')
  assert.equal(readHealth({ status: 'degraded' }), 'up')
  assert.equal(readHealth({ status: 'down' }), 'down')
  assert.equal(readHealth({ status: 'something' }), 'unknown')
  assert.equal(readHealth({}), 'unknown')
  assert.equal(readHealth(null), 'unknown')
  assert.equal(readHealth('<html>'), 'unknown')
})

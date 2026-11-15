#!/usr/bin/env node
// 跨平台 Web 控制台 / HTTP 契约回归：纯 Node stdlib；不联网、不读取凭据、不启动浏览器。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const targetRoot = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : resolve(root, 'target')
const candidates = [
  process.argv[2],
  join(targetRoot, 'release', 'lyblive'),
  join(targetRoot, 'release', 'lyblive.exe'),
].filter(Boolean)
const binary = candidates.find((p) => existsSync(p))
if (!binary) {
  console.error('web-smoke: build the release binary first: cargo build --release')
  process.exit(1)
}

// 源码树或产物归档内定位磁盘上的真实构建资源；找不到时只做 HTTP 结构回归。
const assetRoots = [root, scriptDir]
const sourceDist = assetRoots.map((p) => join(p, 'web/dist')).find((p) => existsSync(join(p, 'index.html')))
const flatAssets = sourceDist ? null : assetRoots.map((p) => join(p, 'assets')).find((p) => existsSync(join(p, 'index.html')))
const distRoot = sourceDist || flatAssets
const assetDir = distRoot ? (basename(distRoot) === 'assets' ? distRoot : join(distRoot, 'assets')) : null
function expectedAsset(url) {
  if (!distRoot || !assetDir) return null
  if (url === '/favicon.svg') {
    const p = join(distRoot, 'favicon.svg')
    return existsSync(p) ? readFileSync(p) : null
  }
  const m = url.match(/^\/assets\/([^/]+)$/)
  if (!m) return null
  const p = join(assetDir, m[1])
  return existsSync(p) ? readFileSync(p) : null
}

// 本机可用 LYBLIVE_SMOKE_WRAPPER=wine 校验 Windows 产物；CI 原生运行时为空。
const wrapper = (process.env.LYBLIVE_SMOKE_WRAPPER || '').trim().split(/\s+/).filter(Boolean)
const cmd = [...wrapper, binary, '--web', '--no-browser']
const configHome = mkdtempSync(join(tmpdir(), 'lyblive-web-smoke-'))

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => ok(p))
    })
  })
}

function httpCall(base, path, opts = {}) {
  return new Promise((ok, fail) => {
    const u = new URL(path, base)
    const r = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          ok({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )
    r.on('error', fail)
    if (opts.body) r.write(opts.body)
    r.end()
  })
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function json(resp) {
  return JSON.parse(resp.body.toString('utf8'))
}
function text(resp) {
  return resp.body.toString('utf8')
}
function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(label + ' timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

async function waitHealth(base) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await httpCall(base, '/api/health')
      if (r.status === 200) return json(r)
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Web /api/health did not become ready')
}

const port = await freePort()
const env = {
  ...process.env,
  LYBLIVE_PORT: String(port),
  LYBLIVE_CONFIG_HOME: configHome,
  NO_COLOR: '1',
}
const child = spawn(cmd[0], cmd.slice(1), {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
})
let stdout = ''
let stderr = ''
let spawnError = null
// 跨平台总超时保护：任何断言失败/启动失败后也中止 SSE 长连接，避免 CI 挂住。
const ac = new AbortController()
child.on('error', (e) => { spawnError = e })
child.stdout.on('data', (d) => {
  stdout += d
})
child.stderr.on('data', (d) => {
  stderr += d
})
let base
try {
  const url = await withTimeout(
    new Promise((ok, fail) => {
      const scan = () => {
        if (spawnError) { fail(spawnError); return true }
        const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
        if (m) {
          ok('http://127.0.0.1:' + m[1])
          return true
        }
        return false
      }
      if (scan()) return
      child.stdout.on('data', () => scan())
      child.on('error', fail)
      child.on('close', (code) =>
        fail(new Error('Web process exited ' + code + ': ' + stdout + ' ' + stderr)),
      )
    }),
    30000,
    'Web server start',
  )
  base = url
  const portUsed = new URL(base).port
  const health = await waitHealth(base)
  assert(health.ok === true && health.name === 'lyblive' && health.backend === 'lilyco', 'unexpected /api/health payload')

  const index = await httpCall(base, '/')
  assert(index.status === 200, 'GET / status ' + index.status)
  const html = text(index)
  assert(html.includes('id="root"'), 'index.html missing #root')
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)
  assert(asset, 'index.html missing built JS asset')
  const cssAsset = html.match(/href="(\/assets\/[^"]+\.css)"/)
  assert(cssAsset && html.includes('rel="stylesheet"'), 'index.html missing built CSS asset')

  const spa = await httpCall(base, '/room')
  assert(spa.status === 200 && text(spa).includes('id="root"'), 'SPA fallback failed')

  const favicon = await httpCall(base, '/favicon.svg')
  assert(favicon.status === 200, 'GET /favicon.svg status ' + favicon.status)
  assert((favicon.headers['content-type'] || '').includes('image/svg+xml'), 'favicon content-type')
  const expectedFavicon = expectedAsset('/favicon.svg')
  if (expectedFavicon) assert(favicon.body.equals(expectedFavicon), 'favicon bytes differ from built asset (stale embedded binary?)')

  const js = await httpCall(base, asset[1])
  assert(js.status === 200, 'GET ' + asset[1] + ' status ' + js.status)
  assert((js.headers['content-type'] || '').includes('javascript'), 'JS content-type')
  assert((js.headers['cache-control'] || '').includes('immutable'), 'JS immutable cache')
  const expectedJs = expectedAsset(asset[1])
  if (expectedJs) assert(js.body.equals(expectedJs), 'JS bytes differ from built asset (stale embedded binary?)')

  const css = await httpCall(base, cssAsset[1])
  assert(css.status === 200, 'GET ' + cssAsset[1] + ' status ' + css.status)
  assert((css.headers['content-type'] || '').includes('text/css'), 'CSS content-type')
  assert((css.headers['cache-control'] || '').includes('immutable'), 'CSS immutable cache')
  const cssText = text(css)
  assert(cssText.includes('tailwindcss') && cssText.includes('--tw-'), 'CSS is not the real Tailwind bundle')
  assert(!/url\(\s*['"]?(https?:|data:)/i.test(cssText), 'CSS has external/data font refs')
  const expectedCss = expectedAsset(cssAsset[1])
  if (expectedCss) assert(css.body.equals(expectedCss), 'CSS bytes differ from built asset (stale embedded binary?)')

  const fontRefs = [...cssText.matchAll(/url\(\s*['"]?\/assets\/([^'")]+\.woff2)['"]?\s*\)/g)].map((m) => '/assets/' + m[1])
  assert(fontRefs.length > 0 && fontRefs.length <= 10, 'CSS bundled woff2 font count drift')
  for (const ref of fontRefs) {
    const font = await httpCall(base, ref)
    assert(font.status === 200, 'GET ' + ref + ' status ' + font.status)
    assert((font.headers['content-type'] || '').includes('font/woff2'), 'font content-type ' + ref)
    assert((font.headers['cache-control'] || '').includes('immutable'), 'font immutable cache ' + ref)
    assert(font.body.subarray(0, 4).toString('latin1') === 'wOF2', 'font magic ' + ref)
    const expectedFont = expectedAsset(ref)
    if (expectedFont) assert(font.body.equals(expectedFont), 'font bytes differ from built asset: ' + ref)
  }
  const missingFont = '/assets/__missing__-' + Date.now() + '.woff2'
  const missing = await httpCall(base, missingFont)
  assert(missing.status === 404, 'missing font must be 404, got ' + missing.status)
  assert(json(missing).error === '页面不存在', 'unexpected missing font body')

  const session = json(await httpCall(base, '/api/session'))
  assert(session.loggedIn === false, 'unexpected loggedIn')
  assert(!('cookie' in session) && !('csrf' in session), 'session leaked credential fields')

  const key = json(await httpCall(base, '/api/stream-key'))
  assert(key.ok === true && key.masked === true && key.code === '', 'stream-key must be masked by default')

  const commands = json(await httpCall(base, '/api/commands'))
  assert(Array.isArray(commands.commands) && commands.commands.length >= 20, '/api/commands too small')
  assert(commands.commands.some((c) => c.name === 'live-start' && c.safety), 'missing live-start safety tier')

  const badHost = await httpCall(base, '/api/health', { headers: { Host: 'evil.example' } })
  assert(badHost.status === 403, 'non-loopback Host must be 403, got ' + badHost.status)
  assert(json(badHost).error === '仅允许本机访问', 'unexpected Host guard body')

  async function badPost(host, origin, label, expectedError) {
    const response = await httpCall(base, '/api/danmu/stop', {
      method: 'POST',
      headers: {
        Host: host,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    assert(response.status === 403, label + ' must be 403, got ' + response.status)
    assert(json(response).error === expectedError, label + ': unexpected 403 body')
  }
  const loopbackHost = '127.0.0.1:' + portUsed
  await badPost(loopbackHost, 'https://evil.example', 'cross-site POST', '跨站 POST 已拒绝')
  const suffixCases = [
    ['127.evil.example:' + portUsed, base, '仅允许本机访问'],
    ['127.0.0.1.evil.example:' + portUsed, base, '仅允许本机访问'],
    [loopbackHost, 'http://127.evil.example', '跨站 POST 已拒绝'],
    [loopbackHost, 'http://127.0.0.1.evil.example:' + portUsed, '跨站 POST 已拒绝'],
    [loopbackHost, 'http://user@127.0.0.1:' + portUsed, '跨站 POST 已拒绝'],
    [loopbackHost, 'http://127.0.0.1:' + portUsed + '/path', '跨站 POST 已拒绝'],
    [loopbackHost, 'http://127.0.0.1:80x', '跨站 POST 已拒绝'],
    ['127.0.0.1:80x', base, '仅允许本机访问'],
    ['127.256.0.1:' + portUsed, base, '仅允许本机访问'],
    ['[::1]:80x', base, '仅允许本机访问'],
  ]
  for (const [host, origin, expectedError] of suffixCases) {
    await badPost(host, origin, 'Host=' + host + ' Origin=' + origin, expectedError)
  }
  const numericLoopback = await httpCall(base, '/api/danmu/stop', {
    method: 'POST',
    headers: {
      Host: loopbackHost,
      Origin: 'http://127.9.9.9:9000',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert(numericLoopback.status === 200, 'numeric 127/8 Origin must be accepted, got ' + numericLoopback.status)
  const ipv6Origin = await httpCall(base, '/api/danmu/stop', {
    method: 'POST',
    headers: {
      Host: loopbackHost,
      Origin: 'http://[::1]:8765',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert(ipv6Origin.status === 200, 'IPv6 loopback Origin must be accepted, got ' + ipv6Origin.status)

  // SSE：先建立订阅，再用回环 POST /api/danmu/stop 触发系统事件。
  const sse = await withTimeout(
    fetch(base + '/api/danmu/events', {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    }),
    8000,
    'SSE connect',
  )
  assert(sse.status === 200, 'SSE status ' + sse.status)
  assert((sse.headers.get('content-type') || '').includes('text/event-stream'), 'SSE content-type')
  const reader = sse.body.getReader()
  await new Promise((r) => setTimeout(r, 150))
  const stopped = await httpCall(base, '/api/danmu/stop', {
    method: 'POST',
    headers: {
      Host: loopbackHost,
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  assert(stopped.status === 200, 'loopback POST /api/danmu/stop status ' + stopped.status)
  let buf = ''
  let event = null
  const deadline = Date.now() + 8000
  while (!event && Date.now() < deadline) {
    const chunk = await withTimeout(reader.read(), Math.max(1, deadline - Date.now()), 'SSE read')
    if (chunk.done) break
    buf += new TextDecoder().decode(chunk.value)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.startsWith('data:')) {
        event = JSON.parse(line.slice(5).trim())
        break
      }
    }
  }
  assert(event && event.running === false && event.kind === 'system', 'SSE danmu-stop event missing')
  ac.abort()

  const parity = distRoot ? '/disk-parity' : ''
  console.log('web-smoke: ' + portUsed + '; health/index/spa/js/css/' + fontRefs.length + '-fonts/favicon/session/stream-key/commands/Host-403/Origin-403/Host-suffix-403/Origin-suffix-403/Bad-port-403/SSE' + parity + ' OK')
} finally {
  try { ac.abort() } catch {}
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {}
  rmSync(configHome, { recursive: true, force: true })
}

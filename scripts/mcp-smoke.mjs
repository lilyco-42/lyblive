#!/usr/bin/env node
// 跨平台 MCP / Agent 面契约回归：纯 Node stdio JSON-RPC；不联网、不读取凭据。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  console.error('mcp-smoke: build the release binary first: cargo build --release')
  process.exit(1)
}

// 本机可用 LYBLIVE_SMOKE_WRAPPER=wine 校验 Windows 产物；CI 原生运行时为空。
const wrapper = (process.env.LYBLIVE_SMOKE_WRAPPER || '').trim().split(/\s+/).filter(Boolean)
const cmd = [...wrapper, binary, '--mcp']
const configHome = mkdtempSync(join(tmpdir(), 'lyblive-mcp-smoke-'))

// 以同一二进制的 --schema 作为 Agent 工具面的单一事实来源；Wine 包装器同样适用。
let schema
try {
  const schemaCmd = [...wrapper, binary, '--schema']
  const raw = execFileSync(schemaCmd[0], schemaCmd.slice(1), {
    encoding: 'utf8',
    env: { ...process.env, LYBLIVE_CONFIG_HOME: configHome, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  })
  schema = JSON.parse(raw)
} catch (e) {
  rmSync(configHome, { recursive: true, force: true })
  throw new Error('failed to read --schema: ' + (e && e.message ? e.message : String(e)))
}

// Agent 白名单的三方契约：Rust 常量 --schema/工具面 -- 文档必须逐字一致。
function parseAgentAllowed(text) {
  const match = text.match(/pub const AGENT_ALLOWED: &\[&str\] = &\[([\s\S]*?)\];/)
  assert(match, 'src/policy.rs: AGENT_ALLOWED declaration not found')
  const names = [...match[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1])
  assert(names.length > 0 && new Set(names).size === names.length, 'AGENT_ALLOWED empty or duplicated')
  return names.sort()
}
function parseDocList(text, label) {
  const match = text.match(new RegExp(label + '[^\\n]*?白名单[^\\n]*?只允许([^；\\n]+)'))
    || text.match(new RegExp(label + '[^\\n]*?以及 T1 的([^。\\n]+)'))
  assert(match, label + ': Agent whitelist sentence not found')
  const names = [...match[1].matchAll(/[a-z][a-z0-9-]+/g)].map((m) => m[0])
  assert(names.length > 0 && new Set(names).size === names.length, label + ': whitelist empty or duplicated')
  return names.sort()
}
// 源码树与产物归档均可独立运行：归档把 policy.rs 与 MCP.md 平铺在根目录。
function readFirst(paths, label) {
  for (const p of paths) if (existsSync(p)) return readFileSync(p, 'utf8')
  assert(false, label + ': not found in source tree or artifact archive')
  return ''
}
// 源码树：root=项目根、scriptDir=project/scripts；产物归档：脚本与契约源平铺在 scriptDir。
const policyText = readFirst([join(root, 'src/policy.rs'), join(scriptDir, 'policy.rs')], 'src/policy.rs')
const readmeText = readFirst([join(root, 'README.md'), join(scriptDir, 'README.md')], 'README.md')
const mcpDocText = readFirst([join(root, 'docs/MCP.md'), join(scriptDir, 'MCP.md')], 'docs/MCP.md')
const agentAllowed = parseAgentAllowed(policyText)

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lyblive-mcp-smoke', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'live-start', arguments: {} } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'does-not-exist', arguments: {} } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'danmu-stop', arguments: {} } },
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'login-logout', arguments: {} } },
]
const expectedIds = [1, 2, 3, 4, 5, 6, 7]

const child = spawn(cmd[0], cmd.slice(1), {
  env: { ...process.env, LYBLIVE_CONFIG_HOME: configHome, NO_COLOR: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const byId = new Map()
let buffer = ''
let settled = false
let resolveDone
const done = new Promise((r) => { resolveDone = r })
function finish() {
  if (settled) return
  settled = true
  resolveDone()
}
function handleLine(line) {
  const t = line.trim()
  if (!t) return
  let msg
  try { msg = JSON.parse(t) } catch { return }
  if (msg && typeof msg.id !== 'undefined') byId.set(msg.id, msg)
  if (expectedIds.every((id) => byId.has(id))) finish()
}
child.stdout.on('data', (d) => {
  buffer += d
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    handleLine(line)
  }
})
child.stderr.on('data', () => {})
child.stdin.on('error', () => {})
child.on('error', () => finish())
child.on('close', () => { handleLine(buffer); finish() })
child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n')
child.stdin.end()
const timer = setTimeout(() => finish(), 20000)
await done
clearTimeout(timer)
try { child.kill() } catch {}

function assert(cond, msg) { if (!cond) throw new Error(msg) }
const get = (id) => byId.get(id)
try {
  for (const id of expectedIds) assert(get(id), 'missing JSON-RPC response id=' + id)
  const init = get(1)
  assert(!init.error, 'initialize returned an error')
  assert(init.result && init.result.protocolVersion === '2024-11-05', 'unexpected MCP protocolVersion')
  assert(init.result && init.result.capabilities && init.result.capabilities.tools, 'initialize missing capabilities.tools')
  const listed = get(2)
  const tools = listed.result && listed.result.tools
  assert(Array.isArray(tools), 'tools/list did not return an array')
  assert(tools.length === 19, 'expected 19 visible tools, got ' + tools.length)
  assert(tools.every((t) => typeof t.name === 'string' && t.inputSchema && t.inputSchema.type === 'object'), 'malformed tool schema')
  const names = tools.map((t) => t.name)
  assert(names.indexOf('commands') === -1, 'hidden commands tool leaked into tools/list')
  for (const n of ['health', 'title', 'live-start', 'danmu-start']) assert(names.indexOf(n) !== -1, 'missing tool ' + n)
  const liveStart = tools.find((t) => t.name === 'live-start')
  assert(/\[safety: T1 confirm\]/.test(liveStart.description), 'live-start missing T1 safety annotation')
  // 单一注册表契约：--schema 是 CLI/TUI/MCP 的共同事实来源，逐项防止 Agent 工具面漂移。
  assert(Array.isArray(schema) && schema.length === 20, 'expected 20 commands in --schema')
  const schemaByName = new Map(schema.map((c) => [c.name, c]))
  const hiddenNames = schema.filter((c) => c.hidden).map((c) => c.name).sort()
  assert(hiddenNames.join(',') === 'commands', 'hidden command set changed: ' + hiddenNames.join(','))
  const visibleNames = schema.filter((c) => !c.hidden).map((c) => c.name).sort()
  const toolNames = names.slice().sort()
  assert(visibleNames.join(',') === toolNames.join(','), 'tools/list names differ from --schema visible commands')
  const kindType = { text: 'string', flag: 'boolean', number: 'number' }
  let argCount = 0
  let requiredCount = 0
  let confirmCount = 0
  for (const tool of tools) {
    const c = schemaByName.get(tool.name)
    assert(c && c.schema, 'missing --schema command for tool ' + tool.name)
    const tier = c.schema.safety
    assert(tier === 'read_only' || tier === 'confirm', 'unexpected safety tier for ' + tool.name + ': ' + tier)
    if (tier === 'confirm') confirmCount += 1
    const expectedDescription = c.schema.about + (tier === 'confirm' ? ' [safety: T1 confirm]' : '')
    assert(tool.description === expectedDescription, 'description/safety annotation drift for ' + tool.name)
    const args = Array.isArray(c.schema.args) ? c.schema.args : []
    const props = (tool.inputSchema && tool.inputSchema.properties) || {}
    const expectedKeys = args.map((a) => a.name).sort()
    const actualKeys = Object.keys(props).sort()
    assert(expectedKeys.join(',') === actualKeys.join(','), 'inputSchema property drift for ' + tool.name)
    const expectedRequired = args.filter((a) => a.required).map((a) => a.name).sort()
    const actualRequired = ((tool.inputSchema && tool.inputSchema.required) || []).slice().sort()
    assert(expectedRequired.join(',') === actualRequired.join(','), 'inputSchema required drift for ' + tool.name)
    requiredCount += expectedRequired.length
    for (const a of args) {
      argCount += 1
      const expectedType = kindType[a.kind && a.kind.type]
      assert(expectedType, 'unhandled arg kind for ' + tool.name + '.' + a.name)
      assert(props[a.name].type === expectedType, 'inputSchema type drift for ' + tool.name + '.' + a.name)
      assert(props[a.name].description === a.about, 'inputSchema description drift for ' + tool.name + '.' + a.name)
    }
  }
  assert(confirmCount > 0 && confirmCount < tools.length, 'expected a mix of read_only and confirm tiers')
  // 白名单必须只指向注册表里可见的 T1 命令；文档列表必须与源码常量逐项一致。
  const confirmNames = schema.filter((c) => !c.hidden && c.schema.safety === 'confirm').map((c) => c.name).sort()
  assert(agentAllowed.length === 7, 'AGENT_ALLOWED size changed: ' + agentAllowed.length)
  assert(agentAllowed.join(',') === parseDocList(readmeText, 'MCP Agent').join(','), 'README Agent whitelist drift')
  assert(agentAllowed.join(',') === parseDocList(mcpDocText, '允许').join(','), 'docs/MCP.md Agent whitelist drift')
  for (const name of agentAllowed) {
    assert(confirmNames.includes(name), 'AGENT_ALLOWED name missing from visible T1 schema: ' + name)
    assert(tools.some((t) => t.name === name), 'AGENT_ALLOWED name missing from tools/list: ' + name)
  }
  const deniedT1 = confirmNames.filter((name) => !agentAllowed.includes(name))
  assert(deniedT1.length === 5, 'Agent-denied T1 set changed: ' + deniedT1.join(','))
  for (const name of deniedT1) assert(mcpDocText.includes(name), 'docs/MCP.md missing denied command ' + name)
  assert(readmeText.includes('login-logout'), 'README must document the full denied T1 set')
  const expectedArgCount = schema.filter((c) => !c.hidden).reduce((n, c) => n + (c.schema.args || []).length, 0)
  const expectedRequiredCount = schema.filter((c) => !c.hidden).reduce((n, c) => n + (c.schema.args || []).filter((a) => a.required).length, 0)
  assert(expectedArgCount > 0 && expectedRequiredCount > 0, '--schema unexpectedly has no typed arguments')
  assert(argCount === expectedArgCount && requiredCount === expectedRequiredCount, 'argument count drift: ' + argCount + '/' + requiredCount)
  const health = get(3)
  assert(health.result && health.result.isError === false, 'health tool call errored')
  const payload = JSON.parse(health.result.content[0].text)
  assert(payload.ok === true && payload.name === 'lyblive' && payload.backend === 'lilyco', 'unexpected health payload')
  const denied = get(4)
  assert(denied.result && denied.result.isError === true, 'live-start must be denied for Agent')
  assert(/Agent 调用面未放行|安全门/.test(denied.result.content[0].text), 'unexpected denial text')
  const unknown = get(5)
  assert(unknown.error && unknown.error.code === -32602, 'unknown tool must be -32602')
  assert(/unknown tool/.test((unknown.error && unknown.error.message) || ''), 'unexpected unknown-tool message')
  const allowedWrite = get(6)
  assert(allowedWrite.result && allowedWrite.result.isError === false, 'whitelisted danmu-stop must be allowed for Agent')
  assert(JSON.parse(allowedWrite.result.content[0].text).ok === true, 'unexpected danmu-stop payload')
  const deniedWrite = get(7)
  assert(deniedWrite.result && deniedWrite.result.isError === true, 'non-whitelisted login-logout must be denied for Agent')
  assert(/安全门/.test(deniedWrite.result.content[0].text), 'unexpected login-logout denial text')
  console.log('mcp-smoke: whitelist/docs parity OK (' + agentAllowed.length + ' allowed, ' + deniedT1.length + ' denied T1)')
  console.log('mcp-smoke: schema parity OK (' + schema.length + ' commands; ' + tools.length + ' visible; ' + expectedArgCount + ' typed args; ' + expectedRequiredCount + ' required)')
  console.log('mcp-smoke: ' + tools.length + ' tools; initialize/tools/list/health allow/live-start deny/whitelist allow+deny/unknown -32602 OK')
} finally {
  rmSync(configHome, { recursive: true, force: true })
}

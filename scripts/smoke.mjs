import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 跨平台 CLI 契约回归；可用 argv[2] 指定归档中的二进制，配合 LYBLIVE_SMOKE_WRAPPER=wine 校验 Windows 产物。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetRoot = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : resolve(root, 'target')
const candidates = [
  process.argv[2],
  join(targetRoot, 'release', 'lyblive'),
  join(targetRoot, 'release', 'lyblive.exe'),
].filter(Boolean)
const binary = candidates.find((path) => existsSync(path))

if (!binary) {
  console.error('smoke: build the release binary first: cargo build --release')
  process.exit(1)
}

const wrapper = (process.env.LYBLIVE_SMOKE_WRAPPER || '').trim().split(/\s+/).filter(Boolean)
const configHome = mkdtempSync(join(tmpdir(), 'lyblive-smoke-'))

function run(args) {
  const cmd = [...wrapper, binary, ...args]
  return execFileSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LYBLIVE_CONFIG_HOME: configHome, NO_COLOR: '1' },
  })
}

try {
  const version = run(['--version']).trim()
  if (!version.startsWith('lyblive ')) throw new Error('unexpected --version output: ' + version)

  const help = run(['--help'])
  if (help.length < 100 || !help.includes('MCP') || !help.includes('LYBLIVE_PORT')) {
    throw new Error('--help output is unexpectedly small or missing key sections')
  }

  const schema = JSON.parse(run(['--schema']))
  if (!Array.isArray(schema) || schema.length < 20) {
    throw new Error('--schema returned ' + (Array.isArray(schema) ? schema.length : 'non-array') + ' commands')
  }
  if (!schema.every((command) => typeof command.name === 'string' && command.schema)) {
    throw new Error('--schema contains malformed commands')
  }
  const tiers = Object.fromEntries(schema.map((command) => [command.name, command.schema.safety]))
  if (tiers.health !== 'read_only') throw new Error('health must be read_only')
  if (tiers['live-start'] !== 'confirm') throw new Error('live-start must be confirm')

  const health = JSON.parse(run(['health', '--json']))
  if (health.ok !== true || health.name !== 'lyblive') throw new Error('health --json failed')

  const listed = JSON.parse(run(['commands', '--json']))
  if (!Array.isArray(listed.commands) || listed.commands.length < 20) {
    throw new Error('commands --json did not return all command descriptions')
  }

  console.log('smoke: ' + version.split('\n')[0] + '; ' + schema.length + ' commands; --help/--schema/health/commands OK')
} finally {
  rmSync(configHome, { recursive: true, force: true })
}

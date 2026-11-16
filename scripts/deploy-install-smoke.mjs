#!/usr/bin/env node
// Offline behavioral smoke test for deploy/install.py; pure Node stdlib, no network/credentials.
// Runs the installer against a temporary HOME in --fixture mode and verifies portability,
// idempotency, Qt-equivalent dock rendering, port override, mode repair, and all input guards.
// Windows CI without symlink privilege falls back to hard links for write-through checks.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, symlinkSync, linkSync, lstatSync, readdirSync, statSync, chmodSync, readlinkSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname, basename, isAbsolute, relative, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const NL = String.fromCharCode(10)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const installer = join(root, 'deploy', 'install.py')
function must(cond, msg) { if (!cond) throw new Error('deploy-install-smoke: ' + msg) }

const probe = ['-c', 'import sys; assert sys.version_info >= (3, 7)']
const candidates = [{ cmd: 'python3', pre: [] }, { cmd: 'python', pre: [] }, { cmd: 'py', pre: ['-3'] }]
let py = null
for (const c of candidates) {
  const r = spawnSync(c.cmd, [...c.pre, ...probe], { encoding: 'utf8' })
  if (r.status === 0 && !r.error) { py = c; break }
}
must(py, 'no Python >= 3.7 interpreter found (tried python3, python, py -3)')
function runInstaller(args, env, script = installer) {
  return spawnSync(py.cmd, [...py.pre, script, ...args], {
    encoding: 'utf8', cwd: root, env, maxBuffer: 8 * 1024 * 1024, timeout: 30000
  })
}
function iniSectionName(line) {
  const s = line.trimStart()
  if (!s.startsWith('[')) return null
  const close = s.indexOf(']')
  if (close < 0) return null
  return s.slice(1, close).trim()
}
function dockKeyLines(iniPath) {
  const lines = readFileSync(iniPath, 'utf8').split(NL)
  let inBasic = false
  const out = []
  for (const line of lines) {
    const sec = iniSectionName(line)
    if (sec !== null) { inBasic = sec === 'BasicWindow'; continue }
    if (inBasic && line.trimStart().toLowerCase().startsWith('extrabrowserdocks=')) out.push(line)
  }
  return out
}
function dockValue(iniPath) {
  const line = dockKeyLines(iniPath).find((l) => l.startsWith('ExtraBrowserDocks='))
  must(line, 'canonical BasicWindow ExtraBrowserDocks line missing')
  return JSON.parse(line.slice('ExtraBrowserDocks='.length).trim())
}
function sectionDockLines(iniPath, section) {
  const lines = readFileSync(iniPath, 'utf8').split(NL)
  let current = null
  const out = []
  for (const line of lines) {
    const sec = iniSectionName(line)
    if (sec !== null) { current = sec; continue }
    if (current === section && line.trimStart().toLowerCase().startsWith('extrabrowserdocks=')) out.push(line)
  }
  return out
}
function applyDock(iniPath, env) {
  const args = ['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', iniPath]
  const r = runInstaller(args, env)
  must(r.status === 0, '--apply fixture exited ' + r.status + ': ' + (r.stderr || ''))
  return r
}
function hasBareLf(text) {
  return text.replaceAll(String.fromCharCode(13) + NL, '').includes(NL)
}

// Windows 的 TEMP 位于真实用户目录内（C:\Users\<user>\AppData\Local\Temp），而
// installer 的 --fixture 要求临时 HOME 不在真实 home 内，因此这种情况改到系统盘根。
function smokeTempRoot() {
  const base = tmpdir()
  if (process.platform === 'win32') {
    const rel = relative(homedir(), base)
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    if (inside) return parse(homedir()).root
  }
  return base
}
const temp = mkdtempSync(join(smokeTempRoot(), 'dsh-deploy-smoke-'))
const obsSimDir = join(temp, "obs-detect-sim")
mkdirSync(obsSimDir, { recursive: true })
writeFileSync(join(obsSimDir, "sitecustomize.py"), [
  "import os",
  "import subprocess",
  "_real_run = subprocess.run",
  "def _obs_sim_run(args, *rest, **kwargs):",
  "    is_obs = isinstance(args, list) and (args[:2] == ['pgrep', '-x'] or (len(args) >= 2 and str(args[0]).lower() == 'tasklist' and 'IMAGENAME eq obs64.exe' in ' '.join(str(a) for a in args[1:])))",
  "    if is_obs:",
  "        state = os.environ.get('LYBLIVE_SMOKE_OBS_STATE', 'clear')",
  "        if state == 'timeout':",
  "            if 'timeout' not in kwargs:",
  "                return subprocess.CompletedProcess(args, 1, stdout='', stderr='')",
  "            raise subprocess.TimeoutExpired(cmd=args, timeout=float(kwargs['timeout']))",
  "        if state == 'running':",
  "            if str(args[0]).lower() == 'tasklist':",
  "                return subprocess.CompletedProcess(args, 0, stdout='obs64.exe', stderr='')",
  "            return subprocess.CompletedProcess(args, 0, stdout='', stderr='')",
  "        return subprocess.CompletedProcess(args, 1, stdout='', stderr='')",
  "    return _real_run(args, *rest, **kwargs)",
  "subprocess.run = _obs_sim_run",
  ""
].join(NL))
function obsSimEnv(base, state) {
  return { ...base, PYTHONPATH: obsSimDir, LYBLIVE_SMOKE_OBS_STATE: state }
}
const forcedNoSymlink = process.env.LYBLIVE_SMOKE_FORCE_NO_SYMLINK === '1'
const windowsLike = process.platform === 'win32' || forcedNoSymlink
function supportsSymlinks() {
  if (forcedNoSymlink) return false
  const target = join(temp, '.symlink-probe-target')
  const link = join(temp, '.symlink-probe-link')
  writeFileSync(target, 'probe')
  rmSync(link, { force: true })
  try {
    symlinkSync(target, link)
    const ok = lstatSync(link).isSymbolicLink()
    rmSync(link, { force: true })
    return ok
  } catch (e) {
    rmSync(link, { force: true })
    return false
  }
}
const symlinksAvailable = supportsSymlinks()
const fakeHome = join(temp, 'home')
const fakeConfig = join(fakeHome, '.config')
const fixtureDir = join(fakeHome, 'fixtures')
mkdirSync(fakeConfig, { recursive: true })
mkdirSync(fixtureDir, { recursive: true })
const dockIni = join(fixtureDir, 'user.ini')
// repeated [BasicWindow] fixture + trailing-comment header fixture + case-variant key fixture:
// Qt groups repeated sections, accepts text after ']', and later duplicate keys win.
writeFileSync(dockIni, [
  '[General]', 'Foo=bar', '',
  '[BasicWindow]',
  '  ExtraBrowserDocks=[{"title":"other","url":"https://example.invalid/","uuid":"keepme"}]',
  'ExtraBrowserDocks=[{"title":"third","url":"https://third.invalid/","uuid":"keep3"}]',
  '',
  '[Panels] ; comment',
  'ExtraBrowserDocks=[{"title":"late","url":"https://late.invalid/","uuid":"keeplate"}]',
  '',
  '[BasicWindow]',
  '  extrabrowserdocks=[{"title":"case","url":"https://case.invalid/","uuid":"keepcase"}]',
  'ExtraBrowserDocks=[{"title":"fourth","url":"https://fourth.invalid/","uuid":"keep4"}]',
  ''
].join(NL))
const baseEnv = { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: fakeConfig, LYBLIVE_PORT: '8768' }
const installerRoot = dirname(resolve(fileURLToPath(import.meta.url), '..'))
const webUnit = join(fakeConfig, 'systemd', 'user', 'lyblive.service')
const obsUnit = join(fakeConfig, 'systemd', 'user', 'lyblive-obs.service')
const launcher = join(fakeHome, '.local', 'bin', 'lyblive-obs')

try {
  // 1. --plan is strictly read-only. --no-binary avoids requiring a built binary.
  const plan = runInstaller(['--plan', '--no-binary'], baseEnv)
  must(plan.status === 0, '--plan exited ' + plan.status + ': ' + (plan.stderr || ''))
  must(!existsSync(webUnit) && !existsSync(launcher), '--plan wrote files (not read-only)')

  // 2. Apply in offline fixture mode.
  const applyArgs = ['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', dockIni]
  const apply = runInstaller(applyArgs, baseEnv)
  must(apply.status === 0, '--apply fixture exited ' + apply.status + ': ' + (apply.stderr || ''))
  for (const p of [webUnit, obsUnit, launcher]) must(existsSync(p), 'missing generated file ' + p)

  const forbidden = ['/home/lilyco', '/run/user/', 'DISPLAY=:', 'XAUTHORITY=', 'PassEnvironment=']
  const web = readFileSync(webUnit, 'utf8')
  const obs = readFileSync(obsUnit, 'utf8')
  const lnch = readFileSync(launcher, 'utf8')
  must(web.includes('Environment=HOME=%h') && web.includes('Environment=LYBLIVE_PORT=8768') && web.includes('WantedBy=default.target') && web.includes('ExecStart=%h/.local/bin/lyblive --web --no-browser'), 'portable Web unit drift')
  must(obs.includes('WantedBy=graphical-session.target') && obs.includes('PartOf=graphical-session.target') && obs.includes('After=graphical-session.target') && obs.includes('ExecStart=%h/.local/bin/lyblive-obs') && obs.includes('Restart=on-failure'), 'portable OBS unit drift')
  must(lnch.includes('-u WAYLAND_DISPLAY') && lnch.includes('-u SESSION_MANAGER') && lnch.includes('-u DESKTOP_STARTUP_ID') && lnch.includes('-u XDG_ACTIVATION_TOKEN') && lnch.includes('QT_QPA_PLATFORM=xcb') && lnch.includes('XDG_SESSION_TYPE=x11'), 'portable launcher drift')
  for (const pair of [['web', web], ['obs', obs], ['launcher', lnch]]) {
    for (const n of forbidden) must(!pair[1].includes(n), pair[0] + ' hardcodes ' + n)
  }

  // 3. Qt-equivalent dock merge: all BasicWindow dock keys become ONE canonical column-0 key.
  const keyLines = dockKeyLines(dockIni)
  must(keyLines.length === 1, 'render_dock left ' + keyLines.length + ' BasicWindow ExtraBrowserDocks keys (expected one canonical key)')
  must(keyLines[0].startsWith('ExtraBrowserDocks='), 'canonical ExtraBrowserDocks key is indented')
  const docks = dockValue(dockIni)
  const byTitle = (t) => docks.find((d) => d.title === t)
  must(byTitle('other') && byTitle('other').uuid === 'keepme', 'render_dock dropped unrelated indented-key dock/uuid')
  must(byTitle('third') && byTitle('third').uuid === 'keep3', 'render_dock dropped a dock from a duplicate key')
  must(byTitle('case') && byTitle('case').uuid === 'keepcase', 'render_dock dropped a dock from a case-variant key')
  must(byTitle('fourth') && byTitle('fourth').uuid === 'keep4', 'render_dock dropped a dock from a repeated [BasicWindow] section')
  must(!byTitle('late'), 'render_dock absorbed a dock from another section')
  must(docks.length === 5, 'render_dock did not merge into exactly 5 docks')
  const lyb = byTitle('lyblive')
  must(lyb && lyb.url === 'http://127.0.0.1:8768/' && lyb.uuid, 'render_dock lyblive URL/uuid drift')
  const iniText = readFileSync(dockIni, 'utf8')
  must(iniText.includes('[Panels] ; comment') && iniText.includes('"title":"late"'), 'trailing-comment header fixture lost its Panels dock')
  must(iniText.split(NL).filter((l) => iniSectionName(l) === 'BasicWindow').length === 2, 'repeated [BasicWindow] fixture lost a section')

  // 4. Second apply is idempotent: every real write must report unchanged.
  // A loose stdout.includes('unchanged') is insufficient because --plan prints [unchanged] too.
  const again = runInstaller(applyArgs, baseEnv)
  must(again.status === 0, 'second --apply exited ' + again.status)
  const againOut = again.stdout || ''
  for (const label of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs', 'OBS dock']) {
    must(againOut.includes(label + ': unchanged'), 'second --apply not idempotent: ' + label)
  }
  must(!againOut.includes(': written'), 'second --apply rewrote a file')
  must(dockKeyLines(dockIni).length === 1, 'second --apply left duplicate BasicWindow dock keys')

  // 4a. A frozen clock must not collapse repeated backups into one timestamped file.
  const frozenDir = join(temp, "frozen-backup-home")
  const frozenUnitDir = join(frozenDir, ".config", "systemd", "user")
  mkdirSync(frozenUnitDir, { recursive: true })
  const frozenUnit = join(frozenUnitDir, "lyblive.service")
  const frozenBinDir = join(frozenDir, ".local", "bin")
  mkdirSync(frozenBinDir, { recursive: true })
  writeFileSync(join(frozenBinDir, "lyblive"), "FROZEN_BINARY")
  const frozenEnv = { ...process.env, HOME: frozenDir, XDG_CONFIG_HOME: join(frozenDir, ".config"), LYBLIVE_PORT: "8768" }
  const frozenShimDir = join(temp, "frozen-clock-shim")
  mkdirSync(frozenShimDir, { recursive: true })
  writeFileSync(join(frozenShimDir, "sitecustomize.py"), "import time" + NL + "time.strftime = lambda *args, **kwargs: 'FROZENSTAMP'" + NL)
  const frozenVersions = ["version-0", "version-1", "version-2", "version-3"]
  for (const version of frozenVersions) {
    writeFileSync(frozenUnit, version)
    const frozenArgs = ["--apply", "--no-systemctl", "--no-binary"]
    const result = runInstaller(frozenArgs, { ...frozenEnv, PYTHONPATH: frozenShimDir })
    must(result.status === 0, "frozen-clock apply failed: " + (result.stderr || ""))
  }
  const backupNames = readdirSync(frozenUnitDir).filter((n) => n.startsWith("lyblive.service.dsh-portable-backup") && lstatSync(join(frozenUnitDir, n)).isFile())
  const backupBodies = backupNames.map((n) => readFileSync(join(frozenUnitDir, n), "utf8")).sort()
  must(backupNames.length === 4, "frozen-clock backup_copy created " + backupNames.length + " files (expected 4)")
  must(backupBodies.join("|") === frozenVersions.slice().sort().join("|"), "frozen-clock backup_copy overwrote a prior version")

  // 4b. Owner permission bits are part of idempotency, not just file content.
  const posixMode = process.platform !== 'win32'
  const modeHome = join(temp, 'mode-home')
  const modeConfig = join(modeHome, '.config')
  const modeBin = join(modeHome, '.local', 'bin')
  mkdirSync(modeBin, { recursive: true })
  const modeEnv = { ...process.env, HOME: modeHome, XDG_CONFIG_HOME: modeConfig, LYBLIVE_PORT: '8768' }
  const modeWebUnit = join(modeConfig, 'systemd', 'user', 'lyblive.service')
  const modeObsUnit = join(modeConfig, 'systemd', 'user', 'lyblive-obs.service')
  const modeLauncher = join(modeBin, 'lyblive-obs')
  const modeBinary = join(modeBin, 'lyblive')
  writeFileSync(modeBinary, 'MODE_BINARY_FIXTURE', { mode: 0o644 })
  const modeApplyArgs = ['--apply', '--no-binary', '--no-systemctl']
  const canonicalMode = (p, mode) => (statSync(p).mode & 0o7777) === mode
  const expectMode = (p, mode, msg) => must(canonicalMode(p, mode), msg + ': got ' + (statSync(p).mode & 0o7777).toString(8))
  const firstModeApply = runInstaller(modeApplyArgs, modeEnv)
  must(firstModeApply.status === 0, 'mode fixture first --apply exited ' + firstModeApply.status + ': ' + (firstModeApply.stderr || ''))
  if (posixMode) {
    chmodSync(modeWebUnit, 0o400)
    chmodSync(modeObsUnit, 0o400)
    chmodSync(modeLauncher, 0o644)
    chmodSync(modeBinary, 0o644)
    const modePlan = runInstaller(['--plan', '--no-binary', '--no-systemctl'], modeEnv)
    must(modePlan.status === 0, 'mode repair --plan exited ' + modePlan.status + ': ' + (modePlan.stderr || ''))
    const modePlanOut = modePlan.stdout || ''
    const launcherPlanLine = modePlanOut.split(NL).find((l) => l.includes('lyblive-obs -> '))
    const binaryPlanLine = modePlanOut.split(NL).find((l) => l.includes('binary -> '))
    must(launcherPlanLine && launcherPlanLine.includes('[mode repair]'), '--plan hid a missing launcher executable bit: ' + modePlanOut.trim())
    must(binaryPlanLine && binaryPlanLine.includes('[keep existing / mode repair]'), '--plan hid a missing binary executable bit: ' + modePlanOut.trim())
    must(canonicalMode(modeLauncher, 0o644), '--plan changed permissions (not read-only)')
    const modeRepair = runInstaller(modeApplyArgs, modeEnv)
    must(modeRepair.status === 0, 'mode repair --apply exited ' + modeRepair.status + ': ' + (modeRepair.stderr || ''))
    const modeRepairOut = modeRepair.stdout || ''
    for (const label of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs']) {
      must(modeRepairOut.includes(label + ': mode repaired'), 'content-only idempotency hid a missing permission bit: ' + label)
    }
    must(modeRepairOut.includes('binary: binary mode repaired'), '--no-binary kept a non-executable binary')
    must(!modeRepairOut.includes(': written'), 'mode repair rewrote file bytes')
    expectMode(modeWebUnit, 0o644, 'Web unit canonical mode was not repaired')
    expectMode(modeObsUnit, 0o644, 'OBS unit canonical mode was not repaired')
    expectMode(modeLauncher, 0o755, 'launcher canonical mode was not repaired')
    expectMode(modeBinary, 0o755, '--no-binary canonical mode was not repaired')
    must(lstatSync(modeLauncher).isFile() && !lstatSync(modeLauncher).isSymbolicLink(), 'launcher mode repair replaced a regular file with a symlink')
    // Extra group/other and setuid/setgid/sticky bits are not a content-only match.
    const modePlanBaseline = runInstaller(['--plan', '--no-binary', '--no-systemctl'], modeEnv)
    const baselineLine = (modePlanBaseline.stdout || '').split(NL).find((l) => l.includes('lyblive-obs -> '))
    must(baselineLine && baselineLine.includes('[unchanged]'), 'canonical-mode baseline drift: ' + (modePlanBaseline.stdout || '').trim())
    chmodSync(modeWebUnit, 0o464)
    chmodSync(modeObsUnit, 0o2755)
    chmodSync(modeLauncher, 0o4755)
    chmodSync(modeBinary, 0o6755)
    const extraPlan = runInstaller(['--plan', '--no-binary', '--no-systemctl'], modeEnv)
    const extraPlanOut = extraPlan.stdout || ''
    const extraLauncherPlan = extraPlanOut.split(NL).find((l) => l.includes('lyblive-obs -> '))
    const extraBinaryPlan = extraPlanOut.split(NL).find((l) => l.includes('binary -> '))
    must(extraPlan.status === 0 && extraLauncherPlan && extraLauncherPlan.includes('[mode repair]'), '--plan hid extra/special permission bits: ' + extraPlanOut.trim())
    must(extraBinaryPlan && extraBinaryPlan.includes('[keep existing / mode repair]'), '--plan hid binary special bits: ' + extraPlanOut.trim())
    const extraRepair = runInstaller(modeApplyArgs, modeEnv)
    const extraRepairOut = extraRepair.stdout || ''
    must(extraRepair.status === 0, 'extra-bit repair --apply exited ' + extraRepair.status + ': ' + (extraRepair.stderr || ''))
    for (const label of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs']) must(extraRepairOut.includes(label + ': mode repaired'), 'extra/special bits were treated as unchanged: ' + label)
    must(extraRepairOut.includes('binary: binary mode repaired'), '--no-binary preserved special permission bits')
    must(!extraRepairOut.includes(': written'), 'extra/special-bit repair rewrote file bytes')
    expectMode(modeWebUnit, 0o644, 'Web unit extra/special bits were not stripped')
    expectMode(modeObsUnit, 0o644, 'OBS unit extra/special bits were not stripped')
    expectMode(modeLauncher, 0o755, 'launcher extra/special bits were not stripped')
    expectMode(modeBinary, 0o755, '--no-binary extra/special bits were not stripped')
    const extraAgain = runInstaller(['--plan', '--no-binary', '--no-systemctl'], modeEnv)
    for (const label of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs']) {
      const line = (extraAgain.stdout || '').split(NL).find((l) => l.includes(label + ' -> '))
      must(line && line.includes('[unchanged]'), 'extra/special-bit --plan did not settle: ' + label)
    }
    const modeAgain = runInstaller(modeApplyArgs, modeEnv)
    const modeAgainOut = modeAgain.stdout || ''
    must(modeAgain.status === 0, 'post-repair --apply exited ' + modeAgain.status)
    for (const label of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs']) {
      must(modeAgainOut.includes(label + ': unchanged'), 'post-repair idempotency drift: ' + label)
    }
    must(modeAgainOut.includes('binary: kept existing binary'), 'post-repair --no-binary reported a spurious rewrite')
    must(!modeAgainOut.includes(': mode repaired') && !modeAgainOut.includes(': written'), 'post-repair --apply repeated a mode repair')
  }

  // 5. LYBLIVE_PORT propagates to both the unit and dock URL, preserving the dock uuid.
  const portEnv = { ...baseEnv, LYBLIVE_PORT: '8769' }
  const applyPort = runInstaller(applyArgs, portEnv)
  must(applyPort.status === 0, 'port override --apply exited ' + applyPort.status)
  must(readFileSync(webUnit, 'utf8').includes('Environment=LYBLIVE_PORT=8769'), 'LYBLIVE_PORT did not reach Web unit')
  const lyb2 = dockValue(dockIni).find((d) => d.title === 'lyblive')
  must(lyb2 && lyb2.url === 'http://127.0.0.1:8769/', 'LYBLIVE_PORT did not reach dock URL')
  must(lyb2 && lyb2.uuid === lyb.uuid, 'lyblive dock uuid changed across port override')
  must(dockKeyLines(dockIni).length === 1, 'port override left duplicate BasicWindow dock keys')

  // 6. no BasicWindow section fixture: create a real section, never a bare top-level key.
  const noSectionIni = join(fixtureDir, 'no-section.ini')
  writeFileSync(noSectionIni, '[General]' + NL + 'Foo=bar')
  applyDock(noSectionIni, baseEnv)
  const noSectionText = readFileSync(noSectionIni, 'utf8')
  const noLines = noSectionText.split(NL)
  const basicIdx = noLines.findIndex((l) => iniSectionName(l) === 'BasicWindow')
  const dockIdx = noLines.findIndex((l) => l.startsWith('ExtraBrowserDocks='))
  must(basicIdx >= 0 && dockIdx > basicIdx, 'bare top-level dock key created without [BasicWindow]')
  must(noSectionText.includes(NL + 'Foo=bar' + NL), 'missing [BasicWindow] fixture concatenated Foo=bar')
  must(!noSectionText.includes('Foo=barExtraBrowserDocks='), 'new dock key concatenated to last line')
  must(dockKeyLines(noSectionIni).length === 1, 'missing [BasicWindow] fixture left duplicate dock keys')
  const noSectionDocks = dockValue(noSectionIni)
  must(noSectionDocks.length === 1 && noSectionDocks[0].url === 'http://127.0.0.1:8768/', 'missing [BasicWindow] fixture dock drift')

  // 7. missing trailing newline fixture: an existing BasicWindow with no key must not glue lines.
  const noKeyNoEolIni = join(fixtureDir, 'no-key-no-eol.ini')
  writeFileSync(noKeyNoEolIni, '[BasicWindow]' + NL + 'Foo=bar')
  applyDock(noKeyNoEolIni, baseEnv)
  const noKeyText = readFileSync(noKeyNoEolIni, 'utf8')
  must(noKeyText.includes(NL + 'Foo=bar' + NL), 'missing trailing newline fixture not repaired')
  must(!noKeyText.includes('Foo=barExtraBrowserDocks='), 'new dock key concatenated to Foo=bar')
  must(dockKeyLines(noKeyNoEolIni).length === 1, 'missing trailing newline fixture left duplicate dock keys')

  // 8. CRLF fixture: preserve CRLF and merge an indented key.
  const crlfIni = join(fixtureDir, 'crlf.ini')
  const crlf = String.fromCharCode(13) + NL
  writeFileSync(crlfIni, ['[General]', 'Foo=bar', '', '[BasicWindow]', '  ExtraBrowserDocks=[{"title":"crlf","uuid":"keepcrlf"}]', ''].join(crlf))
  applyDock(crlfIni, baseEnv)
  const crlfText = readFileSync(crlfIni, 'utf8')
  must(crlfText.includes(crlf) && !hasBareLf(crlfText), 'CRLF fixture lost line endings')
  must(dockKeyLines(crlfIni).length === 1, 'CRLF fixture left duplicate dock keys')
  must(dockValue(crlfIni).some((d) => d.uuid === 'keepcrlf'), 'CRLF fixture dropped an existing dock')

  // 8b. UTF-8 BOM plus Qt inline comment: preserve BOM, one section, one canonical dock key.
  const bomIni = join(fixtureDir, 'bom.ini')
  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[BasicWindow]' + NL + 'ExtraBrowserDocks=[{"title":"bom","uuid":"keepbom"}] ; Qt inline comment' + NL + '[Panels]' + NL + 'Foo=bar' + NL, 'utf8')])
  writeFileSync(bomIni, bomBytes)
  const bomPlan = runInstaller(['--plan', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', bomIni], baseEnv)
  must(bomPlan.status === 0, 'BOM dock --plan exited ' + bomPlan.status)
  must(readFileSync(bomIni).equals(bomBytes), 'BOM dock --plan was not read-only')
  const bomApply = applyDock(bomIni, baseEnv)
  const bomAfter = readFileSync(bomIni)
  const bomText = bomAfter.toString('utf8')
  must(bomAfter.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'UTF-8 BOM dock prefix was lost')
  must((bomText.match(/\[BasicWindow\]/g) || []).length === 1, 'BOM dock gained a duplicate [BasicWindow] section')
  must(dockKeyLines(bomIni).length === 1, 'BOM dock left duplicate ExtraBrowserDocks keys')
  must(dockValue(bomIni).some((d) => d.uuid === 'keepbom'), 'BOM dock dropped an existing dock')
  must(dockValue(bomIni).some((d) => d.title === 'lyblive' && d.url === 'http://127.0.0.1:8768/'), 'BOM dock did not add lyblive')
  must(bomText.includes(NL + '[Panels]' + NL + 'Foo=bar' + NL), 'BOM dock lost [Panels] data')
  const bomAgain = applyDock(bomIni, baseEnv)
  must((bomAgain.stdout || '').includes('OBS dock: unchanged'), 'BOM dock second --apply was not idempotent')
  must(readFileSync(bomIni).equals(bomAfter), 'BOM dock second --apply rewrote bytes')


  // 8c. An indented header must end the previous section (Qt readIniLine trims
  // leading spaces before checking for "["). A dock key under "  [Other]" belongs
  // to Other and must never be absorbed into BasicWindow.
  const indentedIni = join(fixtureDir, 'indented-section.ini')
  writeFileSync(indentedIni, [
    '[BasicWindow]',
    'ExtraBrowserDocks=[{"title":"keepme","uuid":"keepindent"}]',
    '  [Other]',
    'ExtraBrowserDocks=[{"title":"otherdock","uuid":"keepother"}]',
    'Bar=1',
    ''
  ].join(NL))
  applyDock(indentedIni, baseEnv)
  const indentedText = readFileSync(indentedIni, 'utf8')
  must(dockKeyLines(indentedIni).length === 1, 'indented-section fixture left duplicate BasicWindow dock keys')
  const indentedBasic = dockValue(indentedIni)
  must(indentedBasic.some((d) => d.uuid === 'keepindent'), 'indented-section fixture dropped the existing dock')
  must(!indentedBasic.some((d) => d.uuid === 'keepother'), 'indented [Other] dock key was absorbed into BasicWindow')
  must(sectionDockLines(indentedIni, 'Other').length === 1, 'indented [Other] dock key was destroyed')
  must(indentedText.includes(NL + '  [Other]' + NL), 'indented-section fixture rewrote the header line')
  must(indentedText.includes(NL + 'Bar=1' + NL), 'indented-section fixture lost the Other section body')

  // 8d. An indented [BasicWindow] header is still BasicWindow: merge into it,
  // never append a second section.
  const indentedBasicIni = join(fixtureDir, 'indented-basic.ini')
  writeFileSync(indentedBasicIni, [
    '  [BasicWindow]',
    'ExtraBrowserDocks=[{"title":"keepme","uuid":"keepindentbasic"}]',
    ''
  ].join(NL))
  applyDock(indentedBasicIni, baseEnv)
  const indentedBasicText = readFileSync(indentedBasicIni, 'utf8')
  must((indentedBasicText.match(/\[BasicWindow\]/g) || []).length === 1, 'indented [BasicWindow] fixture gained a duplicate section')
  must(dockKeyLines(indentedBasicIni).length === 1, 'indented [BasicWindow] fixture left duplicate dock keys')
  must(dockValue(indentedBasicIni).some((d) => d.uuid === 'keepindentbasic'), 'indented [BasicWindow] fixture dropped the existing dock')
  must(dockValue(indentedBasicIni).some((d) => d.title === 'lyblive'), 'indented [BasicWindow] fixture did not add lyblive')
  // 8e. A ";" inside a quoted run belongs to the value: dock URLs such as
  // ".../api;jsessionid=abc" must survive instead of being truncated into
  // invalid JSON and refused.
  const semiUrlIni = join(fixtureDir, 'semicolon-url.ini')
  writeFileSync(semiUrlIni, [
    '[BasicWindow]',
    'ExtraBrowserDocks=[{"title":"other","url":"http://127.0.0.1:9/api;jsessionid=abc","uuid":"keepsemi"}]',
    '[Panels]',
    'Foo=bar',
    ''
  ].join(NL))
  applyDock(semiUrlIni, baseEnv)
  must(dockKeyLines(semiUrlIni).length === 1, 'semicolon URL fixture left duplicate dock keys')
  const semiDocks = dockValue(semiUrlIni)
  must(semiDocks.some((d) => d.uuid === 'keepsemi' && d.url === 'http://127.0.0.1:9/api;jsessionid=abc'), 'quoted ";" in a dock URL was truncated')
  must(semiDocks.some((d) => d.title === 'lyblive'), 'semicolon URL fixture did not add lyblive')
  must(readFileSync(semiUrlIni, 'utf8').includes(NL + 'Foo=bar' + NL), 'semicolon URL fixture lost the Other section body')

  // 8f. An unquoted ";" is still a comment terminator for Qt.
  const semiCommentIni = join(fixtureDir, 'semicolon-comment.ini')
  writeFileSync(semiCommentIni, '[BasicWindow]' + NL + 'ExtraBrowserDocks=[{"title":"keep","uuid":"keepcomment"}] ; note ; two' + NL)
  applyDock(semiCommentIni, baseEnv)
  must(dockValue(semiCommentIni).some((d) => d.uuid === 'keepcomment'), 'unquoted ";" comment dropped the existing dock')
  must(dockValue(semiCommentIni).some((d) => d.title === 'lyblive'), 'unquoted ";" comment fixture did not add lyblive')

  // 9. Bad JSON and non-array JSON are refused, not silently overwritten.
  for (const bad of [
    { name: 'bad JSON', value: 'not-json', expect: 'ExtraBrowserDocks is not valid JSON; refusing to overwrite' },
    { name: 'non-array JSON', value: '{}', expect: 'ExtraBrowserDocks is not a JSON array; refusing to overwrite' }
  ]) {
    const badIni = join(fixtureDir, 'bad-' + bad.name.replaceAll(' ', '-') + '.ini')
    const original = '[BasicWindow]' + NL + 'ExtraBrowserDocks=' + bad.value + NL
    writeFileSync(badIni, original)
    const applyBad = runInstaller(['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', badIni], baseEnv)
    const out = (applyBad.stdout || '') + (applyBad.stderr || '')
    must(applyBad.status === 2 && out.includes(bad.expect), bad.name + ' guard did not fire: rc=' + applyBad.status + ' ' + out.trim())
    must(!out.includes('Traceback (most recent call last)'), bad.name + ' exposed a Python traceback')
    must(readFileSync(badIni, 'utf8') === original, bad.name + ' dock was overwritten')
    const planBad = runInstaller(['--plan', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', badIni], baseEnv)
    const planOut = (planBad.stdout || '') + (planBad.stderr || '')
    must(planBad.status === 2 && planOut.includes(bad.expect), bad.name + ' --plan guard did not fire: rc=' + planBad.status + ' ' + planOut.trim())
    must(!planOut.includes('Traceback (most recent call last)'), bad.name + ' --plan exposed a Python traceback')
    must(readFileSync(badIni, 'utf8') === original, bad.name + ' --plan overwrote the dock')
  }

  // 9b. A malformed dock must abort --apply before any unit/launcher write.
  const atomicHome = join(temp, 'atomic-home')
  const atomicConfig = join(atomicHome, '.config')
  const atomicFixtures = join(atomicHome, 'fixtures')
  const atomicUnitDir = join(atomicConfig, 'systemd', 'user')
  mkdirSync(atomicUnitDir, { recursive: true })
  mkdirSync(atomicFixtures, { recursive: true })
  const atomicStaleUnit = join(atomicUnitDir, 'lyblive.service')
  const atomicLauncher = join(atomicHome, '.local', 'bin', 'lyblive-obs')
  const staleUnit = 'STALE_UNIT_SENTINEL'
  writeFileSync(atomicStaleUnit, staleUnit)
  const atomicBadIni = join(atomicFixtures, 'bad.ini')
  const atomicBadOriginal = '[BasicWindow]' + NL + 'ExtraBrowserDocks=not-json' + NL
  writeFileSync(atomicBadIni, atomicBadOriginal)
  const atomicEnv = { ...process.env, HOME: atomicHome, XDG_CONFIG_HOME: atomicConfig, LYBLIVE_PORT: '8768' }
  const atomicBad = runInstaller(['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', atomicBadIni], atomicEnv)
  const atomicOut = (atomicBad.stdout || '') + (atomicBad.stderr || '')
  must(atomicBad.status === 2 && atomicOut.includes('ExtraBrowserDocks is not valid JSON; refusing to overwrite'), 'atomic bad-JSON guard did not fire: rc=' + atomicBad.status + ' ' + atomicOut.trim())
  must(!atomicOut.includes('Traceback (most recent call last)'), 'atomic bad-JSON guard exposed a Python traceback')
  must(readFileSync(atomicBadIni, 'utf8') === atomicBadOriginal, 'atomic bad-JSON guard overwrote the dock')
  must(readFileSync(atomicStaleUnit, 'utf8') === staleUnit && !existsSync(atomicLauncher), 'bad JSON abort left partial writes')
  // 10. Input guards reject invalid usage (argparse exits 2).
  // Tilde-only HOME previously called Path("~").expanduser() with a fixture home that
  // had no passwd entry, raising RuntimeError before argparse; real account homes must win.
  // CLI tilde paths (--bin, --dock-ini) must use the same real home via user_path().
  const guards = [
    { name: 'plan+apply', args: ['--plan', '--apply', '--no-binary'], env: baseEnv, expect: '--plan and --apply are mutually exclusive' },
    { name: 'bad port', args: ['--apply', '--fixture', '--no-binary'], env: { ...baseEnv, LYBLIVE_PORT: '70000' }, expect: 'LYBLIVE_PORT must be in 1..65535' },
    { name: 'dock-ini without flag', args: ['--plan', '--no-binary', '--dock-ini', dockIni], env: baseEnv, expect: '--dock-ini requires --configure-dock' },
    { name: 'relative HOME', args: ['--plan', '--no-binary'], env: { ...baseEnv, HOME: 'relative-home' }, expect: 'HOME must be an absolute path' },
    { name: 'relative XDG_CONFIG_HOME', args: ['--plan', '--no-binary'], env: { ...baseEnv, XDG_CONFIG_HOME: 'relative-config' }, expect: 'XDG_CONFIG_HOME must be an absolute path' },
  ]
  // Corrupt/incomplete deploy bundles must fail with argparse (rc=2), not a raw traceback.
  const corruptRoot = join(temp, 'corrupt-bundle')
  const corruptDeploy = join(corruptRoot, 'deploy')
  const corruptSetup = [
    ['missing template', 'lyblive.service', 'delete'],
    ['non-UTF-8 template', 'lyblive.service', 'binary'],
    ['hardcoded path', 'lyblive-obs.service', 'hardcode'],
    ['marker drift', 'lyblive-obs.service', 'drift'],
  ]
  mkdirSync(corruptDeploy, { recursive: true })
  for (const name of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs']) {
    copyFileSync(join(installerRoot, 'deploy', name), join(corruptDeploy, name))
  }
  const corruptResults = corruptSetup.map(([name, file, mode]) => {
    const runRoot = join(corruptRoot, name.replace(/[^a-z0-9]+/gi, '-'))
    const runDeploy = join(runRoot, 'deploy')
    mkdirSync(runDeploy, { recursive: true })
    for (const f of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs']) {
      copyFileSync(join(corruptDeploy, f), join(runDeploy, f))
    }
    copyFileSync(installer, join(runDeploy, 'install.py'))
    const target = join(runDeploy, file)
    if (mode === 'delete') rmSync(target, { force: true })
    else if (mode === 'binary') writeFileSync(target, Buffer.from([0xff, 0xfe, 0x00]))
    else if (mode === 'hardcode') writeFileSync(target, readFileSync(target, 'utf8').replace('WorkingDirectory=%h/code/lyblive', 'WorkingDirectory=/home/lilyco/code/lyblive'))
    else if (mode === 'drift') writeFileSync(target, readFileSync(target, 'utf8').replace('WorkingDirectory=%h/code/lyblive', 'WorkingDirectory=%h/code/other'))
    const result = runInstaller(['--plan', '--fixture', '--no-binary'], { ...baseEnv, HOME: runRoot, XDG_CONFIG_HOME: join(runRoot, '.config') }, join(runDeploy, 'install.py'))
    const out = (result.stdout || '') + (result.stderr || '')
    return { name, result, out, detail: 'rc=' + result.status + ' ' + out.trim() }
  })
  for (const { name, result, out, detail } of corruptResults) {
    must(result.status === 2, 'corrupt bundle ' + name + ' did not fail with rc=2: ' + detail)
    must(out.includes('deployment template ') && out.includes(' is invalid: ') && out.includes('restore deploy/ from the release bundle'), 'corrupt bundle ' + name + ' lost the readable argparse error: ' + detail)
    must(!out.includes('Traceback (most recent call last)'), 'corrupt bundle ' + name + ' exposed a Python traceback')
    must(!['lyblive.service ->', 'lyblive-obs.service ->', 'lyblive-obs ->'].some(marker => out.includes(marker)), 'corrupt bundle ' + name + ' printed a write plan: ' + detail)
  }
  const corruptWriteMarkers = corruptResults.map(({ out }) => ['lyblive.service ->', 'lyblive-obs.service ->', 'lyblive-obs ->'].some(marker => out.includes(marker)))
  must(corruptWriteMarkers.every(v => !v), 'corrupt bundle printed a write plan')
  // A tilde-only HOME must expand through the real account, not via Path("~").expanduser()
  // (which raises RuntimeError for a test HOME without a passwd entry).
  const tildeEnv = { ...baseEnv, HOME: '~' }
  const tildeHome = runInstaller(['--plan', '--no-binary'], tildeEnv)
  const tildeOut = (tildeHome.stdout || '') + (tildeHome.stderr || '')
  must(tildeHome.status === 0 && !tildeOut.includes('Traceback (most recent call last)'), 'tilde HOME did not expand through the real account: rc=' + tildeHome.status + ' ' + tildeOut.trim())
  const homeMatch = tildeOut.match(/lyblive deployment plan: HOME=(.*?) config=.* port=/)
  must(homeMatch && isAbsolute(homeMatch[1]) && !homeMatch[1].includes('~'), 'tilde HOME did not expand to the real account home: ' + tildeOut.trim())
  const tildeRealHome = homeMatch[1]
  must(tildeOut.includes('lyblive.service ->'), 'tilde HOME plan lost the service destination')
  // CLI tilde paths must resolve from the real account home even when HOME is malformed.
  // Derive the expected paths from the installer's own REAL_HOME so Linux/macOS/Windows CI agree.
  const tildeBinName = basename(temp) + '-missing-lyblive'
  const tildeBinPath = join(tildeRealHome, tildeBinName)
  const tildeBin = runInstaller(['--plan', '--bin', '~/' + tildeBinName], tildeEnv)
  const tildeBinOut = (tildeBin.stdout || '') + (tildeBin.stderr || '')
  must(tildeBin.status === 2 && !tildeBinOut.includes('Traceback (most recent call last)') && tildeBinOut.includes('--bin is not a file: ' + tildeBinPath), 'tilde --bin did not resolve from the real account home: rc=' + tildeBin.status + ' ' + tildeBinOut.trim())
  const tildeDockName = basename(temp) + '-user.ini'
  const tildeDockPath = join(tildeRealHome, tildeDockName)
  const tildeDock = runInstaller(['--plan', '--no-binary', '--configure-dock', '--dock-ini', '~/' + tildeDockName], tildeEnv)
  const tildeDockOut = (tildeDock.stdout || '') + (tildeDock.stderr || '')
  must(tildeDock.status === 0 && !tildeDockOut.includes('Traceback (most recent call last)') && tildeDockOut.includes('OBS dock -> ' + tildeDockPath + ' [create]'), 'tilde --dock-ini did not resolve from the real account home: rc=' + tildeDock.status + ' ' + tildeDockOut.trim())
  must(!existsSync(tildeDockPath), 'tilde --dock-ini --plan wrote outside the temporary fixture')
  for (const g of guards) {
    const r = runInstaller(g.args, g.env)
    const combined = (r.stdout || '') + (r.stderr || '')
    must(r.status === 2 && combined.includes(g.expect), 'guard ' + g.name + ' did not fire: rc=' + r.status + ' ' + combined.trim())
    must(!combined.includes('Traceback (most recent call last)'), 'guard ' + g.name + ' exposed a Python traceback')
  }

  // 10b. --fixture must confine every write target to its temporary HOME, resolving symlinks.
  const outsideIni = join(temp, 'outside-user.ini')
  const outsideSentinel = '[BasicWindow]' + NL + 'ExtraBrowserDocks=[{"title":"untouched","uuid":"keep"}]' + NL
  writeFileSync(outsideIni, outsideSentinel)
  const escapedDock = runInstaller(['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', outsideIni], baseEnv)
  const escapedDockOut = (escapedDock.stdout || '') + (escapedDock.stderr || '')
  must(escapedDock.status === 2 && escapedDockOut.includes('--fixture requires --dock-ini'), 'fixture --dock-ini escape guard did not fire: rc=' + escapedDock.status)
  must(readFileSync(outsideIni, 'utf8') === outsideSentinel, 'fixture --dock-ini escape overwrote a file outside HOME')
  const outsideConfig = join(temp, 'outside-config')
  const escapedConfigEnv = { ...baseEnv, XDG_CONFIG_HOME: outsideConfig }
  const escapedConfig = runInstaller(['--apply', '--fixture', '--no-binary'], escapedConfigEnv)
  const escapedConfigOut = (escapedConfig.stdout || '') + (escapedConfig.stderr || '')
  must(escapedConfig.status === 2 && escapedConfigOut.includes('--fixture requires XDG_CONFIG_HOME'), 'fixture XDG_CONFIG_HOME escape guard did not fire: rc=' + escapedConfig.status)
  must(!existsSync(outsideConfig), 'fixture XDG_CONFIG_HOME escape wrote outside HOME')
  if (symlinksAvailable) {
    const linkIni = join(fixtureDir, 'symlink-escape.ini')
    symlinkSync(outsideIni, linkIni)
    const escapedLink = runInstaller(['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', linkIni], baseEnv)
    const escapedLinkOut = (escapedLink.stdout || '') + (escapedLink.stderr || '')
    must(escapedLink.status === 2 && escapedLinkOut.includes('--fixture requires --dock-ini'), 'fixture symlink dock-ini escape guard did not fire: rc=' + escapedLink.status)
    must(readFileSync(outsideIni, 'utf8') === outsideSentinel, 'fixture symlink escape overwrote target outside HOME')
  } else {
    must(windowsLike, 'POSIX symlink support unexpectedly unavailable')
  }

  // 10c. Symlink/hard-link output/backup paths must not redirect writes outside HOME.
  // Windows CI may lack privilege to create file symlinks; hard links still prove
  // that real writes replace the destination instead of writing through the link.
  function makeContainmentHome(name) {
    const home = join(temp, name)
    const config = join(home, '.config')
    const fixtures = join(home, 'fixtures')
    const binDir = join(home, '.local', 'bin')
    const unitDir = join(config, 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    mkdirSync(fixtures, { recursive: true })
    const dockIni = join(fixtures, 'user.ini')
    writeFileSync(dockIni, '[General]' + NL + 'Foo=bar' + NL + '[BasicWindow]' + NL + 'ExtraBrowserDocks=[]' + NL)
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, LYBLIVE_PORT: '8768' }
    return { home, config, fixtures, binDir, unitDir, dockIni, env }
  }
  const symHome = makeContainmentHome('symlink-home')
  const outsideBinarySentinel = join(temp, 'outside-binary.sentinel')
  const sentinelBytes = 'OUTSIDE_BINARY_SENTINEL'
  writeFileSync(outsideBinarySentinel, sentinelBytes)
  const symUnit = join(symHome.unitDir, 'lyblive.service')
  const symBinary = join(symHome.binDir, 'lyblive')
  const fixtureBinary = join(symHome.fixtures, 'lyblive-bin')
  writeFileSync(fixtureBinary, 'FIXTURE_BINARY')
  const symArgs = ['--apply', '--fixture', '--no-binary', '--configure-dock', '--dock-ini', symHome.dockIni]
  if (symlinksAvailable) {
    symlinkSync(outsideBinarySentinel, symUnit)
    const symUnitResult = runInstaller(symArgs, symHome.env)
    const symUnitOut = (symUnitResult.stdout || '') + (symUnitResult.stderr || '')
    must(symUnitResult.status === 2 && symUnitOut.includes('--fixture requires lyblive.service'), 'symlinked unit destination guard did not fire: rc=' + symUnitResult.status)
    must(readFileSync(outsideBinarySentinel, 'utf8') === sentinelBytes, 'symlinked unit destination wrote outside HOME')
    must(lstatSync(symUnit).isSymbolicLink(), 'symlinked unit destination was replaced before guard')
    rmSync(symUnit, { force: true })
    writeFileSync(symUnit, '[Unit]' + NL + 'stale=1' + NL)
    const symBackup = symUnit + '.dsh-portable-backup'
    symlinkSync(outsideBinarySentinel, symBackup)
    const symBackupResult = runInstaller(symArgs, symHome.env)
    const symBackupOut = (symBackupResult.stdout || '') + (symBackupResult.stderr || '')
    must(symBackupResult.status === 2 && symBackupOut.includes('--fixture requires lyblive.service backup'), 'symlinked backup guard did not fire: rc=' + symBackupResult.status)
    must(readFileSync(outsideBinarySentinel, 'utf8') === sentinelBytes, 'symlinked backup wrote outside HOME')
    must(lstatSync(symBackup).isSymbolicLink(), 'symlinked backup was replaced before guard')
    rmSync(symBackup, { force: true })
    symlinkSync(outsideBinarySentinel, symBinary)
    const symBinArgs = ['--apply', '--fixture', '--bin', fixtureBinary, '--configure-dock', '--dock-ini', symHome.dockIni]
    const symBinResult = runInstaller(symBinArgs, symHome.env)
    const symBinOut = (symBinResult.stdout || '') + (symBinResult.stderr || '')
    must(symBinResult.status === 2 && symBinOut.includes('--fixture requires binary'), 'symlinked binary destination guard did not fire: rc=' + symBinResult.status)
    must(readFileSync(outsideBinarySentinel, 'utf8') === sentinelBytes, 'symlinked binary destination wrote outside HOME')
    must(lstatSync(symBinary).isSymbolicLink(), 'symlinked binary destination was replaced before guard')
    // Real (non-fixture) writes replace a symlink atomically and avoid writing through a backup symlink.
    // A symlink-to-source binary must not satisfy the unchanged fast path: replacing it
    // has to produce a regular file rather than writing through the link.
    const sourceSentinel = join(temp, 'outside-source.sentinel')
    writeFileSync(sourceSentinel, 'OUTSIDE_SOURCE_SENTINEL')
    rmSync(fixtureBinary, { force: true })
    symlinkSync(sourceSentinel, fixtureBinary)
    rmSync(symBinary, { force: true })
    symlinkSync(fixtureBinary, symBinary)
    const relaxedResult = runInstaller(['--apply', '--no-systemctl', '--bin', fixtureBinary], symHome.env)
    must(relaxedResult.status === 0, 'relaxed symlink-write probe failed: ' + (relaxedResult.stderr || ''))
    must(readFileSync(sourceSentinel, 'utf8') === 'OUTSIDE_SOURCE_SENTINEL', 'relaxed unchanged fast path followed a binary symlink to its source')
    must(lstatSync(symBinary).isFile() && !lstatSync(symBinary).isSymbolicLink(), 'symlink-to-source binary was not atomically replaced')
    rmSync(fixtureBinary, { force: true })
    writeFileSync(fixtureBinary, 'FIXTURE_BINARY')

    rmSync(symBinary, { force: true })
    writeFileSync(symBinary, 'STALE_BINARY')
    const backupLink = symBinary + '.dsh-portable-backup'
    rmSync(backupLink, { force: true })
    symlinkSync(outsideBinarySentinel, backupLink)
    const realBinResult = runInstaller(['--apply', '--no-systemctl', '--bin', fixtureBinary], symHome.env)
    must(realBinResult.status === 0, 'real-mode binary replacement exited ' + realBinResult.status + ': ' + (realBinResult.stderr || ''))
    must(readFileSync(symBinary, 'utf8') === 'FIXTURE_BINARY', 'binary destination was not atomically replaced')
    must(lstatSync(symBinary).isFile() && !lstatSync(symBinary).isSymbolicLink(), 'binary destination is still a symlink')
    must(readFileSync(outsideBinarySentinel, 'utf8') === sentinelBytes, 'binary/backup symlink wrote outside HOME')
    const freshBackups = readdirSync(symHome.binDir).filter((n) => n.startsWith('lyblive.dsh-portable-backup.') && lstatSync(join(symHome.binDir, n)).isFile())
    must(freshBackups.length > 0, 'backup_copy did not create a fresh regular backup beside any write-through link')
  } else {
    must(windowsLike, 'POSIX symlink support unexpectedly unavailable')
    // Windows hard-link atomic replacement fallback: shutil.copy2(src, dest) would
    // write through the hard link and corrupt the outside sentinel.
    rmSync(symBinary, { force: true })
    const outsideBackupSentinel = join(temp, 'outside-backup.sentinel')
    const backupSentinelBytes = 'OUTSIDE_BACKUP_SENTINEL'
    writeFileSync(outsideBackupSentinel, backupSentinelBytes)
    const backupHardLink = symBinary + '.dsh-portable-backup'
    rmSync(backupHardLink, { force: true })
    linkSync(outsideBackupSentinel, backupHardLink)
    linkSync(outsideBinarySentinel, symBinary)
    const hardResult = runInstaller(['--apply', '--no-systemctl', '--bin', fixtureBinary], symHome.env)
    must(hardResult.status === 0, 'Windows hard-link atomic replacement fallback exited ' + hardResult.status + ': ' + (hardResult.stderr || ''))
    must(readFileSync(outsideBinarySentinel, 'utf8') === sentinelBytes, 'Windows hard-link fallback wrote through to outside sentinel')
    must(readFileSync(outsideBackupSentinel, 'utf8') === backupSentinelBytes, 'Windows hard-link backup fallback wrote through to outside sentinel')
    must(readFileSync(symBinary, 'utf8') === 'FIXTURE_BINARY', 'Windows hard-link fallback did not replace binary')
    must(lstatSync(symBinary).isFile() && !lstatSync(symBinary).isSymbolicLink(), 'Windows hard-link destination is still a symlink')
    const freshBackups = readdirSync(symHome.binDir).filter((n) => n.startsWith('lyblive.dsh-portable-backup.') && lstatSync(join(symHome.binDir, n)).isFile())
    const frozenOut = readdirSync(symHome.binDir).filter((n) => n.startsWith('lyblive.dsh-portable-backup') && lstatSync(join(symHome.binDir, n)).isFile())
    must(freshBackups.length > 0 && frozenOut.length > 0, 'backup_copy did not preserve a regular backup beside a hard link')
    console.log('deploy-install-smoke: Windows/hard-link fallback exercised')
  }

  // 10d. Non-UTF-8 text, a missing user.ini, and a dock symlink are handled safely.
  const encodingHome = join(temp, "encoding-home")
  const encodingConfig = join(encodingHome, ".config")
  const encodingFixtures = join(encodingHome, "fixtures")
  const encodingUnitDir = join(encodingConfig, "systemd", "user")
  mkdirSync(encodingUnitDir, { recursive: true })
  mkdirSync(encodingFixtures, { recursive: true })
  const encodingEnv = { ...process.env, HOME: encodingHome, XDG_CONFIG_HOME: encodingConfig, LYBLIVE_PORT: "8768" }
  const encodingDock = join(encodingFixtures, "user.ini")
  writeFileSync(encodingDock, "[BasicWindow]" + NL + "ExtraBrowserDocks=[]" + NL)
  const nonUtfUnit = join(encodingUnitDir, "lyblive.service")
  const invalidBytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00])
  writeFileSync(nonUtfUnit, invalidBytes)
  const nonUtfPlan = runInstaller(["--plan", "--fixture", "--no-binary", "--configure-dock", "--dock-ini", encodingDock], encodingEnv)
  const nonUtfPlanOut = (nonUtfPlan.stdout || "") + (nonUtfPlan.stderr || "")
  must(nonUtfPlan.status === 0 && !nonUtfPlanOut.includes("Traceback (most recent call last)"), "non-UTF-8 unit --plan exposed a Python traceback: rc=" + nonUtfPlan.status + " " + nonUtfPlanOut.trim())
  must(nonUtfPlan.stdout.includes("[write/update]"), "non-UTF-8 unit --plan did not report write/update")
  const nonUtfApply = runInstaller(["--apply", "--fixture", "--no-binary", "--configure-dock", "--dock-ini", encodingDock], encodingEnv)
  const nonUtfApplyOut = (nonUtfApply.stdout || "") + (nonUtfApply.stderr || "")
  must(nonUtfApply.status === 0 && !nonUtfApplyOut.includes("Traceback (most recent call last)"), "non-UTF-8 unit --apply exposed a Python traceback: rc=" + nonUtfApply.status + " " + nonUtfApplyOut.trim())
  must(readFileSync(nonUtfUnit, "utf8").includes("[Unit]"), "non-UTF-8 unit was not replaced")
  const nonUtfBackup = nonUtfUnit + ".dsh-portable-backup"
  must(existsSync(nonUtfBackup) && readFileSync(nonUtfBackup).equals(invalidBytes), "non-UTF-8 unit backup lost original bytes")

  const badBytesHome = join(temp, "bad-bytes-home")
  const badBytesConfig = join(badBytesHome, ".config")
  const badBytesFixtures = join(badBytesHome, "fixtures")
  const badBytesUnitDir = join(badBytesConfig, "systemd", "user")
  mkdirSync(badBytesUnitDir, { recursive: true })
  mkdirSync(badBytesFixtures, { recursive: true })
  const badBytesEnv = { ...process.env, HOME: badBytesHome, XDG_CONFIG_HOME: badBytesConfig, LYBLIVE_PORT: "8768" }
  const badBytesIni = join(badBytesFixtures, "user.ini")
  const badBytes = Buffer.concat([Buffer.from("[BasicWindow]" + NL), Buffer.from([0xff, 0xfe, 0xfd])])
  writeFileSync(badBytesIni, badBytes)
  const badBytesUnit = join(badBytesUnitDir, "lyblive.service")
  const badBytesLauncher = join(badBytesHome, ".local", "bin", "lyblive-obs")
  for (const mode of ["--plan", "--apply"]) {
    const badBytesResult = runInstaller([mode, "--fixture", "--no-binary", "--configure-dock", "--dock-ini", badBytesIni], badBytesEnv)
    const badBytesOut = (badBytesResult.stdout || "") + (badBytesResult.stderr || "")
    must(badBytesResult.status === 2 && badBytesOut.includes("cannot read ") && badBytesOut.includes("as UTF-8"), "readable non-UTF-8 error missing: rc=" + badBytesResult.status + " " + badBytesOut.trim())
    must(!badBytesOut.includes("Traceback (most recent call last)"), "non-UTF-8 dock " + mode + " exposed a Python traceback")
    must(readFileSync(badBytesIni).equals(badBytes), "non-UTF-8 user.ini was overwritten")
    must(!existsSync(badBytesUnit) && !existsSync(badBytesLauncher), "non-UTF-8 dock abort left partial writes")
  }

  const createHome = join(temp, "create-home")
  const createConfig = join(createHome, ".config")
  const createFixtures = join(createHome, "fixtures")
  mkdirSync(createFixtures, { recursive: true })
  const createEnv = { ...process.env, HOME: createHome, XDG_CONFIG_HOME: createConfig, LYBLIVE_PORT: "8768" }
  const missingIni = join(createFixtures, "missing-user.ini")
  const missingArgs = ["--fixture", "--no-binary", "--configure-dock", "--dock-ini", missingIni]
  const createPlan = runInstaller(["--plan", ...missingArgs], createEnv)
  const createPlanOut = (createPlan.stdout || "") + (createPlan.stderr || "")
  must(createPlan.status === 0 && !createPlanOut.includes("Traceback (most recent call last)"), "missing OBS dock --plan failed: rc=" + createPlan.status + " " + createPlanOut.trim())
  must(createPlan.stdout.includes("[create]"), "missing OBS dock [create] not reported")
  must(!existsSync(missingIni), "missing OBS dock [create] was not read-only")
  const createApply = runInstaller(["--apply", ...missingArgs], createEnv)
  const createApplyOut = (createApply.stdout || "") + (createApply.stderr || "")
  must(createApply.status === 0 && !createApplyOut.includes("Traceback (most recent call last)"), "missing OBS dock --apply failed: rc=" + createApply.status + " " + createApplyOut.trim())
  must(lstatSync(missingIni).isFile(), "missing OBS dock was not created")
  if (process.platform !== "win32") must((statSync(missingIni).mode & 0o777) === 0o644, "created OBS dock is not mode 0644")
  must(dockKeyLines(missingIni).length === 1 && dockValue(missingIni).some((d) => d.title === "lyblive" && d.url === "http://127.0.0.1:8768/"), "created OBS dock lacks canonical lyblive entry")
  const createAgain = runInstaller(["--plan", ...missingArgs], createEnv)
  must(createAgain.status === 0 && createAgain.stdout.includes("[already current]"), "created OBS dock is not idempotent: " + (createAgain.stderr || ""))

  if (symlinksAvailable && process.platform !== "win32") {
    const linkHome = join(temp, "dock-link-home")
    const linkConfig = join(linkHome, ".config")
    const linkFixtures = join(linkHome, "fixtures")
    const linkBinDir = join(linkHome, ".local", "bin")
    mkdirSync(linkFixtures, { recursive: true })
    mkdirSync(linkBinDir, { recursive: true })
    const dummyBinary = join(linkBinDir, "lyblive")
    writeFileSync(dummyBinary, "DUMMY_BINARY")
    chmodSync(dummyBinary, 0o755)
    const linkTarget = join(linkFixtures, "real-user.ini")
    const linkOriginal = "[General]" + NL + "Foo=bar" + NL + "[BasicWindow]" + NL + "ExtraBrowserDocks=[{\"title\":\"other\",\"url\":\"https://example.invalid/\",\"uuid\":\"keep\"}]" + NL
    writeFileSync(linkTarget, linkOriginal)
    const linkIni = join(linkFixtures, "user.ini")
    symlinkSync(linkTarget, linkIni)
    const linkEnv = obsSimEnv({ ...process.env, HOME: linkHome, XDG_CONFIG_HOME: linkConfig, LYBLIVE_PORT: "8768" }, "clear")
    const linkApply = runInstaller(["--apply", "--no-systemctl", "--no-binary", "--configure-dock", "--dock-ini", linkIni], linkEnv)
    const linkOut = (linkApply.stdout || "") + (linkApply.stderr || "")
    must(linkApply.status === 0 && !linkOut.includes("Traceback (most recent call last)"), "dock symlink write-through failed: rc=" + linkApply.status + " " + linkOut.trim())
    must(lstatSync(linkIni).isSymbolicLink() && readlinkSync(linkIni) === linkTarget, "dock symlink was replaced instead of writing through")
    must(readFileSync(linkTarget, "utf8").includes("lyblive"), "dock symlink target was not updated")
    must(readFileSync(linkIni, "utf8") === readFileSync(linkTarget, "utf8"), "dock symlink no longer resolves to its target")
    const linkDocks = dockValue(linkIni)
    must(linkDocks.some((d) => d.uuid === "keep") && linkDocks.some((d) => d.title === "lyblive"), "dock symlink write-through dropped an existing or lyblive dock")
    console.log("deploy-install-smoke: POSIX dock symlink write-through exercised")
  }

  // 10e. A real-mode missing dock must be refused while OBS is running.
  const runningHome = join(temp, "obs-running-home")
  const runningConfig = join(runningHome, ".config")
  const runningFixtures = join(runningHome, "fixtures")
  const runningBinDir = join(runningHome, ".local", "bin")
  const runningIni = join(runningFixtures, "missing-user.ini")
  const runningEnv = obsSimEnv({ ...process.env, HOME: runningHome, XDG_CONFIG_HOME: runningConfig, LYBLIVE_PORT: "8768" }, "running")
  mkdirSync(runningFixtures, { recursive: true })
  mkdirSync(runningBinDir, { recursive: true })
  const noBinaryApply = runInstaller(["--apply", "--no-systemctl", "--no-binary", "--configure-dock", "--dock-ini", runningIni], runningEnv)
  const noBinaryOut = (noBinaryApply.stdout || "") + (noBinaryApply.stderr || "")
  must(noBinaryApply.status === 2 && noBinaryOut.includes("--no-binary requires an existing") && !noBinaryOut.includes("Traceback (most recent call last)"), "readable --no-binary guard did not fire: rc=" + noBinaryApply.status + " " + noBinaryOut.trim())
  writeFileSync(join(runningBinDir, "lyblive"), "DUMMY_BINARY")
  const runningApply = runInstaller(["--apply", "--no-systemctl", "--no-binary", "--configure-dock", "--dock-ini", runningIni], runningEnv)
  const runningOut = (runningApply.stdout || "") + (runningApply.stderr || "")
  must(runningApply.status === 2 && runningOut.includes("OBS is running") && runningOut.includes("refusing to edit or create") && !runningOut.includes("Traceback (most recent call last)"), "missing OBS dock OBS-running guard did not fire: rc=" + runningApply.status + " " + runningOut.trim())
  must(!existsSync(runningIni), "OBS-running missing-dock guard created user.ini")
  // 10e-hung. A hung OBS process lister must be bounded and reported before any write.
  const hungHome = join(temp, "obs-hung-home")
  const hungConfig = join(hungHome, ".config")
  const hungFixtures = join(hungHome, "fixtures")
  const hungBinDir = join(hungHome, ".local", "bin")
  const hungIni = join(hungFixtures, "missing-user.ini")
  const hungEnv = obsSimEnv({ ...process.env, HOME: hungHome, XDG_CONFIG_HOME: hungConfig, LYBLIVE_PORT: "8768" }, "timeout")
  mkdirSync(hungFixtures, { recursive: true })
  mkdirSync(hungBinDir, { recursive: true })
  writeFileSync(join(hungBinDir, "lyblive"), "DUMMY_BINARY")
  for (const mode of ["--plan", "--apply"]) {
    const r = runInstaller([mode, "--no-systemctl", "--no-binary", "--configure-dock", "--dock-ini", hungIni], hungEnv)
    const out = (r.stdout || "") + (r.stderr || "")
    const expected = mode === "--plan" ? 0 : 2
    must(r.status === expected && out.includes("OBS detection timed out after ") && !out.includes("Traceback (most recent call last)"), "hung OBS detection guard did not fire (" + mode + "): rc=" + r.status + " " + out.trim())
    if (mode === "--plan") must(out.includes("OBS process check: OBS detection timed out after "), "hung OBS detection missing from plan")
  }
  must(!existsSync(hungIni), "hung OBS detection created user.ini")
  must(!existsSync(join(hungBinDir, "lyblive-obs")), "hung OBS detection left partial writes")
  console.log("deploy-install-smoke: bounded OBS detection exercised")
  // 10f. Unsafe destinations/sources are rejected before --plan claims a write.
  function preflightHome(name) {
    const home = join(temp, name)
    const config = join(home, ".config")
    const unitDir = join(config, "systemd", "user")
    const binDir = join(home, ".local", "bin")
    mkdirSync(unitDir, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, LYBLIVE_PORT: "8768" }
    return { home, unitDir, binDir, env }
  }
  function expectPreflight(args, env, expected, msg) {
    for (const mode of ["--plan", "--apply"]) {
      const r = runInstaller([mode, "--fixture", ...args], env)
      const out = (r.stdout || "") + (r.stderr || "")
      must(r.status === 2 && out.includes(expected) && !out.includes("Traceback (most recent call last)"), msg + " (" + mode + "): rc=" + r.status + " " + out.trim())
    }
  }
  const blockedHome = preflightHome("preflight-blocked-parent-home")
  const blockedConfig = join(blockedHome.home, ".config")
  rmSync(blockedConfig, { recursive: true, force: true })
  writeFileSync(blockedConfig, "BLOCKED_PARENT")
  expectPreflight(["--no-binary"], blockedHome.env, "parent path is blocked by a non-directory", "blocked parent destination preflight did not fire")
  must(readFileSync(blockedConfig, "utf8") === "BLOCKED_PARENT", "blocked parent destination was modified")
  must(!existsSync(join(blockedHome.binDir, "lyblive-obs")), "blocked parent destination preflight left partial writes")
  const dirHome = preflightHome("preflight-dir-home")
  const dirDest = join(dirHome.unitDir, "lyblive.service")
  mkdirSync(dirDest)
  const dirSentinel = join(dirDest, "sentinel.txt")
  writeFileSync(dirSentinel, "DO_NOT_TOUCH")
  expectPreflight(["--no-binary"], dirHome.env, "refusing to replace lyblive.service: destination is not a regular file", "directory destination preflight did not fire")
  must(readFileSync(dirSentinel, "utf8") === "DO_NOT_TOUCH", "directory destination was modified")
  must(!existsSync(join(dirHome.unitDir, "lyblive-obs.service")) && !existsSync(join(dirHome.binDir, "lyblive-obs")), "directory destination preflight left partial writes")
  if (process.platform !== "win32") {
    const unreadable = preflightHome("preflight-unreadable-home")
    const unreadableUnit = join(unreadable.unitDir, "lyblive.service")
    writeFileSync(unreadableUnit, "OLD_UNREADABLE_UNIT")
    chmodSync(unreadableUnit, 0)
    try {
      expectPreflight(["--no-binary"], unreadable.env, "cannot read existing lyblive.service", "unreadable destination preflight did not fire")
    } finally {
      chmodSync(unreadableUnit, 0o644)
    }
    must(readFileSync(unreadableUnit, "utf8") === "OLD_UNREADABLE_UNIT", "unreadable destination was modified")
    must(!existsSync(join(unreadable.unitDir, "lyblive-obs.service")), "unreadable destination preflight left partial writes")
    const locked = preflightHome("preflight-locked-parent-home")
    chmodSync(locked.unitDir, 0o555)
    try {
      expectPreflight(["--no-binary"], locked.env, "parent directory is not writable", "non-writable parent preflight did not fire")
      must(!existsSync(join(locked.unitDir, "lyblive.service")), "non-writable parent allowed a write")
    } finally {
      chmodSync(locked.unitDir, 0o755)
    }
    const sourceHome = preflightHome("preflight-source-home")
    const unreadableSource = join(temp, "preflight-unreadable-binary")
    writeFileSync(unreadableSource, "UNREADABLE_BINARY")
    chmodSync(unreadableSource, 0)
    try {
      expectPreflight(["--bin", unreadableSource], sourceHome.env, "cannot read installer source binary", "unreadable binary source preflight did not fire")
      must(!existsSync(join(sourceHome.unitDir, "lyblive.service")), "unreadable binary source was installed")
    } finally {
      chmodSync(unreadableSource, 0o644)
    }
    if (symlinksAvailable) {
      const linkHome = preflightHome("preflight-broken-link-home")
      const brokenLink = join(linkHome.unitDir, "lyblive.service")
      symlinkSync(join(temp, "preflight-missing-symlink-target"), brokenLink)
      const dummy = join(linkHome.binDir, "lyblive")
      writeFileSync(dummy, "DUMMY_BINARY")
      chmodSync(dummy, 0o755)
      // --fixture rejects all destination symlinks by design; real mode exercises
      // the later preflight check for a broken destination link without writing.
      for (const mode of ["--plan", "--apply"]) {
        const linkResult = runInstaller([mode, "--no-systemctl", "--no-binary"], linkHome.env)
        const linkOut = (linkResult.stdout || "") + (linkResult.stderr || "")
        must(linkResult.status === 2 && linkOut.includes("destination is not a regular file") && !linkOut.includes("Traceback (most recent call last)"), "broken destination symlink preflight did not fire (" + mode + "): rc=" + linkResult.status + " " + linkOut.trim())
      }
      must(lstatSync(brokenLink).isSymbolicLink(), "broken destination symlink was overwritten")
      must(!existsSync(join(linkHome.unitDir, "lyblive-obs.service")), "broken destination symlink preflight left partial writes")
    }
  }

  // 10g. systemd --user activation is preflighted. A blind --apply used to write the
  // units first and only then die in systemctl/systemd-analyze, leaving a half-configured
  // deployment. Two failure shapes are checked:
  //   (a) deterministic: shutil.which cannot find the tools (sitecustomize hides them);
  //   (b) best-effort: the tools exist but no user manager is reachable from this shell.
  const sysHome = join(temp, "systemd-preflight-home")
  const sysConfig = join(sysHome, ".config")
  const sysUnitDir = join(sysConfig, "systemd", "user")
  const sysBinDir = join(sysHome, ".local", "bin")
  mkdirSync(sysUnitDir, { recursive: true })
  mkdirSync(sysBinDir, { recursive: true })
  writeFileSync(join(sysBinDir, "lyblive"), "DUMMY_BINARY")
  const sysEnv = { ...process.env, HOME: sysHome, XDG_CONFIG_HOME: sysConfig, LYBLIVE_PORT: "8768" }
  delete sysEnv.XDG_RUNTIME_DIR
  delete sysEnv.DBUS_SESSION_BUS_ADDRESS
  delete sysEnv.SYSTEMD_EXEC_PID
  // Hide the systemd tools from shutil.which without changing PATH, so this fixture
  // is deterministic and works on Windows CI without symlink privilege.
  const hideDir = join(temp, "systemd-preflight-hide-tools")
  mkdirSync(hideDir, { recursive: true })
  writeFileSync(join(hideDir, "sitecustomize.py"), [
    "import shutil",
    "_real_which = shutil.which",
    "def _hidden_which(cmd, *args, **kwargs):",
    "    if cmd in ('systemctl', 'systemd-analyze'):",
    "        return None",
    "    return _real_which(cmd, *args, **kwargs)",
    "shutil.which = _hidden_which",
    ""
  ].join(NL))
  const noToolsEnv = { ...sysEnv, PYTHONPATH: hideDir }
  function expectUnreachable(env, label) {
    const plan = runInstaller(["--plan", "--no-binary"], env)
    const planOut = (plan.stdout || "") + (plan.stderr || "")
    must(plan.status === 0, label + " systemd --plan exited " + plan.status + ": " + planOut.trim())
    must(planOut.includes("systemd --user: UNREACHABLE"), label + " systemd --plan did not report UNREACHABLE")
    must(!existsSync(join(sysUnitDir, "lyblive.service")), label + " systemd --plan wrote units")
    const apply = runInstaller(["--apply", "--no-binary"], env)
    const applyOut = (apply.stdout || "") + (apply.stderr || "")
    must(apply.status === 2 && applyOut.includes("systemd --user is not reachable from this shell") && !applyOut.includes("Traceback (most recent call last)"), label + " systemd --apply guard did not fire: rc=" + apply.status + " " + applyOut.trim())
    if (label === "hung systemd user manager") must(applyOut.includes("systemctl --user show-environment timed out after "), "systemd --user show-environment timed out after guard did not report the timeout")
    must(!existsSync(join(sysUnitDir, "lyblive.service")) && !existsSync(join(sysBinDir, "lyblive-obs")) && !existsSync(join(sysUnitDir, "lyblive-obs.service")), label + " systemd --apply left partial writes")
  }
  // A hung user manager must turn into a readable UNREACHABLE reason, not an
  // unbounded --plan/--apply. sitecustomize substitutes a patched subprocess.run
  // that raises TimeoutExpired only for the show-environment probe.
  const timeoutDir = join(temp, "systemd-preflight-timeout")
  mkdirSync(timeoutDir, { recursive: true })
  writeFileSync(join(timeoutDir, "sitecustomize.py"), [
    "import subprocess",
    "from pathlib import Path",
    "_real_run = subprocess.run",
    "def _timed_out_run(args, *rest, **kwargs):",
    "    if isinstance(args, list) and args[:3] == ['systemctl', '--user', 'show-environment']:",
    "        raise subprocess.TimeoutExpired(cmd=args, timeout=float(kwargs.get('timeout', 15)))",
    "    return _real_run(args, *rest, **kwargs)",
    "subprocess.run = _timed_out_run",
    ""
  ].join(NL))
  const timeoutEnv = { ...sysEnv, PYTHONPATH: timeoutDir }
  // 只有 Linux 才有 systemctl；其他平台的 preflight 在 which 阶段就判定 UNREACHABLE，
  // 不会执行 show-environment 探针，超时注入无从触发。
  if (process.platform === "linux") expectUnreachable(timeoutEnv, "hung systemd user manager")
  expectUnreachable(noToolsEnv, "missing systemd tools")
  const probeEnv = { ...sysEnv }
  const reachable = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", env: probeEnv })
  const sessionReachable = !reachable.error && reachable.status === 0
  if (!sessionReachable) expectUnreachable(probeEnv, "unreachable user manager")
  const sysSkip = runInstaller(["--apply", "--no-systemctl", "--no-binary"], noToolsEnv)
  const sysSkipOut = (sysSkip.stdout || "") + (sysSkip.stderr || "")
  must(sysSkip.status === 0, "--no-systemctl --apply exited " + sysSkip.status + ": " + sysSkipOut.trim())
  must(sysSkipOut.includes("systemd --user: skipped (--no-systemctl)"), "--no-systemctl plan line missing")
  must(existsSync(join(sysUnitDir, "lyblive.service")) && existsSync(join(sysUnitDir, "lyblive-obs.service")) && existsSync(join(sysBinDir, "lyblive-obs")), "--no-systemctl --apply did not install the units")

  // 11. --fixture must refuse the real account home (unset HOME so installer falls back).
  const realEnv = { ...process.env, LYBLIVE_PORT: '8768' }
  delete realEnv.HOME
  delete realEnv.XDG_CONFIG_HOME
  const realHome = runInstaller(['--fixture', '--plan'], realEnv)
  const realOut = (realHome.stdout || '') + (realHome.stderr || '')
  must(realHome.status === 2 && realOut.includes('refuses the real user home'), '--fixture real-home guard did not fire: rc=' + realHome.status + ' ' + realOut.trim())

  console.log('deploy-install-smoke: read-only plan; portable units/launcher; Qt-equivalent repeated/trailing-comment/case-variant INI merge; dock preservation; missing-section/no-EOL/CRLF/BOM+inline-comment repair; indented-header section boundaries; quoted-semicolon dock values; bad JSON rejection; fixture HOME containment (outside paths, symlink escapes, binary/backup symlinks); owner executable-bit repair; extra/special permission-bit repair; --plan dock errors; atomic bad-JSON rejection; non-UTF-8 safe repair; missing OBS dock creation; readable --no-binary guard; OBS-running missing-dock guard; bounded OBS detection; dock symlink write-through guards (POSIX); frozen-clock unique backups; non-regular/unreadable/blocked-parent destination preflight; unreachable-systemd preflight with bounded timeouts; idempotency; port override; 5 input guards (including relative HOME/XDG_CONFIG_HOME, no traceback), 4 corrupt-bundle guards, tilde HOME/CLI path expansion + real-home guard OK')
} finally {
  rmSync(temp, { recursive: true, force: true })
}

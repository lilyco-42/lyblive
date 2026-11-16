#!/usr/bin/env node
// CI workflow + built Web asset contract regression; pure Node stdlib, no network or credentials.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NL = String.fromCharCode(10)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
// Source tree: scripts/ci-contract.mjs -> root is '..'; flat artifact archive: root is scriptDir.
// --all-artifacts must be self-contained: never borrow ci.yml/assets/bin from a parent directory.
const roots = args.includes('--all-artifacts') ? [scriptDir] : [resolve(scriptDir, '..'), scriptDir]
function must(cond, msg) { if (!cond) throw new Error('ci-contract: ' + msg) }
function findOne(rels) {
  for (const base of roots) {
    for (const rel of rels) {
      const p = join(base, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}
function countIn(text, needle) { return text.split(NL).filter((l) => l.includes(needle)).length }
function pythonSetupSteps(text) {
  const lines = text.split(NL)
  const found = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '- uses: actions/setup-python@v5') continue
    let version = null
    let versionLine = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s+\S/.test(lines[j])) break
      const s = lines[j].trim()
      if (s.startsWith('python-version:') && !s.startsWith('#')) {
        version = s.slice('python-version:'.length).trim()
        versionLine = j
        break
      }
    }
    found.push({ line: i, version, versionLine })
  }
  return found
}
function pinnedPython(version) { return version === "'3.12'" || version === "\"3.12\"" }
function namedStep(text, name) {
  const lines = text.split(NL)
  const n = lines.findIndex((l) => l.trim() === '- name: ' + name)
  if (n < 0) return null
  let end = n + 1
  while (end < lines.length && !/^\s*-\s+(name|uses):/.test(lines[end])) end++
  const step = lines.slice(n, end).map((l) => l.trim())
  return {
    index: n,
    runs: step.filter((l) => l.startsWith('run:')),
    hasEnv: step.includes('env:'),
    envValue: step.find((l) => l.startsWith('LYBLIVE_SMOKE_FORCE_NO_SYMLINK:')) || null
  }
}
function resolvePath(p) {
  const list = [p, resolve(p)]
  for (const r of roots) list.push(join(r, p))
  return list.find((x) => existsSync(x)) || null
}
function bytesInclude(haystack, needle) { return haystack.includes(needle) }

const requireAssets = args.includes('--assets')
const embeddedIdx = args.indexOf('--embedded')
const requireEmbedded = embeddedIdx >= 0
const allArtifacts = args.includes('--all-artifacts')
const requireDeploy = args.includes('--deploy')
const embeddedArgs = requireEmbedded ? args.slice(embeddedIdx + 1).filter((a) => !a.startsWith('--')) : []

const ciPath = findOne(['.github/workflows/ci.yml', 'ci.yml'])
must(ciPath, 'ci.yml not found in source tree or artifact archive')
const ci = readFileSync(ciPath, 'utf8').replaceAll(String.fromCharCode(13), '')
const L = ci.split(NL)
must(L.some((l) => l.trim() === 'on: [push, pull_request, workflow_dispatch]'), 'workflow triggers drift')
must(ci.includes('permissions:') && ci.includes('contents: read'), 'least-privilege permissions drift')
must(L.filter((l) => l.includes('uses: actions/setup-node@v4')).length >= 2, 'both jobs need Node 22')
must(L.filter((l) => l.includes("node-version: '22'")).length >= 2, 'Node 22 drift')
must(L.filter((l) => l.includes('run: pnpm install --frozen-lockfile')).length >= 2, 'frozen lockfile installs drift')
must(L.filter((l) => l.includes('run: pnpm build')).length >= 2, 'both jobs must build real Web assets')
const contractLines = L.filter((l) => l.includes('node scripts/ci-contract.mjs'))
const expectedContracts = allArtifacts ? 6 : 8
must(contractLines.length >= expectedContracts, 'CI workflow contract steps drift (expected ' + expectedContracts + ': contract/deploy/assets/embedded x 2 jobs)')
must(countIn(ci, 'run: node scripts/ci-contract.mjs --assets') >= 2, 'both jobs must run built Web asset guard')
must(countIn(ci, 'run: node scripts/ci-contract.mjs --embedded') >= 2, 'both jobs must run embedded Web asset parity')
if (!allArtifacts) {
  must(countIn(ci, 'run: node scripts/ci-contract.mjs --deploy') >= 2, 'both jobs must run portable deployment guard')
  const smokeRuns = ci.split(NL).filter((l) => l.trim() === 'run: node scripts/deploy-install-smoke.mjs').length
  must(smokeRuns >= 2, 'both jobs must run portable installer offline smoke test')
  must(countIn(ci, "LYBLIVE_SMOKE_FORCE_NO_SYMLINK: '1'") >= 2, 'both jobs must exercise the Windows-like hard-link fallback')
  must(countIn(ci, 'run: node scripts/deploy-install-smoke.mjs') >= 4, 'both jobs must run normal + Windows-like installer smoke tests')
  const pySetups = pythonSetupSteps(ci)
  must(pySetups.length >= 2, 'both jobs must pin Python for the offline installer smoke')
  must(pySetups.every((s) => s.versionLine > s.line && pinnedPython(s.version)), 'pinned Python 3.12 drift')
}

const uploadSteps = L.filter((l) => l.includes('uses: actions/upload-artifact@v4'))
must(uploadSteps.length === 3, 'expected 3 upload steps, got ' + uploadSteps.length)
const policies = L.filter((l) => l.includes('if-no-files-found:'))
must(policies.length === 3, 'expected 3 upload policies, got ' + policies.length)
must(policies.every((l) => l.trim() === 'if-no-files-found: error'), 'every upload must fail when no files found')
must(!ci.includes('if-no-files-found: ignore') && !ci.includes('if-no-files-found: warn'), 'silent empty uploads are forbidden')

const dStart = L.findIndex((l) => l.trim() === 'desktop:')
const aStart = L.findIndex((l) => l.trim() === 'android-headless:')
must(dStart >= 0 && aStart > dStart, 'desktop/android job boundaries drift')
const desktop = L.slice(dStart, aStart).join(NL)
const android = L.slice(aStart).join(NL)
if (!allArtifacts) {
  for (const [label, text] of [['desktop', desktop], ['android', android]]) {
    must(text.includes('run: node scripts/ci-contract.mjs --deploy'), label + ' portable deployment guard drift')
    const jobLines = text.split(NL)
    const pySmoke = jobLines.findIndex((l) => l.trim() === 'run: node scripts/deploy-install-smoke.mjs')
    must(pySmoke >= 0, label + ' portable installer smoke drift')
    must(countIn(text, "LYBLIVE_SMOKE_FORCE_NO_SYMLINK: '1'") >= 1, label + ' Windows-like hard-link fallback drift')
    must(countIn(text, 'run: node scripts/deploy-install-smoke.mjs') >= 2, label + ' normal + Windows-like installer smoke drift')
    const normalStep = namedStep(text, 'Portable single-OBS installer offline smoke test')
    const fallbackStep = namedStep(text, 'Windows-like hard-link installer smoke (all runners)')
    const smokeRun = 'run: node scripts/deploy-install-smoke.mjs'
    must(normalStep && normalStep.runs.length === 1 && normalStep.runs[0] === smokeRun && !normalStep.hasEnv, label + ' normal installer smoke step shape drift')
    must(fallbackStep && fallbackStep.runs.length === 1 && fallbackStep.runs[0] === smokeRun && fallbackStep.hasEnv && fallbackStep.envValue === "LYBLIVE_SMOKE_FORCE_NO_SYMLINK: '1'", label + ' Windows-like installer smoke step shape drift')
    must(normalStep.index < fallbackStep.index, label + ' normal smoke must precede forced fallback')
    const steps = pythonSetupSteps(text)
    must(steps.length >= 1, label + ' Python setup drift')
    const step = steps[0]
    must(step.versionLine > step.line && pinnedPython(step.version), label + ' pinned Python 3.12 drift')
    const pySetup = jobLines.findIndex((l) => l.trim() === '- uses: actions/setup-python@v5')
    must(pySetup >= 0 && pySmoke > pySetup && step.versionLine < pySmoke, label + ' Python setup must precede installer smoke')
  }
}
must(desktop.includes('os: [ubuntu-latest, macos-latest, windows-latest]'), 'desktop matrix must cover Linux/macOS/Windows')
must(desktop.includes('run: pnpm lint'), 'desktop Web lint drift')
must(desktop.includes('run: pnpm build'), 'desktop must build real Web assets')
must(desktop.includes('run: cargo fmt -- --check'), 'Rust fmt drift')
must(desktop.includes('run: cargo clippy --all-targets -- -D warnings'), 'Rust clippy drift')
must(desktop.includes('run: cargo test'), 'Rust tests drift')
must(desktop.includes('run: cargo build --release'), 'desktop release build drift')
for (const s of ['node scripts/smoke.mjs', 'node scripts/mcp-smoke.mjs', 'node scripts/web-smoke.mjs', 'node scripts/browser-smoke.mjs']) {
  must(desktop.includes('run: ' + s), 'desktop smoke drift: ' + s)
}
must(desktop.includes('uses: browser-actions/setup-chrome@v2'), 'desktop browser setup action drift')
must(desktop.includes('id: setup-chrome'), 'desktop browser setup step id drift')
must(desktop.includes('chrome-version: stable'), 'desktop stable Chrome channel drift')
must(desktop.includes('install-dependencies: true'), 'desktop Chrome runtime dependencies drift')
must(desktop.includes('LYBLIVE_BROWSER_BIN: ${{ steps.setup-chrome.outputs.chrome-path }}'), 'desktop browser-smoke executable wiring drift')
const dLines = desktop.split(NL)
const dBrowserSetup = dLines.findIndex((l) => l.includes('uses: browser-actions/setup-chrome@v2'))
const dBrowserRun = dLines.findIndex((l) => l.includes('run: node scripts/browser-smoke.mjs'))
must(dBrowserSetup >= 0 && dBrowserRun > dBrowserSetup, 'Chrome setup must precede browser smoke')
const dWeb = dLines.findIndex((l) => l.includes('run: pnpm build'))
const dAssets = dLines.findIndex((l) => l.includes('run: node scripts/ci-contract.mjs --assets'))
const dCargo = dLines.findIndex((l) => l.includes('run: cargo build --release'))
const dEmbedded = dLines.findIndex((l) => l.includes('run: node scripts/ci-contract.mjs --embedded'))
must(dWeb >= 0 && dCargo > dWeb, 'desktop Web build must precede cargo release so include_dir embeds real assets')
must(dAssets >= 0 && dCargo > dAssets && dEmbedded > dCargo, 'desktop asset guard/order drift: --assets -> cargo release -> --embedded')
must(desktop.includes('name: lyblive-'), 'desktop artifact name drift')
must(desktop.includes('target/release/lyblive') && desktop.includes('target/release/lyblive.exe'), 'desktop upload must accept ELF/Mach-O and PE')
must(countIn(desktop, 'if-no-files-found: error') === 1, 'desktop upload must fail on empty result')

must(android.includes('targets: aarch64-linux-android, x86_64-linux-android'), 'Android dual-ABI targets drift')
must(android.includes("packages: 'ndk;27.3.13750724'"), 'NDK 27.3.13750724 must align with local r27d')
must(android.includes('NDK_BIN="$ANDROID_HOME/ndk/27.3.13750724/toolchains/llvm/prebuilt/linux-x86_64/bin"'), 'NDK_BIN drift')
must(android.includes('shell: bash'), 'Android build needs explicit bash')
for (const key of ['CC_aarch64_linux_android', 'AR_aarch64_linux_android', 'CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER', 'CC_x86_64_linux_android', 'AR_x86_64_linux_android', 'CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER']) {
  must(android.includes(key), 'missing Android toolchain env ' + key)
}
const aLines = android.split(NL)
const aWeb = aLines.findIndex((l) => l.includes('run: pnpm build'))
const aAssets = aLines.findIndex((l) => l.includes('run: node scripts/ci-contract.mjs --assets'))
const aArm = aLines.findIndex((l) => l.includes('cargo build --release --no-default-features --features headless --target aarch64-linux-android'))
const aX86 = aLines.findIndex((l) => l.includes('cargo build --release --no-default-features --features headless --target x86_64-linux-android'))
const aEmbedded = aLines.findIndex((l) => l.includes('run: node scripts/ci-contract.mjs --embedded target/aarch64-linux-android/release/lyblive target/x86_64-linux-android/release/lyblive'))
must(aWeb >= 0 && aArm > aWeb && aX86 > aWeb, 'Android dual-ABI builds must come after real Web build')
must(aAssets >= 0 && aArm > aAssets && aX86 > aAssets && aEmbedded > aX86, 'Android asset guard/order drift: --assets -> dual builds -> --embedded')
must(android.includes('run: node scripts/ci-contract.mjs --embedded target/aarch64-linux-android/release/lyblive target/x86_64-linux-android/release/lyblive'), 'Android embedded parity must cover both ABIs')
must(android.includes('path: target/aarch64-linux-android/release/lyblive'), 'Android arm64 upload path drift')
must(android.includes('path: target/x86_64-linux-android/release/lyblive'), 'Android x86_64 upload path drift')
must(countIn(android, 'if-no-files-found: error') === 2, 'both Android uploads must fail on empty result')

const strictSourcePath = findOne(['src/api.rs', 'api.rs'])
must(strictSourcePath, 'strict Host/Origin Rust source missing')
const strictSource = readFileSync(strictSourcePath, 'utf8')
must(strictSource.includes('fn is_loopback_ipv4('), 'strict numeric IPv4 loopback parser drift')
must(strictSource.includes('port.parse::<u16>().is_err()'), 'strict Host port parser drift')
must(!strictSource.includes('starts_with("127.")'), 'DNS suffix 127.* bypass reintroduced')
must(strictSource.includes('loopback_host_accepts_strict_ports_and_ipv6_brackets'), 'strict Host/Origin Rust test drift')
must(strictSource.includes('let forbidden =') && strictSource.includes("'@'"), 'Origin authority forbidden characters drift')
if (!allArtifacts) {
  const biliClientPath = findOne(['src/bili/client.rs', 'api.rs'])
  must(biliClientPath && /bili[\\/]client\.rs$|client\.rs$/.test(biliClientPath), 'B 站 client source missing')
  const biliClientSource = readFileSync(biliClientPath, 'utf8')
  must(biliClientSource.includes('if code == 60043'), 'code 60043 branch missing')
  const biliBranchAt = biliClientSource.indexOf('if code == 60043')
  const biliReturnAt = biliClientSource.indexOf('Err(anyhow!("{text}")')
  must(biliReturnAt > biliBranchAt, '60043 guidance must be appended before returning the error')
  const biliGuidanceSection = biliClientSource.slice(biliBranchAt, biliReturnAt)
  for (const marker of [
    'text.push_str(concat!(',
    'B 站要求开播前完成验证',
    '不要反复点击',
    '不会索取或保存账号凭据',
    'parse_notice(',
  ]) {
    must(biliGuidanceSection.includes(marker), 'code 60043 guidance drift: ' + marker)
  }
  for (const marker of [
    'code_60043_message_guides_to_official_verification',
    'unrelated_api_codes_do_not_claim_face_verification',
    '!e.contains("人脸认证")',
  ]) {
    must(biliClientSource.includes(marker), 'code 60043 face-verification test drift: ' + marker)
  }
  for (const marker of [
    'pub struct FaceAuthRequired',
    'pub fn parse_notice',
    'pub fn extract_qr_payload',
    'pub fn qr_svg',
  ]) {
    must(biliClientSource.includes(marker), 'structured verification entry drift: ' + marker)
  }
}
const webSmokePath = findOne(['scripts/web-smoke.mjs', 'web-smoke.mjs'])
must(webSmokePath, 'strict Host/Origin web smoke missing')
const webSmokeSource = readFileSync(webSmokePath, 'utf8')
for (const marker of ['127.evil.example', '127.0.0.1.evil.example', 'http://user@127.0.0.1', 'Host-suffix-403', 'Origin-suffix-403', 'Bad-port-403']) {
  must(webSmokeSource.includes(marker), 'strict Host/Origin web-smoke drift: ' + marker)
}
const browserSmokePath = findOne(['scripts/browser-smoke.mjs', 'browser-smoke.mjs'])
must(browserSmokePath, 'browser smoke missing')
const browserSmokeSource = readFileSync(browserSmokePath, 'utf8')
must(browserSmokeSource.includes('spawnSync("taskkill", ["/PID"'), 'browser-smoke Windows tree-kill drift')
must(browserSmokeSource.includes('detached: process.platform !== "win32"'), 'browser-smoke Chrome process-group drift')
must(browserSmokeSource.includes('await killProcess(chrome, true)'), 'browser-smoke Chrome group cleanup drift')
must(browserSmokeSource.includes('enableWithRetry'), 'browser-smoke CDP renderer startup retry drift')
must(desktop.includes('- name: Real-browser React/shadcn render smoke test\n        if: runner.os != \'macOS\'\n        run: node scripts/browser-smoke.mjs'), 'browser smoke macOS exemption drift')
if (requireDeploy && !allArtifacts) {
  const deployDir = findOne(['deploy'])
  must(deployDir, 'portable deploy directory missing from source tree')
  for (const name of ['lyblive.service', 'lyblive-obs.service', 'lyblive-obs', 'install.py', 'README.md']) {
    must(existsSync(join(deployDir, name)), 'portable deployment file missing: ' + name)
  }
  const webUnit = readFileSync(join(deployDir, 'lyblive.service'), 'utf8')
  const obsUnit = readFileSync(join(deployDir, 'lyblive-obs.service'), 'utf8')
  const launcher = readFileSync(join(deployDir, 'lyblive-obs'), 'utf8')
  const forbidden = ['/home/lilyco', '/run/user/', 'DISPLAY=:', 'XAUTHORITY=', 'PassEnvironment=']
  for (const [label, text] of [['lyblive.service', webUnit], ['lyblive-obs.service', obsUnit], ['lyblive-obs', launcher]]) {
    for (const needle of forbidden) must(!text.includes(needle), label + ' hardcodes ' + needle)
  }
  must(webUnit.includes('Environment=HOME=%h') && webUnit.includes('ExecStart=%h/.local/bin/lyblive --web --no-browser') && webUnit.includes('WantedBy=default.target'), 'portable Web unit drift')
  must(obsUnit.includes('ExecStart=%h/.local/bin/lyblive-obs') && obsUnit.includes('PartOf=graphical-session.target') && obsUnit.includes('After=graphical-session.target') && obsUnit.includes('WantedBy=graphical-session.target'), 'portable OBS unit drift')
  must(launcher.includes('-u WAYLAND_DISPLAY') && launcher.includes('-u SESSION_MANAGER') && launcher.includes('-u DESKTOP_STARTUP_ID') && launcher.includes('-u XDG_ACTIVATION_TOKEN') && launcher.includes('QT_QPA_PLATFORM=xcb') && launcher.includes('XDG_SESSION_TYPE=x11'), 'portable OBS launcher drift')
  const installer = readFileSync(join(deployDir, 'install.py'), 'utf8')
  const subprocessLines = installer.split(/\r?\n/).filter((line) => line.includes('subprocess.run('))
  must(subprocessLines.length >= 5 && subprocessLines.every((line) => line.includes('timeout=')), 'portable installer must bound every subprocess.run call')
  must(countIn(installer, 'timeout=OBS_DETECT_TIMEOUT') >= 1, 'portable installer must bound OBS detection explicitly')
  for (const marker of ['def workdir_spec', 'def assert_portable', 'def section_name', 'def is_dock_key', 'def render_dock', 'def obs_detection_probe', '--fixture refuses the real user home', '--plan and --apply are mutually exclusive',
    'HOME_ABSOLUTE = HOME.is_absolute()', 'XDG_CONFIG_HOME_ABSOLUTE = XDG_CONFIG_HOME.is_absolute()', 'if not HOME_ABSOLUTE:', 'if not XDG_CONFIG_HOME_ABSOLUTE:', 'HOME must be an absolute path', 'XDG_CONFIG_HOME must be an absolute path', 'def configured_path(', 'raw == "~"', 'home / raw[2:]', 'def user_path(', 'Expand CLI tilde paths from the real account home', 'user_path(args.dock_ini)', 'user_path(args.bin)',
    'OBS_DETECT_TIMEOUT = 5', 'def obs_detection_problem', 'timeout=OBS_DETECT_TIMEOUT', 'OBS detection timed out after ', 'obs_problem = None', 'OBS process check: ', 'if args.configure_dock and not args.fixture:',
    'def read_raw', 'newline=""', 'stripped.find("]")', '.casefold() == "extrabrowserdocks"', 'text.lstrip("\\ufeff")', 'bom = "\\ufeff" if text.startswith("\\ufeff") else ""', 'return bom + "".join(lines)', 'def qt_value', 'in_quotes = not in_quotes', 'elif ch == ";" and not in_quotes:', 'raw = qt_value(lines[i].lstrip().split("=", 1)[1]).strip()', 'A UTF-8 BOM is stripped before parsing and restored', 'stripped = text.lstrip("\\ufeff").lstrip()', 'Qt readIniLine accepts leading whitespace before the bracket',
    "def read_raw_or_none", "def dock_write_path", "DOCK_WRITE = dock_write_path()", "DOCK_INI.resolve()", "cannot resolve OBS dock symlink", "if not DOCK_WRITE.is_file():", "return render_dock(\"\")",
    'basic_lines = [i for i, line in enumerate(lines) if section_name(line) == "BasicWindow"]',
    'lines.append("[BasicWindow]" + eol)', 'read_raw(DOCK_INI)', 'render_dock(read_raw(DOCK_INI))',
    'def within', 'path.resolve().relative_to(root.resolve())', 'except (OSError, ValueError, RuntimeError):',
    'if within(REAL_HOME, HOME):', 'WRITE_FILES = (', '("lyblive.service", UNIT_DIR / UNITS[0])', '("lyblive-obs.service", UNIT_DIR / UNITS[1])', '("lyblive-obs", BIN_DIR / "lyblive-obs")', '("binary", BIN_DIR / "lyblive")', '("XDG_CONFIG_HOME", XDG_CONFIG_HOME)', '("UNIT_DIR", UNIT_DIR)',
    '("BIN_DIR", BIN_DIR)', '("--dock-ini", DOCK_INI)', 'candidate.is_symlink()',
    'not within(candidate, HOME) or within(candidate, REAL_HOME)', 'to stay inside the temporary HOME and outside the real home',
    'backup.is_symlink()', 'def backup_copy', 'def atomic_copy', 'if dest.exists():\n            backup_copy(dest)', 'never shutil.copy2(src, dest)', 'os.replace(tmp, dest)',
    'prefix = dest.name + ".dsh-portable-backup"', 'os.link(tmp, preferred)', 'mkstemp is collision-free even for a frozen clock or repeated writes', 'Path(tmp)',
    'dest.is_file() and not dest.is_symlink()', 'atomic_copy(src, dest, 0o755)',
    "def owner_mode_ok",
    "return current == (mode & 0o777)",
    "def regular_owner_mode_ok",
    "def repair_owner_mode",
    "os.chmod(path, mode & 0o777)",
    "refusing to chmod a symlink",
    "def dock_target_text",
    "parser.error(str(exc))",
    "read_raw_or_none(dest)", "current = read_raw_or_none(dest)", "dock_state = \"already current\" if dock_current else (\"create\" if not DOCK_WRITE.is_file() else \"write/update\")", "atomic_write(DOCK_WRITE, dock_text, old_mode)", "parser.error(\"--no-binary requires an existing \"", "parser.error(obs_problem + \": refusing to edit or create \"",
    "def binary_mode_result",
    "def plan_text_state",
    "# Validate the dock before any apply writes",
    "dock_text = dock_target_text() if",
    'state = plan_text_state(dest, text, mode)',
    'binary_state = "keep existing / mode repair"',
    "mode repaired",
    "binary mode repaired",
    "def check_readable_source",
    "def check_write_target",
    "def preflight_write_targets",
    "preflight_write_targets()",
    "check_readable_source(\"binary\", BIN_SRC)",
    "cannot read installer source ",
    "refusing to replace ",
    "destination is not a regular file",
    "parent path is blocked by a non-directory",
    "cannot read existing ",
    "cannot write ",
    "def systemctl_preflight",
    "systemd --user: UNREACHABLE",
    "systemd --user is not reachable from this shell",
    "Re-run with --no-systemctl",
    "files are installed but systemd --user activation failed", "[\"systemctl\", \"--user\", \"show-environment\"], capture_output=True, text=True, timeout=SYSTEMD_TIMEOUT",
    "SYSTEMD_TIMEOUT = 15", "except subprocess.TimeoutExpired as exc:", "systemctl --user show-environment timed out after ", "check=True, timeout=SYSTEMD_TIMEOUT",
    "parent directory is not writable",
    "os.W_OK | os.X_OK",
    "check_write_target(label, dest)",
    "check_write_target(\"binary\", BIN_DIR / \"lyblive\")",
    "check_write_target(\"OBS dock\", DOCK_WRITE)",
    'def bundle_error', 'deployment template ', ' is invalid: ', 'restore deploy/ from the release bundle', 'hardcoded-path, or marker-drift deploy template', 'def read_template', 'bundle_error(name, \"missing file at \" + str(p))', 'bundle_error(name, \"cannot be read as UTF-8: \" + str(exc))', 'bundle_error(name, \"hardcodes \" + needle)', 'bundle_error(unit_name, \"WorkingDirectory marker drift', 'bundle_error(\"lyblive.service\", \"port marker drift', 'bundle_error(\"lyblive.service\", \"missing \" + marker_text)', 'bundle_error(\"lyblive-obs.service\", \"missing \" + marker_text)',
  ]) {
    must(installer.includes(marker), 'portable installer Qt/CRLF guard drift: ' + marker)
  }
  must((installer.match(/def read_raw\(/g) || []).length === 1, 'portable installer lost its single raw UTF-8 reader')
  must((installer.match(/newline=""/g) || []).length === 2, 'portable installer lost raw read/write newline preservation')
  must(installer.includes('with open(path, "r", encoding="utf-8", newline="") as f:') && installer.includes('os.fdopen(fd, "w", encoding="utf-8", newline="")'), 'portable installer raw read/write wiring drift')
  must(!installer.includes('if lines[i].startswith("ExtraBrowserDocks=")'), 'render_dock regressed to column-0-only ExtraBrowserDocks matching')
  must(!installer.includes('lstrip().startswith("[") and lines[i].rstrip().endswith("]")'), 'render_dock regressed to end-of-line-only section headers')
  must(!installer.includes('if dest.exists() and read_raw(dest) == text: return "unchanged"'), 'portable installer regressed to content-only idempotency')
  must(!installer.includes('time.strftime("%Y%m%d%H%M%S")') && !installer.includes('os.replace(tmp, backup)'), 'portable installer regressed to timestamp-collision backup overwrites')
  must(!installer.includes('return current == (mode & 0o700)'), 'portable installer regressed to owner-only mode comparison')
  must(!installer.includes('    stripped = text.lstrip("\\ufeff")' + String.fromCharCode(10) + '    if not stripped.startswith("[")'), 'render_dock regressed to not stripping leading whitespace before a section header')
  must(!installer.includes('keep_group_other = current & (mode & 0o077)'), 'portable installer preserved extra/special permission bits')
  must(!installer.includes('dock_text = render_dock(read_raw(DOCK_INI))'), 'portable installer lost atomic dock validation')
  must(!installer.includes('raise RuntimeError("OBS config missing: ') && !installer.includes('atomic_write(DOCK_INI, dock_text, old_mode)'), 'portable installer regressed to missing-dock failure or symlink replacement')
  must(!installer.includes('comment_at = raw.find(";")'), 'render_dock regressed to truncating a quoted ";" in a dock value')
  const preflightCall = installer.indexOf("\npreflight_write_targets()\n")
  const planPrint = installer.indexOf("\nprint(\"lyblive deployment plan:")
  must(preflightCall >= 0 && planPrint >= 0 && preflightCall < planPrint, "portable installer destination preflight must run before plan output")
  const systemdPreflightCall = installer.indexOf("systemctl_problem = None if args.no_systemctl else systemctl_preflight()")
  const applyExit = installer.indexOf("\nif not args.apply:")
  must(systemdPreflightCall >= 0 && applyExit >= 0 && systemdPreflightCall < applyExit, "portable installer must preflight systemd --user before plan exits")

  const deployReadme = readFileSync(join(deployDir, 'README.md'), 'utf8')
  for (const marker of ['no-op', '--deploy', 'deploy-install-smoke.mjs', 'per generated file', 'py -3', 'exact step lines',
    "quoted `3.12`", "`'3.12'` or `\"3.12\"`", 'leading whitespace', 'Qt-equivalent', 'repeated [BasicWindow]', 'trailing comment', 'CRLF',
    'fixture write targets', 'resolved through symlinks', 'symlink escapes', '--dock-ini', 'binary/backup symlinks', 'backup_copy', 'atomic_copy', 'hard-link fallback', 'LYBLIVE_SMOKE_FORCE_NO_SYMLINK=1', 'both CI jobs', 'exact step shape',
    'canonical mode', '0644/0755', 'special bits', '--plan', 'bad JSON', 'atomic', 'mode repair',
    'non-UTF-8', 'missing OBS dock', 'OBS is running', 'dock symlink', 'readable argparse error', 'frozen-clock', 'collision-free', 'os.link',
    "destination preflight",
    "check_write_target",
    "check_readable_source",
    "parent directory is not writable",
    "blocked parent", "UTF-8 BOM", "inline comment", "BOM-preserving", "indented header", "quoted", "jsessionid", "unquoted", "OBS detection timeout", "OBS_DETECT_TIMEOUT = 5", "bounded OBS detection", "unreachable-systemd preflight with bounded timeouts", "SYSTEMD_TIMEOUT = 15", "--no-systemctl",
    "cannot read installer source binary",
    "HOME must be an absolute path", "XDG_CONFIG_HOME must be an absolute path", "relative HOME", "relative XDG_CONFIG_HOME", "no traceback", "Could not determine home directory.", "HOME=/home/lilyco", "`~`", "user_path()", "--bin", "--dock-ini", "user_path()", "--bin", "--dock-ini",
    "corrupt deploy bundle", "deployment template", "restore deploy/ from the release bundle", "marker drift",
    "DO_NOT_TOUCH",
  ]) {
    must(deployReadme.includes(marker), 'deploy README must document no-op, strict smoke, Qt-equivalent INI merge, CRLF and fixture containment: ' + marker)
  }
  must(countIn(installer, "check=True, timeout=SYSTEMD_TIMEOUT") >= 3, 'portable installer must bound all systemd activation subprocesses')
  const smokePath = findOne(['scripts/deploy-install-smoke.mjs', 'deploy-install-smoke.mjs'])
  must(smokePath, 'portable installer offline smoke test missing')
  const smoke = readFileSync(smokePath, 'utf8')
  for (const marker of ['--plan', '--apply', '--fixture', '--configure-dock', '--no-binary', 'LYBLIVE_PORT', 'refuses the real user home', 'idempot',
    "{ cmd: 'py', pre: ['-3'] }", "sys.version_info >= (3, 7)",
    "const againOut = again.stdout || ''", "label + ': unchanged'", "!againOut.includes(': written')", "function dockKeyLines", "keyLines[0].startsWith('ExtraBrowserDocks=')", 'render_dock dropped a dock from a duplicate key',
    "keyLines.length === 1", 'render_dock dropped a dock from a case-variant key', 'render_dock dropped a dock from a repeated [BasicWindow] section',
    'render_dock absorbed a dock from another section', 'bare top-level dock key created without [BasicWindow]',
    'new dock key concatenated to Foo=bar', 'CRLF fixture lost line endings', 'ExtraBrowserDocks is not valid JSON; refusing to overwrite', 'UTF-8 BOM dock prefix was lost', 'BOM dock gained a duplicate [BasicWindow] section', 'BOM dock left duplicate ExtraBrowserDocks keys', 'BOM dock second --apply was not idempotent', 'missing-section/no-EOL/CRLF/BOM+inline-comment repair', 'indented [Other] dock key was absorbed into BasicWindow', 'indented [Other] dock key was destroyed', 'indented [BasicWindow] fixture gained a duplicate section', 'indented-section fixture rewrote the header line', 'function sectionDockLines', 'indented-header section boundaries', 'quoted ";" in a dock URL was truncated', 'semicolon URL fixture left duplicate dock keys', 'unquoted ";" comment dropped the existing dock', 'quoted-semicolon dock values',
    'ExtraBrowserDocks is not a JSON array; refusing to overwrite',
    'symlinkSync', 'escapedDock.status === 2', 'escapedConfig.status === 2', 'escapedLink.status === 2',
    '--fixture requires --dock-ini', '--fixture requires XDG_CONFIG_HOME',
    'fixture --dock-ini escape overwrote a file outside HOME', 'fixture XDG_CONFIG_HOME escape wrote outside HOME',
    'fixture symlink escape overwrote target outside HOME',
    'fixture HOME containment (outside paths, symlink escapes, binary/backup symlinks)',
    'makeContainmentHome', '--fixture requires lyblive.service', '--fixture requires binary',
    'symlinked unit destination wrote outside HOME', 'symlinked backup wrote outside HOME',
    'symlinked binary destination wrote outside HOME', 'binary destination was not atomically replaced',
    'binary destination is still a symlink', 'relaxed unchanged fast path followed a binary symlink to its source', 'symlink-to-source binary was not atomically replaced', 'backup_copy did not create a fresh regular backup beside any write-through link',
     'LYBLIVE_SMOKE_FORCE_NO_SYMLINK', 'linkSync', 'supportsSymlinks', 'Windows/hard-link fallback exercised',
     'Windows hard-link fallback wrote through to outside sentinel', 'Windows hard-link backup fallback wrote through to outside sentinel',
     'Windows hard-link fallback did not replace binary', 'Windows hard-link destination is still a symlink',
     'backup_copy did not preserve a regular backup beside a hard link',
    "statSync",
    "chmodSync",
    "canonicalMode",
    "expectMode",
    "owner executable-bit repair",
    "extra/special permission-bit repair",
    "--plan dock errors",
    "atomic bad-JSON rejection",
    "bad JSON abort left partial writes",
    "Web unit canonical mode was not repaired",
    "Web unit extra/special bits were not stripped",
    "planBad.status === 2 && planOut.includes(bad.expect)",
    "name: 'relative HOME'", "name: 'relative XDG_CONFIG_HOME'", 'corrupt bundle ', 'const corruptRoot', 'non-UTF-8 template', 'hardcoded path', 'marker drift', 'deployment template ', 'restore deploy/ from the release bundle', 'corrupt-bundle guards', 'tilde HOME/CLI path expansion', "HOME: '~'", 'const homeMatch = tildeOut.match', 'isAbsolute(homeMatch[1])', 'tilde --bin did not resolve from the real account home', 'tilde --dock-ini did not resolve from the real account home', "'OBS dock -> ' + tildeDockPath + ' [create]'", 'tilde --dock-ini --plan wrote outside the temporary fixture', '5 input guards (including relative HOME/XDG_CONFIG_HOME, no traceback), 4 corrupt-bundle guards', 'exposed a Python traceback',
    "extra/special bits were treated as unchanged",
    "content-only idempotency hid a missing permission bit",
    "--no-binary kept a non-executable binary",
    "mode repair rewrote file bytes",
    "includes('[mode repair]')",
    "includes('[keep existing / mode repair]')",
    "non-UTF-8 safe repair", "missing OBS dock creation", "readable --no-binary guard", "OBS-running missing-dock guard", "dock symlink write-through guards (POSIX)", "non-UTF-8 unit --plan exposed a Python traceback", "non-UTF-8 unit backup lost original bytes", "readable non-UTF-8 error missing", "non-UTF-8 dock abort left partial writes", "missing OBS dock [create] not reported", "missing OBS dock [create] was not read-only", "created OBS dock is not mode 0644", "created OBS dock lacks canonical lyblive entry", "readable --no-binary guard did not fire", "missing OBS dock OBS-running guard did not fire", "OBS-running missing-dock guard created user.ini", "dock symlink was replaced instead of writing through", "dock symlink target was not updated", "POSIX dock symlink write-through exercised",
    "canonical-mode baseline drift",
    "--plan changed permissions (not read-only)",
    "frozen-backup-home", "time.strftime = lambda", "frozen-clock backup_copy created", "frozen-clock backup_copy overwrote a prior version", "frozen-clock unique backups",
    "non-regular/unreadable/blocked-parent destination preflight",
    "OBS detection timed out after ", "hung OBS detection guard did not fire", "bounded OBS detection exercised", "LYBLIVE_SMOKE_OBS_STATE", "obs-detect-sim", "state == 'timeout'", "'timeout' not in kwargs", "raise subprocess.TimeoutExpired", "function obsSimEnv",
    "unreachable-systemd preflight with bounded timeouts", "systemd-preflight-home", "sitecustomize.py", "hung systemd user manager", "systemd --user show-environment timed out after ", "expectUnreachable(timeoutEnv, \"hung systemd user manager\")", "raise subprocess.TimeoutExpired", "systemd --plan did not report UNREACHABLE", "systemd --apply left partial writes", "--no-systemctl plan line missing",
    "function expectPreflight",
    "function preflightHome",
    "DO_NOT_TOUCH",
    "UTF-8 BOM", "BOM+inline-comment repair", "BOM dock second --apply was not idempotent", "indented-header section boundaries", "quoted-semicolon dock values", "quoted \";\" in a dock URL was truncated", "indented [Other] dock key was absorbed into BasicWindow",
    "blocked parent destination preflight did not fire",
    "blocked parent destination was modified",
    "blocked parent destination preflight left partial writes",
    "parent path is blocked by a non-directory",
    "directory destination preflight did not fire",
    "unreadable destination preflight did not fire",
    "non-writable parent preflight did not fire",
    "unreadable binary source preflight did not fire",
    "broken destination symlink preflight did not fire",
    "directory destination preflight left partial writes",
    "unreadable binary source was installed",
    "broken destination symlink was overwritten",
    "cannot read installer source binary",
    "parent directory is not writable",
    "destination is not a regular file",
    "cannot read existing lyblive.service",
  ]) {
    must(smoke.includes(marker), 'installer smoke drift: ' + marker)
  }
  const boundaryReadmePath = findOne(['README.md'])
  must(boundaryReadmePath, 'root README missing for 60043 boundary')
  const boundaryReadme = readFileSync(boundaryReadmePath, 'utf8')
  for (const marker of ['code 60043', 'B 站手机客户端或官方直播姬', '不是 lyblive 或 OBS 的功能入口', '实名状态与停播冷却期', '不会索取或保存账号凭据']) {
    must(boundaryReadme.includes(marker), 'root README must document the 60043 official-client boundary: ' + marker)
  }
  const rootReadmePath = findOne(['README.md'])
  must(rootReadmePath, 'root README missing from source tree')
  const rootReadme = readFileSync(rootReadmePath, 'utf8')
  for (const marker of ['all write targets', 'resolved through symlinks', 'symlink escapes', 'binary/backup symlinks', 'backup_copy', 'atomic_copy', 'hard-link fallback', 'LYBLIVE_SMOKE_FORCE_NO_SYMLINK=1', 'both CI jobs',
    'canonical mode', '0644/0755', 'special bits', '--plan', 'bad JSON', 'atomic', 'mode repair',
    'non-UTF-8', 'missing OBS dock', 'OBS is running', 'dock symlink', 'frozen-clock', 'collision-free', 'os.link',
    "destination preflight",
    "HOME must be an absolute path", "XDG_CONFIG_HOME must be an absolute path", "relative HOME", "relative XDG_CONFIG_HOME", "no traceback", "Could not determine home directory.", "HOME=/home/lilyco", "`~`", "corrupt deploy bundle", "deployment template", "restore deploy/ from the release bundle", "marker drift",
    "check_write_target",
    "check_readable_source",
    "parent directory is not writable",
    "blocked parent", "UTF-8 BOM", "inline comment", "BOM-preserving", "indented header", "jsessionid", "OBS detection timeout", "OBS_DETECT_TIMEOUT = 5", "bounded OBS detection", "unreachable-systemd preflight with bounded timeouts", "SYSTEMD_TIMEOUT = 15", "--no-systemctl",
    "cannot read installer source binary",
    "DO_NOT_TOUCH",
  ]) {
    must(rootReadme.includes(marker), 'root README must document fixture containment: ' + marker)
  }
  const regressPath = findOne(['scripts/single-obs-regress.sh'])
  const regress = readFileSync(regressPath, 'utf8')
  must(countIn(regress, 'systemd --user show-environment timed out after ') >= 1, 'single-OBS regression script lost bounded-timeout installer/smoke guard')
  for (const marker of ['def backup_copy', 'def atomic_copy', 'makeContainmentHome', '--fixture requires binary', 'fixture containment guards intact (symlink-resolved outputs, backups and atomic replacement)', 'LYBLIVE_SMOKE_FORCE_NO_SYMLINK=1 node', 'CI runs normal + Windows-like installer smoke in both jobs', 'Windows-like hard-link installer smoke passed', 'Windows hard-link backup fallback wrote through to outside sentinel', 'backup_copy did not preserve a regular backup beside a hard link',
    'frozen-clock collision-free, missing-dock/dock-symlink, bounded OBS/tilde-HOME/CLI validation, corrupt-bundle and unreachable-systemd guards intact', 'def bundle_error', 'deployment template ', 'restore deploy/ from the release bundle', 'corrupt bundle ', 'corrupt-bundle guards', 'OBS_DETECT_TIMEOUT = 5', 'def obs_detection_problem', 'timeout=OBS_DETECT_TIMEOUT', 'LYBLIVE_SMOKE_OBS_STATE', 'obs-detect-sim', 'bounded OBS detection exercised', 'def owner_mode_ok', 'return current == (mode & 0o777)', 'def dock_target_text', 'parser.error(str(exc))',
    'atomic bad-JSON rejection', 'bad JSON abort left partial writes',
    'def read_raw_or_none', 'def dock_write_path', 'DOCK_WRITE = dock_write_path()', 'atomic_write(DOCK_WRITE, dock_text, old_mode)',
    'non-UTF-8 unit --plan exposed a Python traceback', 'missing OBS dock [create] not reported', 'dock symlink was replaced instead of writing through', 'frozen-backup-home', 'frozen-clock backup_copy overwrote a prior version',
    "def check_readable_source",
    "def check_write_target",
    "def preflight_write_targets",
    "preflight_write_targets()",
    "parent directory is not writable",
    "cannot read installer source binary",
    "blocked parent destination preflight did not fire",
    "non-regular/unreadable/blocked-parent destination preflight",
    "unreachable-systemd preflight with bounded timeouts", "systemd --user is not reachable from this shell", "--no-systemctl plan line missing",
    "def systemctl_preflight", "systemctl_problem = None if args.no_systemctl else systemctl_preflight()", "systemd --user: UNREACHABLE",
    'HOME_ABSOLUTE = HOME.is_absolute()', 'XDG_CONFIG_HOME_ABSOLUTE = XDG_CONFIG_HOME.is_absolute()', 'if not HOME_ABSOLUTE:', 'if not XDG_CONFIG_HOME_ABSOLUTE:', 'HOME must be an absolute path', 'XDG_CONFIG_HOME must be an absolute path',
    "name: 'relative HOME'", "name: 'relative XDG_CONFIG_HOME'", '5 input guards (including relative HOME/XDG_CONFIG_HOME, no traceback)', 'exposed a Python traceback', 'const corruptRoot', 'corrupt bundle ', 'non-UTF-8 template', 'hardcoded path', 'marker drift', 'deployment template ', 'restore deploy/ from the release bundle', '4 corrupt-bundle guards', 'def user_path(', 'user_path(args.dock_ini)', 'user_path(args.bin)', 'tilde --bin did not resolve from the real account home',
    '[\"systemctl\", \"--user\", \"show-environment\"]',
    'BILI_CLIENT="$SCRIPT_ROOT/src/bili/client.rs"',
    'BILI_STATIC_OK=1',
    'code 60043 official-client guidance, negative test and boundary docs intact',
    'if code == 60043',
    'text.push_str(concat!(',
    'code 60043 face-verification guidance drift',
    "DO_NOT_TOUCH",
    "UTF-8 BOM", "BOM+inline-comment repair", "BOM dock second --apply was not idempotent", "indented [BasicWindow] fixture gained a duplicate section", "Qt readIniLine accepts leading whitespace before the bracket",
    'return bom + "".join(lines)', 'def qt_value', 'elif ch == ";" and not in_quotes:', 'quoted ";" in a dock URL was truncated', 'BOM dock gained a duplicate [BasicWindow] section',
  ]) {
    must(regress.includes(marker), 'single-OBS regression script lost fixture containment guard: ' + marker)
  }
}
const indexPath = findOne(['web/dist/index.html', 'assets/index.html'])
if (requireAssets || requireEmbedded) must(indexPath, 'built Web asset index missing before cargo/parity')
let assets = 'not present (structure only)'
let assetFiles = []
let fontRefs = []
if (indexPath) {
  const idx = readFileSync(indexPath, 'utf8')
  must(idx.includes('id="root"'), 'index.html missing #root')
  must(!idx.includes('Web 资源未构建'), 'web/dist/index.html is build.rs placeholder')
  must(idx.includes('rel="stylesheet"'), 'index.html missing stylesheet link')
  const jsMatch = idx.match(/src="(\/assets\/[^"]+\.js)"/)
  must(jsMatch, 'index.html missing built JS asset')
  const cssMatch = idx.match(/href="(\/assets\/[^"]+\.css)"/)
  must(cssMatch, 'index.html missing built CSS asset')
  const distRoot = dirname(indexPath)
  const flat = basename(distRoot) === 'assets'
  const assetDir = flat ? distRoot : join(distRoot, 'assets')
  const faviconPath = join(distRoot, 'favicon.svg')
  function assetBytes(rel, label) {
    const name = rel.replace(/^\/assets\//, '')
    const p = label === 'favicon' ? faviconPath : join(assetDir, name)
    must(existsSync(p), label + ' asset missing: ' + name)
    return readFileSync(p)
  }
  const indexBytes = readFileSync(indexPath)
  const favicon = assetBytes('/favicon.svg', 'favicon')
  const jsBytes = assetBytes(jsMatch[1], 'built JS')
  const cssBytes = assetBytes(cssMatch[1], 'built CSS')
  const jsText = jsBytes.toString('utf8')
  const cssText = cssBytes.toString('utf8')
  must(jsBytes.length > 100000 && jsText.includes('createRoot'), 'built JS is not the real React bundle')
  must(cssBytes.length > 10000 && cssText.includes('tailwindcss') && cssText.includes('--tw-'), 'built CSS is not the real Tailwind bundle')
  must(favicon.length > 100 && favicon.toString('utf8').includes('<svg'), 'favicon is not the real SVG')
  fontRefs = [...cssText.matchAll(/url\(\s*['"]?\/assets\/([^'")]+\.woff2)['"]?\s*\)/g)].map((m) => '/assets/' + m[1])
  must(fontRefs.length > 0 && fontRefs.length <= 10, 'CSS bundled woff2 font count drift')
  must(!/url\(\s*['"]?(https?:|data:)/i.test(cssText), 'CSS has external/data font refs')
  const diskFonts = readdirSync(assetDir).filter((n) => n.endsWith('.woff2')).sort()
  const refNames = fontRefs.map((r) => r.replace(/^\/assets\//, '')).sort()
  must(diskFonts.length === refNames.length && diskFonts.every((n, i) => n === refNames[i]), 'CSS font refs and disk woff2 files drift')
  assetFiles = [
    ['/index.html', indexBytes],
    ['/favicon.svg', favicon],
    [jsMatch[1], jsBytes],
    [cssMatch[1], cssBytes],
  ]
  for (const ref of fontRefs) assetFiles.push([ref, assetBytes(ref, 'CSS font')])
  assets = 'real shadcn bundle (JS/CSS/' + fontRefs.length + ' fonts)'
}

let binaries = []
if (requireEmbedded) {
  if (allArtifacts) {
    const binDir = join(scriptDir, 'bin')
    must(existsSync(binDir), 'artifact archive bin/ directory missing for --all-artifacts')
    must(existsSync(join(scriptDir, 'assets/index.html')), 'artifact archive assets/index.html missing for --all-artifacts')
    binaries = readdirSync(binDir).filter((n) => !n.startsWith('.')).map((n) => join(binDir, n)).filter((p) => existsSync(p))
    must(binaries.length >= 6, 'expected at least 6 archived binaries, got ' + binaries.length)
  } else if (embeddedArgs.length) {
    for (const p of embeddedArgs) {
      const r = resolvePath(p)
      must(r, 'embedded binary missing: ' + p)
      binaries.push(r)
    }
  } else {
    const targetRoot = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : null
    const candidates = []
    for (const r of roots) {
      const tr = targetRoot || join(r, 'target')
      candidates.push(join(tr, 'release', 'lyblive'), join(tr, 'release', 'lyblive.exe'))
    }
    const found = candidates.find((p) => existsSync(p))
    must(found, 'release binary missing; pass its path to --embedded')
    binaries = [found]
  }
  must(assetFiles.length >= 8, 'built Web assets required for embedded parity (structure-only is not proof)')
  const placeholder = Buffer.from('Web 资源未构建', 'utf8')
  for (const binPath of binaries) {
    const bin = readFileSync(binPath)
    must(!bytesInclude(bin, placeholder), 'binary embeds build.rs placeholder: ' + binPath)
    for (const [rel, bytes] of assetFiles) {
      must(bytesInclude(bin, bytes), 'binary missing embedded asset ' + rel + ': ' + binPath)
    }
  }
}
must(ci.includes('gh release create'), 'publish/release step missing for tags')
must(ci.includes('gh release create --repo "$GITHUB_REPOSITORY"'), 'publish must set --repo for detached artifact job')
must(ci.includes('needs: [desktop, android-headless]'), 'publish must depend on build jobs')
must(ci.includes('actions/download-artifact@v4'), 'publish must download build artifacts')
must(ci.includes("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"), 'publish must be tag-gated')
must(ci.includes('contents: write'), 'publish needs contents: write permission')
must(ci.includes('sha256sum lyblive-* > SHA256SUMS'), 'release SHA256SUMS drift')
must(ci.includes('sha256sum -c SHA256SUMS'), 'release checksum verification drift')
for (const artifact of ['lyblive-ubuntu-latest', 'lyblive-windows-latest', 'lyblive-macos-latest', 'lyblive-android-arm64', 'lyblive-android-x86_64']) {
  must(ci.includes('pick ' + artifact + ' '), 'publish missing artifact staging: ' + artifact)
}
const parity = requireEmbedded ? '; embedded parity ' + binaries.length + ' binary(s)' : ''
const deploy = requireDeploy && !allArtifacts ? '; portable single-OBS deployment 5 files' : ''
console.log('ci-contract: desktop 3 OS; Android 2 ABIs; 3 uploads error-on-empty; Web-before-cargo; triggers; ' + assets + parity + deploy + '; strict Host/Origin guards; browser cleanup OK')

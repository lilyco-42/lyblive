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
must(contractLines.length >= 6, 'CI workflow contract steps drift (expected 6: contract/assets/embedded x 2 jobs)')
must(countIn(ci, 'run: node scripts/ci-contract.mjs --assets') >= 2, 'both jobs must run built Web asset guard')
must(countIn(ci, 'run: node scripts/ci-contract.mjs --embedded') >= 2, 'both jobs must run embedded Web asset parity')

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
console.log('ci-contract: desktop 3 OS; Android 2 ABIs; 3 uploads error-on-empty; Web-before-cargo; triggers; ' + assets + parity + '; strict Host/Origin guards; browser cleanup OK')

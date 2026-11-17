#!/usr/bin/env node
// 跨平台 CLI 冒烟：在临时 HOME / XDG_CONFIG_HOME / APPDATA 里真跑 --obs-* 命令。
// 目的：验证 Windows(macOS/Linux) 各自的配置路径解析、幂等与卸载，而不碰真实 OBS 配置。
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, "..")
const targetRoot = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, "target")
const candidates = [
  process.argv[2],
  join(targetRoot, "release", "lyblive"),
  join(targetRoot, "release", "lyblive.exe"),
  join(root, "target", "release", "lyblive"),
  join(root, "target", "release", "lyblive.exe"),
].filter(Boolean)
const binary = candidates.find((p) => existsSync(p))
if (!binary) {
  console.error("platform-smoke: build the release binary first: cargo build --release")
  process.exit(1)
}

const isWindows = process.platform === "win32"
const fixture = mkdtempSync(join(tmpdir(), "lyblive-platform-smoke-"))
const home = join(fixture, "home")
const xdg = join(fixture, "xdg")
const appdata = join(fixture, "appdata")
mkdirSync(home, { recursive: true })
mkdirSync(xdg, { recursive: true })
mkdirSync(appdata, { recursive: true })

const obsRoot = isWindows ? join(appdata, "obs-studio") : join(xdg, "obs-studio")
mkdirSync(obsRoot, { recursive: true })
const userIni = join(obsRoot, "user.ini")
writeFileSync(
  userIni,
  "[General]\nFirstRun=true\n\n[BasicWindow]\nDocksLocked=false\n\n[Appearance]\nFontScale=10\n",
  "utf8",
)

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  APPDATA: appdata,
  LYBLIVE_CONFIG_HOME: join(home, "lyblive"),
  LYBLIVE_OBS_SMOKE: "1",
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`)
}
function run(args) {
  const out = spawnSync(binary, args, { env, encoding: "utf8", timeout: 20000 })
  return { code: out.status, stdout: (out.stdout || "") + (out.stderr || "") }
}

const version = run(["--version"])
check("--version 正常", version.code === 0 && version.stdout.includes("lyblive"), version.stdout.trim().split("\n")[0])

const status0 = run(["--obs-status"])
check(
  "--obs-status 读到 fixture 内的配置",
  status0.code === 0 && status0.stdout.includes("配置文件") && status0.stdout.includes(isWindows ? "appdata" : "xdg"),
  status0.stdout.trim().replace(/\n/g, " | ").slice(0, 160),
)

const install1 = run(["--obs-install"])
let ini1 = ""
try {
  ini1 = readFileSync(userIni, "utf8")
} catch {}
check(
  "--obs-install 写入 ExtraBrowserDocks",
  install1.code === 0 && /ExtraBrowserDocks=\[\{"title":\s*"lyblive"/.test(ini1),
  ini1.split("\n").find((l) => l.startsWith("ExtraBrowserDocks"))?.slice(0, 90) || install1.stdout.slice(0, 90),
)
check(
  "--obs-install 保留其它配置",
  ini1.includes("FontScale=10") && ini1.includes("[BasicWindow]"),
  ini1.includes("FontScale=10") ? "FontScale 保留" : "FontScale 丢失",
)

const install2 = run(["--obs-install"])
check("--obs-install 幂等", install2.code === 0 && install2.stdout.includes("无需修改"), install2.stdout.trim().slice(0, 80))

const fix = run(["--obs-fix-dock"])
check("--obs-fix-dock 无记录时安全返回", fix.code === 0 && fix.stdout.includes("无需修复"), fix.stdout.trim().slice(0, 80))

const uninstall = run(["--obs-uninstall"])
let ini2 = ""
try {
  ini2 = readFileSync(userIni, "utf8")
} catch {}
check(
  "--obs-uninstall 移除条目",
  uninstall.code === 0 && !ini2.includes("ExtraBrowserDocks="),
  ini2.includes("ExtraBrowserDocks=") ? "仍存在" : "已移除",
)

const uninstall2 = run(["--obs-uninstall"])
check("--obs-uninstall 幂等", uninstall2.code === 0 && uninstall2.stdout.includes("无需卸载"), uninstall2.stdout.trim().slice(0, 80))

const bad = run(["--obs-fix-dock", "--fixture-does-not-exist"])
check("未知参数不崩溃（仍按 fix-dock 处理或忽略）", bad.code === 0, `rc=${bad.code}`)

try {
  rmSync(fixture, { recursive: true, force: true })
} catch {}

const failed = results.filter((r) => !r.ok)
console.log(`SUMMARY platform=${process.platform} total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
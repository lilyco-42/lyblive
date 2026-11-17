#!/usr/bin/env node
// Web 模式（不依赖 OBS）端到端冒烟：真实二进制 + 真实 Chromium + CDP。
// 覆盖：/api/health、5 个页签可达、无控制台错误、无横向溢出、设置页关键卡片、
// /overlay?demo=1 浮层页，以及 `--open` 在服务已运行时不重复监听。
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
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
  join(scriptDir, "bin", "lyblive-linux-x86_64"),
  join(root, "target", "release", "lyblive"),
].filter(Boolean)
const binary = candidates.find((p) => existsSync(p))
if (!binary) {
  console.error("web-mode-smoke: build the release binary first: cargo build --release")
  process.exit(1)
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
function must(cond, msg) {
  if (!cond) throw new Error("web-mode-smoke: " + msg)
}
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.on("error", fail)
    s.listen(0, "127.0.0.1", () => {
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
        method: opts.method || "GET",
        headers: opts.headers || {},
      },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => ok({ status: res.statusCode, body: Buffer.concat(chunks) }))
      },
    )
    r.on("error", fail)
    r.setTimeout(1500, () => r.destroy(new Error("timeout")))
    r.end()
  })
}

const chromeBin =
  process.env.LYBLIVE_BROWSER_BIN ||
  ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(
    (p) => existsSync(p),
  )
must(chromeBin, "找不到 Chromium/Chrome（可用 LYBLIVE_BROWSER_BIN 指定）")

const cfgHome = mkdtempSync(join(tmpdir(), "lyblive-webmode-cfg-"))
const chromeProfile = mkdtempSync(join(tmpdir(), "lyblive-webmode-chrome-"))
const port = await freePort()
const base = `http://127.0.0.1:${port}`
let server
let chrome
let ws

try {
  server = spawn(binary, ["--web", "--no-browser"], {
    env: { ...process.env, LYBLIVE_PORT: String(port), LYBLIVE_CONFIG_HOME: cfgHome },
    stdio: "ignore",
  })

  // 1) 服务起来
  let healthy = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const res = await httpCall(base, "/api/health")
      if (res.status === 200) {
        healthy = true
        break
      }
    } catch {}
  }
  must(healthy, "/api/health 未在 10 秒内返回 200")
  console.log("PASS 服务启动 + /api/health 200")

  // 2) --open 在服务已运行时应立即退出（不重复监听端口）
  const openExit = await new Promise((ok) => {
    const child = spawn(binary, ["--open"], {
      env: { ...process.env, LYBLIVE_PORT: String(port), LYBLIVE_CONFIG_HOME: cfgHome, BROWSER: "/bin/true" },
      stdio: "ignore",
      timeout: 8000,
    })
    child.on("exit", (code) => ok(code))
    child.on("error", () => ok(-1))
  })
  must(openExit === 0, `--open 在服务已运行时退出码应为 0，实际 ${openExit}`)
  const stillUp = await httpCall(base, "/api/health")
  must(stillUp.status === 200, "--open 后原服务不应退出")
  console.log("PASS --open 只开浏览器、不改动已有服务")

  // 3) 启动 Chromium
  const cdpPort = await freePort()
  chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${chromeProfile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  )
  let pageTarget = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      pageTarget = list.find((t) => t.type === "page")
      if (pageTarget) break
    } catch {}
  }
  must(pageTarget, "Chromium CDP 未就绪")

  ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  const consoleErrors = []
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "))
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((ok) => (ws.onopen = ok))
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const id = ++seq
      pending.set(id, ok)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    return out.result?.result?.value
  }

  await send("Page.enable")
  await send("Runtime.enable")
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
  await send("Page.navigate", { url: `${base}/` })
  await sleep(1800)

  const tabs = ["登录", "房间", "直播", "弹幕", "设置"]
  for (const tab of tabs) {
    const clicked = await ev(`(() => {
      const t = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.includes(${JSON.stringify(tab)}))
      if (!t) return false
      const r = t.getBoundingClientRect()
      const o = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, button: 0 }
      t.dispatchEvent(new PointerEvent('pointerdown', o))
      t.dispatchEvent(new MouseEvent('mousedown', o))
      t.dispatchEvent(new MouseEvent('mouseup', o))
      t.dispatchEvent(new MouseEvent('click', o))
      return true
    })()`)
    must(clicked === true, `找不到页签「${tab}」`)
    await sleep(600)
    const state = await ev(`(() => {
      const active = document.querySelector('[role=tab][aria-selected="true"]')?.textContent?.trim() ?? ""
      const vw = document.documentElement.clientWidth
      return { active, overflow: document.body.scrollWidth > vw + 1 }
    })()`)
    must(state.active.includes(tab), `页签「${tab}」未激活（当前 ${state.active}）`)
    must(state.overflow === false, `页签「${tab}」出现横向溢出`)
  }
  console.log("PASS 5 个页签均可切换且无横向溢出")

  const cards = await ev(`(() => {
    const text = document.body.innerText
    return {
      overlay: text.includes('弹幕漂浮'),
      sponsor: text.includes('赞助与广告'),
      scale: text.includes('界面缩放'),
    }
  })()`)
  must(cards.overlay, "设置页缺少「弹幕漂浮」卡片")
  must(cards.sponsor, "设置页缺少「赞助与广告」卡片")
  must(cards.scale, "设置页缺少「界面缩放」卡片")
  console.log("PASS 设置页关键卡片齐全（弹幕漂浮 / 赞助与广告 / 界面缩放）")

  // 4) 浮层页
  await send("Page.navigate", { url: `${base}/overlay?mode=scroll&demo=1` })
  await sleep(2600)
  const overlay = await ev(`(() => {
    const stage = document.querySelector('[data-testid="danmu-overlay-stage"]')
    const items = document.querySelectorAll('[data-testid="danmu-overlay-stage"] .lyblive-danmu--scroll')
    return {
      hasStage: !!stage,
      mode: stage?.getAttribute('data-mode') ?? null,
      count: items.length,
      transparent: /rgba\\(0, 0, 0, 0\\)/.test(getComputedStyle(document.body).backgroundColor),
    }
  })()`)
  must(overlay.hasStage, "浮层页缺少 stage")
  must(overlay.mode === "scroll", `浮层 mode 应为 scroll，实际 ${overlay.mode}`)
  must(overlay.count >= 1, "浮层页没有渲染出弹幕（demo 源）")
  must(overlay.transparent, "浮层页背景应为透明")
  console.log("PASS /overlay?demo=1 渲染弹幕且背景透明")

  must(consoleErrors.length === 0, "控制台出现错误：" + consoleErrors.slice(0, 3).join(" | "))
  console.log("PASS 无控制台错误")
  console.log("web-mode-smoke: OK")
} finally {
  try {
    ws?.close()
  } catch {}
  try {
    chrome?.kill("SIGKILL")
  } catch {}
  try {
    server?.kill("SIGKILL")
  } catch {}
  await sleep(200)
  try {
    rmSync(cfgHome, { recursive: true, force: true })
    rmSync(chromeProfile, { recursive: true, force: true })
  } catch {}
}
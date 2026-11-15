#!/usr/bin/env node
// Real-browser React render regression; pure Node stdlib, loopback only, no credentials.
import { spawn, spawnSync } from "node:child_process"
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
  join(scriptDir, "bin", "lyblive-windows-x86_64-gnu.exe"),
  join(root, "target", "release", "lyblive"),
  join(root, "target", "release", "lyblive.exe"),
].filter(Boolean)
const binary = candidates.find(function (p) { return existsSync(p) })
if (!binary) {
  console.error("browser-smoke: build the release binary first: cargo build --release")
  process.exit(1)
}

const sleep = (ms) => new Promise(function (ok) { setTimeout(ok, ms) })
function must(cond, msg) { if (!cond) throw new Error("browser-smoke: " + msg) }

function freePort() {
  return new Promise(function (ok, fail) {
    const s = createServer()
    s.on("error", fail)
    s.listen(0, "127.0.0.1", function () { const p = s.address().port; s.close(function () { ok(p) }) })
  })
}

function httpCall(base, path, opts) {
  opts = opts || {}
  return new Promise(function (ok, fail) {
    const u = new URL(path, base)
    const r = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || "GET", headers: opts.headers || {} }, function (res) {
      const chunks = []
      res.on("data", function (c) { chunks.push(c) })
      res.on("end", function () { ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }) })
    })
    r.on("error", fail)
    r.setTimeout(1000, function () { r.destroy(new Error("timeout")) })
    if (opts.body) r.write(opts.body)
    r.end()
  })
}

function resolveChrome() {
  const explicit = [process.env.LYBLIVE_BROWSER_BIN, process.env.CHROME_BIN].filter(Boolean)
  const paths = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ]
  for (const p of explicit.concat(paths)) { if (existsSync(p)) return p }
  const commands = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]
  for (const c of commands) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore", timeout: 3000 })
    if (r.status === 0) return c
  }
  throw new Error("browser-smoke: Chrome/Chromium not found; set LYBLIVE_BROWSER_BIN or CHROME_BIN")
}

async function killProcess(child, group) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (process.platform === "win32") {
    if (group && pid) {
      try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 }) } catch (e) {}
    }
    child.kill("SIGTERM")
    await sleep(700)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    return
  }
  if (group && pid) {
    try { process.kill(-pid, "SIGTERM") } catch (e) { child.kill("SIGTERM") }
  } else {
    child.kill("SIGTERM")
  }
  await sleep(700)
  if (child.exitCode !== null || child.signalCode !== null) return
  if (group && pid) {
    try { process.kill(-pid, "SIGKILL") } catch (e) { child.kill("SIGKILL") }
  } else {
    child.kill("SIGKILL")
  }
}

async function main() {
  const port = await freePort()
  const base = "http://127.0.0.1:" + port + "/"
  const chromeCmd = resolveChrome()
  const configHome = mkdtempSync(join(tmpdir(), "lyblive-browser-config-"))
  const profile = mkdtempSync(join(tmpdir(), "lyblive-browser-profile-"))
  const wrapper = (process.env.LYBLIVE_SMOKE_WRAPPER || "").trim().split(/ +/).filter(Boolean)
  const cmd = wrapper.concat([binary, "--web", "--no-browser"])
  const webEnv = { ...process.env, LYBLIVE_PORT: String(port), LYBLIVE_CONFIG_HOME: configHome }
  const chromeEnv = { ...process.env, HOME: process.env.HOME || "/home/lilyco" }
  let webChild = null
  let chrome = null
  let cdpWrite = null
  let cdpRead = null
  let sessionId = null
  let webSpawnError = null
  let chromeSpawnError = null
  let webLog = ""
  let failure = null
  try {
    webChild = spawn(cmd[0], cmd.slice(1), { env: webEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
    webChild.on("error", function (e) { webSpawnError = e })
    webChild.stdout.resume()
    webChild.stderr.on("data", function (c) { webLog = (webLog + c.toString("utf8")).slice(-4000) })
    let health = null
    for (let i = 0; i < 80; i += 1) {
      if (webSpawnError) throw webSpawnError
      try {
        const r = await httpCall(base, "/api/health")
        if (r.status === 200) { health = JSON.parse(r.body.toString("utf8")); break }
      } catch (e) {}
      await sleep(250)
    }
    must(health, "Web /api/health did not become ready: " + webLog)
    must(health.ok === true, "backend health is not ok")
    const healthText = health.name + " v" + health.version + " · " + health.backend

    const flagList = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-pipe",
      "--user-data-dir=" + profile,
      "--window-size=1280,900",
      "about:blank",
    ]
    chrome = spawn(chromeCmd, flagList, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: chromeEnv, detached: process.platform !== "win32" })
    chrome.on("error", function (e) { chromeSpawnError = e })
    chrome.stderr.resume()
    await sleep(600)
    if (chromeSpawnError) throw chromeSpawnError
    cdpWrite = chrome.stdio[3]
    cdpRead = chrome.stdio[4]
    cdpWrite.on("error", function (e) { chromeSpawnError = e })

    // CDP over --remote-debugging-pipe avoids a second listening port and browser WebSocket dependency.
    let buf = Buffer.alloc(0)
    const pending = new Map()
    let nextId = 0
    const jsExceptions = []
    const logErrors = []
    const consoleErrors = []
    cdpRead.on("data", function (chunk) {
      buf = Buffer.concat([buf, chunk])
      let idx = buf.indexOf(0)
      while (idx >= 0) {
        const raw = buf.subarray(0, idx).toString("utf8")
        buf = buf.subarray(idx + 1)
        idx = buf.indexOf(0)
        if (raw.trim().length === 0) continue
        let msg = null
        try { msg = JSON.parse(raw) } catch (e) { continue }
        if (msg.id && pending.has(msg.id)) {
          const fn = pending.get(msg.id)
          pending.delete(msg.id)
          fn(msg)
          continue
        }
        if (msg.method === "Runtime.exceptionThrown") {
          jsExceptions.push(msg.params.exceptionDetails ? msg.params.exceptionDetails.text : "unknown")
          continue
        }
        if (msg.method === "Log.entryAdded") {
          logErrors.push(msg.params.entry || {})
          continue
        }
        if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
          consoleErrors.push(msg.params)
        }
      }
    })

    function send(method, params, sid) {
      params = params || {}
      return new Promise(function (ok, no) {
        if (chromeSpawnError) { no(chromeSpawnError); return }
        const id = ++nextId
        const timer = setTimeout(function () { pending.delete(id); no(new Error("browser-smoke: CDP timeout " + method)) }, 15000)
        pending.set(id, function (msg) {
          clearTimeout(timer)
          if (msg.error) no(new Error("browser-smoke: CDP error " + method + ": " + JSON.stringify(msg.error)))
          else ok(msg.result || {})
        })
        const p = { id, method, params }
        if (sid) p.sessionId = sid
        cdpWrite.write(JSON.stringify(p) + String.fromCharCode(0))
      })
    }

    async function evaluate(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (r.exceptionDetails) throw new Error("browser-smoke: Runtime.evaluate exception: " + JSON.stringify(r.exceptionDetails))
      return r.result ? r.result.value : undefined
    }

    function stateProbe() {
      const tabs = Array.from(document.querySelectorAll("[role=tab]"))
      const panel = document.querySelector("[role=tabpanel][data-state=active]")
      return {
        states: tabs.map(function (t) { return t.dataset.state }),
        active: tabs.findIndex(function (t) { return t.dataset.state === "active" }),
        text: panel ? panel.innerText : "",
        tableRows: document.querySelectorAll("[role=tabpanel][data-state=active] tbody tr").length,
      }
    }
    function healthProbe(expected) {
      const root = document.querySelector("#root")
      const h1 = document.querySelector("h1")
      const tabs = Array.from(document.querySelectorAll("[role=tab]"))
      return {
        title: document.title,
        h1: h1 ? h1.textContent : "",
        health: document.body.innerText.includes(expected),
        footer: document.body.innerText.includes("所有请求同源，走 /api/... 相对路径"),
        rootChildren: root ? root.children.length : 0,
        tabs: tabs.map(function (t) { return t.textContent.trim() }),
        active: tabs.findIndex(function (t) { return t.dataset.state === "active" }),
      }
    }
    function styleProbe() {
      const h1 = document.querySelector("h1")
      const cssRules = Array.from(document.styleSheets).reduce(function (n, s) { try { return n + s.cssRules.length } catch (e) { return n } }, 0)
      return {
        font: getComputedStyle(document.body).fontFamily,
        bg: getComputedStyle(document.body).backgroundColor,
        h1Weight: h1 ? getComputedStyle(h1).fontWeight : "0",
        styleSheets: document.styleSheets.length,
        cssRules: cssRules,
      }
    }
    function mountProbe() {
      const root = document.querySelector("#root")
      const tabs = document.querySelectorAll("[role=tab]")
      return !!root && root.children.length > 0 && tabs.length === 5
    }
    function boxProbe(label) {
      const x = Array.from(document.querySelectorAll("[role=tab]")).find(function (e) { return e.textContent.includes(label) })
      if (!x) return null
      x.scrollIntoView({ block: "center" })
      const r = x.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
    }
    function focusProbe(label) {
      const x = Array.from(document.querySelectorAll("[role=tab]")).find(function (e) { return e.textContent.includes(label) })
      if (!x) return false
      x.focus()
      return document.activeElement === x
    }
    function installBrowserErrors() {
      window.__dshBrowserErrors = []
      window.addEventListener("error", function (e) { window.__dshBrowserErrors.push(String(e.message)) })
      window.addEventListener("unhandledrejection", function (e) { window.__dshBrowserErrors.push(String(e.reason)) })
    }

    // Expected offline backend 4xx replies are not browser errors.
    const expectedPaths = ["/api/room", "/api/partitions", "/api/stream-key", "/api/danmu/status"]
    function expectedNetworkError(entry) {
      if (!entry || entry.source !== "network" || entry.level !== "error") return false
      if (!entry.url || !entry.url.startsWith(base + "api/")) return false
      if (!/status of (400|401|403)/.test(entry.text || "")) return false
      let path = ""
      try { path = new URL(entry.url).pathname } catch (e) { return false }
      return expectedPaths.includes(path)
    }

    const TABS = [
      { label: "登录", index: 0, every: ["扫码登录", "获取二维码"] },
      { label: "房间", index: 1, any: ["还没有房间信息", "直播间实时概览"] },
      { label: "直播", index: 2, every: ["高危操作提示", "直播控制"] },
      { label: "弹幕", index: 3, every: ["弹幕监控", "关键词 Top10"] },
      { label: "设置", index: 4, every: ["命令面", "记住登录"] },
    ]
    function markersOk(tab, state) {
      if (!state || typeof state.text !== "string") return false
      for (const marker of tab.every || []) {
        if (!state.text.includes(marker)) return false
      }
      if (tab.any && !tab.any.some(function (m) { return state.text.includes(m) })) return false
      if (tab.label === "设置") {
        return state.tableRows >= 19 && state.text.includes("live-start") && state.text.includes("login-qrcode")
      }
      return true
    }
    function checkPanel(tab, state, source) {
      must(state, "missing state for " + tab.label)
      must(state.active === tab.index, source + " tab " + tab.label + " did not become active: " + JSON.stringify(state.states))
      must(state.states.filter(function (s) { return s === "active" }).length === 1, "multiple active tabs after " + source)
      for (const marker of tab.every || []) {
        must(state.text.includes(marker), source + " panel " + tab.label + " missing marker " + marker + "; panel=" + JSON.stringify(state.text.slice(0, 500)))
      }
      if (tab.any) {
        must(tab.any.some(function (m) { return state.text.includes(m) }), source + " panel " + tab.label + " missing all accepted markers; panel=" + JSON.stringify(state.text.slice(0, 500)))
      }
      if (tab.label === "设置") {
        must(state.tableRows >= 19 && state.text.includes("live-start") && state.text.includes("login-qrcode"), "settings command table did not render from /api/commands")
      }
    }

    let version = null
    for (let i = 0; i < 10; i += 1) {
      try { version = await send("Browser.getVersion"); break } catch (e) { if (i === 9) throw e; await sleep(300) }
    }
    const target = await send("Target.createTarget", { url: "about:blank" })
    sessionId = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId
    for (const method of ["Runtime.enable", "Page.enable", "Log.enable"]) await send(method, {}, sessionId)
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "(" + installBrowserErrors.toString() + ")()" }, sessionId)
    await send("Page.navigate", { url: base }, sessionId)

    const mountExpr = "(" + mountProbe.toString() + ")()"
    let mounted = false
    for (let i = 0; i < 80; i += 1) {
      if (await evaluate(mountExpr)) { mounted = true; break }
      await sleep(250)
    }
    must(mounted, "React console did not mount in browser")

    const healthExpr = "(" + healthProbe.toString() + ")(" + JSON.stringify(healthText) + ")"
    let initial = null
    for (let i = 0; i < 40; i += 1) {
      initial = await evaluate(healthExpr)
      if (initial.health) break
      await sleep(250)
    }
    must(initial, "browser did not render initial health probe")
    must(initial.title === "lyblive · B站直播助手", "document title drift")
    must(initial.h1 === "lyblive · B站直播助手", "h1 drift")
    must(initial.health, "backend health text missing from React header")
    must(initial.footer, "same-origin footer missing")
    must(initial.rootChildren > 0, "React root did not mount")
    must(JSON.stringify(initial.tabs) === JSON.stringify(TABS.map(function (t) { return t.label })), "tab labels drift")
    must(initial.active === 0, "initial tab is not login")

    const style = await evaluate("(" + styleProbe.toString() + ")()")
    must(style.font.includes("Geist Variable"), "Geist font family did not apply")
    must(style.bg && style.bg !== "rgba(0, 0, 0, 0)", "Tailwind background did not apply")
    must(Number(style.h1Weight) >= 600, "Tailwind heading weight did not apply")
    must(style.styleSheets >= 1 && style.cssRules >= 50, "stylesheet rules did not load")

    async function getState() { return await evaluate("(" + stateProbe.toString() + ")()") }
    checkPanel(TABS[0], await getState(), "initial")

    // Trusted CDP mouse and keyboard events exercise Radix Tabs as a real user would.
    async function clickTab(tab) {
      const box = await evaluate("(" + boxProbe.toString() + ")(" + JSON.stringify(tab.label) + ")")
      must(box && box.w > 0 && box.h > 0, "tab not visible: " + tab.label)
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" }, sessionId)
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId)
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 }, sessionId)
      let state = null
      for (let i = 0; i < 24; i += 1) {
        state = await getState()
        if (state.active === tab.index && markersOk(tab, state)) break
        await sleep(250)
      }
      checkPanel(tab, state, "mouse")
    }
    async function keyboardTab(tab) {
      const focused = await evaluate("(" + focusProbe.toString() + ")(" + JSON.stringify(tab.label) + ")")
      must(focused, "could not focus tab: " + tab.label)
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: String.fromCharCode(13) }, sessionId)
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId)
      let state = null
      for (let i = 0; i < 24; i += 1) {
        state = await getState()
        if (state.active === tab.index && markersOk(tab, state)) break
        await sleep(250)
      }
      checkPanel(tab, state, "keyboard")
    }
    for (const tab of TABS.slice(1)) await clickTab(tab)
    await clickTab(TABS[0])
    await keyboardTab(TABS[4])
    await keyboardTab(TABS[0])

    const fatalLogs = logErrors.filter(function (entry) { return !expectedNetworkError(entry) })
    must(jsExceptions.length === 0, "uncaught browser exception: " + JSON.stringify(jsExceptions))
    must(consoleErrors.length === 0, "browser console error: " + JSON.stringify(consoleErrors))
    must(fatalLogs.length === 0, "unexpected browser log error: " + JSON.stringify(fatalLogs))
    const pageErrors = await evaluate("window.__dshBrowserErrors || []")
    must(Array.isArray(pageErrors) && pageErrors.length === 0, "window error or unhandled rejection: " + JSON.stringify(pageErrors))
    console.log("browser-smoke: " + version.product + "; port " + port + "; React/shadcn mount; 5 tabs; mouse+keyboard; Geist/Tailwind; no JS errors OK")
  } catch (e) {
    failure = e
  } finally {
    try { if (cdpWrite) cdpWrite.end() } catch (e) {}
    try { if (cdpRead) cdpRead.destroy() } catch (e) {}
    await killProcess(chrome, true)
    await killProcess(webChild, true)
    for (const dir of [configHome, profile]) { try { rmSync(dir, { recursive: true, force: true }) } catch (e) {} }
  }
  if (failure) throw failure
}

main().catch(function (e) { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1 })

// 弹幕浮层模块的纯函数测试：不依赖 React / 浏览器，直接加载 TS 源。
// 用法：node --experimental-strip-types scripts/overlay-config.test.mjs
import assert from "node:assert/strict"
import test from "node:test"

const cfg = await import("../web/src/modules/danmu-overlay/config.ts")

test("默认配置合法且为飘屏", () => {
  const d = cfg.DEFAULT_OVERLAY_CONFIG
  assert.equal(d.mode, "scroll")
  assert.equal(d.showDanmu, true)
  assert.ok(d.fontSize >= cfg.OVERLAY_FONT_MIN && d.fontSize <= cfg.OVERLAY_FONT_MAX)
})

test("字号与速度被 clamp 到区间", () => {
  assert.equal(cfg.normalizeOverlayConfig({ fontSize: 1 }).fontSize, cfg.OVERLAY_FONT_MIN)
  assert.equal(cfg.normalizeOverlayConfig({ fontSize: 999 }).fontSize, cfg.OVERLAY_FONT_MAX)
  assert.equal(cfg.normalizeOverlayConfig({ speed: 0 }).speed, 1)
  assert.equal(cfg.normalizeOverlayConfig({ speed: 99 }).speed, 10)
  assert.equal(cfg.normalizeOverlayConfig({ lanes: 1 }).lanes, 3)
})

test("坏值回落默认而不是抛错", () => {
  const n = cfg.normalizeOverlayConfig({ mode: "nope", color: "red", opacity: "abc" })
  assert.equal(n.mode, "scroll")
  assert.match(n.color, /^#[0-9a-f]{6}$/i)
  assert.equal(n.opacity, cfg.DEFAULT_OVERLAY_CONFIG.opacity)
  assert.equal(cfg.normalizeOverlayConfig(null).mode, "scroll")
  assert.equal(cfg.normalizeOverlayConfig(undefined).mode, "scroll")
})

test("布尔可从 query 字符串解析", () => {
  assert.equal(cfg.normalizeOverlayConfig({ showEnter: "1" }).showEnter, true)
  assert.equal(cfg.normalizeOverlayConfig({ showEnter: "false" }).showEnter, false)
})

test("overlayUrl 带全部参数且指向 /overlay", () => {
  const url = cfg.overlayUrl(cfg.normalizeOverlayConfig({ mode: "lyrics", fontSize: 40 }), "http://127.0.0.1:8765")
  assert.ok(url.startsWith("http://127.0.0.1:8765/overlay?"), url)
  const params = new URL(url).searchParams
  assert.equal(params.get("mode"), "lyrics")
  assert.equal(params.get("fontSize"), "40")
  assert.equal(params.get("showDanmu"), "true")
})

test("query 覆盖 localStorage 语义（loadOverlayConfig 传参）", () => {
  const merged = cfg.loadOverlayConfig("?mode=lyrics&fontSize=48")
  assert.equal(merged.mode, "lyrics")
  assert.equal(merged.fontSize, 48)
})

test("类型筛选与飞行时长", () => {
  const c = cfg.normalizeOverlayConfig({ showDanmu: true, showGift: false, showEnter: false })
  assert.equal(cfg.isVisibleKind(c, "danmu"), true)
  assert.equal(cfg.isVisibleKind(c, "gift"), false)
  assert.equal(cfg.isVisibleKind(c, "enter"), false)
  assert.equal(cfg.isVisibleKind(c, "unknown"), true)

  const slow = cfg.flightSeconds(cfg.normalizeOverlayConfig({ speed: 1 }), 10)
  const fast = cfg.flightSeconds(cfg.normalizeOverlayConfig({ speed: 10 }), 10)
  assert.ok(slow > fast, `${slow} vs ${fast}`)
  const long = cfg.flightSeconds(cfg.normalizeOverlayConfig({ speed: 6 }), 200)
  const short = cfg.flightSeconds(cfg.normalizeOverlayConfig({ speed: 6 }), 2)
  assert.ok(long > short, `${long} vs ${short}`)
})
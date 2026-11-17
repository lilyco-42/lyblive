/**
 * 弹幕浮层配置模块（可复用）。
 *
 * 设计约定（与 modules/README.md 一致）：
 * - 配置是纯数据 + 纯函数，不依赖 React，便于单测与在别的宿主（OBS 浏览器源）复用；
 * - 配置来源优先级：URL query > localStorage > 默认值；
 * - 任何字段都做 clamp，坏值不会让浮层消失。
 */
export type OverlayMode = "scroll" | "lyrics";

export interface OverlayConfig {
  /** scroll：从右向左飘过；lyrics：居中停留淡出（类似歌词当前行） */
  mode: OverlayMode;
  /** 字号 px，18–72，与 lyco_music 的歌詞字号区间对齐 */
  fontSize: number;
  /** 速度档位 1–10，越大越快 */
  speed: number;
  /** 轨道数 3–14，决定纵向能同时容纳几行 */
  lanes: number;
  /** 整体不透明度 0.3–1 */
  opacity: number;
  /** 文本颜色（#rrggbb） */
  color: string;
  /** 描边宽度 px 0–4（-webkit-text-stroke + paint-order，和歌詞一致） */
  stroke: number;
  showDanmu: boolean;
  showGift: boolean;
  showEnter: boolean;
}

export const OVERLAY_STORAGE_KEY = "lyblive.overlay";
export const OVERLAY_PATH = "/overlay";

export const OVERLAY_FONT_MIN = 18;
export const OVERLAY_FONT_MAX = 72;

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  mode: "scroll",
  fontSize: 28,
  speed: 6,
  lanes: 6,
  opacity: 0.95,
  color: "#ffffff",
  stroke: 2,
  showDanmu: true,
  showGift: true,
  showEnter: false,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(num)));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(num * 100) / 100));
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return fallback;
}

function asColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

/** 归一化任意来源的配置；未知字段忽略，坏值回落默认。 */
export function normalizeOverlayConfig(raw: unknown): OverlayConfig {
  const src = (raw ?? {}) as Record<string, unknown>;
  const base = DEFAULT_OVERLAY_CONFIG;
  return {
    mode: src.mode === "lyrics" ? "lyrics" : "scroll",
    fontSize: clampInt(src.fontSize, OVERLAY_FONT_MIN, OVERLAY_FONT_MAX, base.fontSize),
    speed: clampInt(src.speed, 1, 10, base.speed),
    lanes: clampInt(src.lanes, 3, 14, base.lanes),
    opacity: clampFloat(src.opacity, 0.3, 1, base.opacity),
    color: asColor(src.color, base.color),
    stroke: clampInt(src.stroke, 0, 4, base.stroke),
    showDanmu: asBool(src.showDanmu, base.showDanmu),
    showGift: asBool(src.showGift, base.showGift),
    showEnter: asBool(src.showEnter, base.showEnter),
  };
}

function readStored(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(OVERLAY_STORAGE_KEY);
    return raw === null || raw === undefined || raw === "" ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function readQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * 读取配置。query 覆盖 localStorage —— OBS 浏览器源可以直接在 URL 里钉死参数，
 * 不必依赖 localStorage（OBS 的 CEF profile 与普通浏览器不共享）。
 */
export function loadOverlayConfig(search = globalThis.location?.search ?? ""): OverlayConfig {
  const stored = normalizeOverlayConfig(readStored() ?? undefined);
  const query = readQuery(search);
  if (Object.keys(query).length === 0) {
    return stored;
  }
  return normalizeOverlayConfig({ ...stored, ...query });
}

export function saveOverlayConfig(config: OverlayConfig): OverlayConfig {
  const normalized = normalizeOverlayConfig(config);
  try {
    globalThis.localStorage?.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // 隐私模式下忽略：本次会话仍生效
  }
  return normalized;
}

/** 生成可直接粘进 OBS「浏览器源」的地址（绝对 URL）。 */
export function overlayUrl(config: OverlayConfig, base?: string): string {
  const origin = base ?? globalThis.location?.origin ?? "http://127.0.0.1:8765";
  const normalized = normalizeOverlayConfig(config);
  const params = new URLSearchParams({
    mode: normalized.mode,
    fontSize: String(normalized.fontSize),
    speed: String(normalized.speed),
    lanes: String(normalized.lanes),
    opacity: String(normalized.opacity),
    color: normalized.color,
    stroke: String(normalized.stroke),
    showDanmu: String(normalized.showDanmu),
    showGift: String(normalized.showGift),
    showEnter: String(normalized.showEnter),
  });
  return `${origin}${OVERLAY_PATH}?${params.toString()}`;
}

const KIND_MAP: Record<string, keyof Pick<OverlayConfig, "showDanmu" | "showGift" | "showEnter">> = {
  danmu: "showDanmu",
  gift: "showGift",
  enter: "showEnter",
};

export function isVisibleKind(config: OverlayConfig, kind: string): boolean {
  const key = KIND_MAP[kind];
  return key === undefined ? config.showDanmu : config[key];
}

/** 每条弹幕的飞行时长（秒）：速度档位 + 文本长度共同决定。 */
export function flightSeconds(config: OverlayConfig, textLength: number): number {
  const base = 16 - config.speed; // 速度 1→15s，速度 10→6s
  const extra = Math.min(6, Math.max(0, textLength / 18));
  return Math.round((base + extra) * 10) / 10;
}
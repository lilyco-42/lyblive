/**
 * 界面缩放：OBS 的自定义浏览器停靠窗口宽度有限，这里按比例放大/缩小
 * 字号与间距。实现基于 rem 体系（改根字号），不会改变布局宽度，
 * 因此在窄 dock 里放大也不会产生横向滚动。
 *
 * 偏好保存在 localStorage，OBS 使用的 CEF profile 会长期保留。
 */
const STORAGE_KEY = "lyblive.uiScale";
const BASE_FONT_PX = 16;

/** 允许范围：75% ~ 250%，覆盖小 dock 与大屏两种极端 */
export const MIN_SCALE = 0.75;
export const MAX_SCALE = 2.5;

/** 设置页的预设档位 */
export const SCALE_PRESETS = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

export function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  return Math.round(clamped * 100) / 100;
}

export function readStoredScale(): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined || raw === "") {
      return 1;
    }
    return clampScale(Number(raw));
  } catch {
    return 1;
  }
}

function writeStoredScale(scale: number): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(scale));
  } catch {
    // 隐私模式或存储被禁用时忽略：缩放仍在本次会话生效
  }
}

let currentScale = 1;
const listeners = new Set<() => void>();

export function getScale(): number {
  return currentScale;
}

export function setScale(value: number): number {
  currentScale = clampScale(value);
  const root = document.documentElement;
  root.style.fontSize = `${BASE_FONT_PX * currentScale}px`;
  root.style.setProperty("--ui-scale", String(currentScale));
  root.dataset.uiScale = String(currentScale);
  writeStoredScale(currentScale);
  for (const listener of listeners) {
    listener();
  }
  return currentScale;
}

export function subscribeScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 启动时调用：恢复上次的缩放，不覆盖已存值 */
export function initScale(): number {
  return setScale(readStoredScale());
}

export function stepScale(delta: number): number {
  return setScale(currentScale + delta);
}
/**
 * 弹幕浮层模块对外出口。
 *
 * 宿主只需要按需引入：
 * - `OverlaySettingsCard`：设置页配置 + 预览 + OBS 地址
 * - `OverlayView`：独立 `/overlay` 页面（透明背景）
 * - `OverlayStage` / `useDanmuFeed`：想自己搭宿主时用
 * - `config`：纯数据与纯函数（可单测）
 */
export { OverlaySettingsCard } from "./OverlaySettingsCard";
export { OverlayStage } from "./OverlayStage";
export { OverlayView } from "./OverlayView";
export { useDanmuFeed } from "./useDanmuFeed";
export {
  DEFAULT_OVERLAY_CONFIG,
  OVERLAY_FONT_MAX,
  OVERLAY_FONT_MIN,
  OVERLAY_PATH,
  OVERLAY_STORAGE_KEY,
  flightSeconds,
  isVisibleKind,
  loadOverlayConfig,
  normalizeOverlayConfig,
  overlayUrl,
  saveOverlayConfig,
  type OverlayConfig,
  type OverlayMode,
} from "./config";
export type { DanmuFeed } from "./useDanmuFeed";
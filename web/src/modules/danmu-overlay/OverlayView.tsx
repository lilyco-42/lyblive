import { useEffect, useMemo, useState } from "react";
import { loadOverlayConfig } from "./config";
import { OverlayStage } from "./OverlayStage";
import { useDanmuFeed } from "./useDanmuFeed";

/**
 * 独立浮层页面：`/overlay`。
 *
 * 背景透明、无交互（pointer-events: none），既能在普通浏览器预览，
 * 也能直接作为 OBS「浏览器源」叠加到直播画面上。
 */
export function OverlayView() {
  const config = useMemo(() => loadOverlayConfig(), []);
  // ?demo=1 用内置样例弹幕，便于没开播时预览 / 自测
  const demo = useMemo(
    () => new URLSearchParams(globalThis.location?.search ?? "").has("demo"),
    [],
  );
  const feed = useDanmuFeed(demo);
  const [hintVisible, setHintVisible] = useState(true);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lyblive-overlay");
    const timer = globalThis.setTimeout(() => setHintVisible(false), 6000);
    return () => {
      globalThis.clearTimeout(timer);
      root.classList.remove("lyblive-overlay");
    };
  }, []);

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-transparent"
      data-testid="danmu-overlay-view"
      data-running={feed.running ? "true" : "false"}
    >
      <OverlayStage feed={feed} config={config} />
      {hintVisible ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <span className="rounded-full bg-black/55 px-3 py-1 text-xs text-white/85">
            {feed.running
              ? `lyblive 浮层 · 房间 ${feed.roomId}`
              : "等待弹幕监听开始：到「弹幕」页点开始"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
import { useEffect, useRef, useState } from "react";
import { flightSeconds, isVisibleKind, type OverlayConfig } from "./config";
import type { DanmuFeed } from "./useDanmuFeed";

interface FloatingItem {
  id: number;
  lane: number;
  text: string;
  kind: string;
}

/** 同时最多保留的漂浮条目，防止长时间直播堆积 */
const MAX_FLOATING = 80;
/** 歌词模式的停留时长（ms），与 index.css 的动画时长保持一致 */
const LYRICS_HOLD_MS = 4200;

function decorate(item: { kind: string; text: string; user: string }): string {
  if (item.kind === "gift") {
    return `🎁 ${item.text}`;
  }
  if (item.kind === "enter") {
    return item.user === "" ? "👋 有人进入直播间" : `👋 ${item.user} 进入直播间`;
  }
  return item.text;
}

/**
 * 弹幕浮层舞台：只负责“把最新一条渲染成漂浮元素”。
 *
 * - scroll：从右向左匀速飘过，轨道由 lanes 决定；
 * - lyrics：居中偏下停留淡出（对齐 lyco_music 桌面歌词的视觉）；
 * - 两种模式都用 CSS animation，结束自动移除，不做逐帧 JS 计算。
 */
export function OverlayStage({ feed, config }: { feed: DanmuFeed; config: OverlayConfig }) {
  const [items, setItems] = useState<FloatingItem[]>([]);
  const nextIdRef = useRef(1);
  const laneRef = useRef(0);
  const lastSeqRef = useRef(0);
  const timersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (feed.seq === lastSeqRef.current) {
      return;
    }
    lastSeqRef.current = feed.seq;

    const latest = feed.items.at(-1);
    if (latest === undefined || !isVisibleKind(config, latest.kind)) {
      return;
    }

    const id = nextIdRef.current;
    nextIdRef.current += 1;
    const lane = laneRef.current % config.lanes;
    laneRef.current += 1;
    const text = decorate(latest);

    if (config.mode === "lyrics") {
      setItems((prev) => [...prev, { id, lane, text, kind: latest.kind }].slice(-2));
      const timer = globalThis.setTimeout(() => {
        timersRef.current.delete(timer);
        setItems((prev) => prev.filter((item) => item.id !== id));
      }, LYRICS_HOLD_MS);
      timersRef.current.add(timer);
      return;
    }

    setItems((prev) => [...prev, { id, lane, text, kind: latest.kind }].slice(-MAX_FLOATING));
  }, [feed.seq, feed.items, config]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) {
        globalThis.clearTimeout(timer);
      }
      timersRef.current.clear();
    },
    [],
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="danmu-overlay-stage"
      data-mode={config.mode}
    >
      {items.map((item) => {
        const common = {
          fontSize: `${config.fontSize}px`,
          color: config.color,
          opacity: config.opacity,
          WebkitTextStroke:
            config.stroke > 0 ? `${config.stroke}px rgba(0, 0, 0, 0.72)` : undefined,
        } as const;

        if (config.mode === "lyrics") {
          return (
            <div key={item.id} className="lyblive-danmu lyblive-danmu--lyrics" style={common}>
              {item.text}
            </div>
          );
        }

        return (
          <div
            key={item.id}
            className="lyblive-danmu lyblive-danmu--scroll"
            style={{
              ...common,
              top: `${((item.lane + 0.5) * 100) / config.lanes}%`,
              animationDuration: `${flightSeconds(config, item.text.length)}s`,
            }}
            onAnimationEnd={() => setItems((prev) => prev.filter((entry) => entry.id !== item.id))}
          >
            {item.text}
          </div>
        );
      })}
    </div>
  );
}
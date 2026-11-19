import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  DANMU_EVENTS_URL,
  errorMessage,
  type DanmuItem,
  type DanmuStats,
} from "@/lib/api";

/** 实时列表最多保留的条数，超出丢最早的 */
const MAX_ITEMS = 300;

/** 把 SSE 消息规范化成列表项，兼容事件里缺少 user 字段的情况。 */
function parseItem(value: unknown): DanmuItem | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.ts !== "number" ||
    typeof record.kind !== "string" ||
    typeof record.text !== "string"
  ) {
    return null;
  }
  const rawUser = record.user;
  let user = "";
  if (typeof rawUser === "string") {
    user = rawUser;
  } else if (typeof rawUser === "object" && rawUser !== null) {
    const profile = rawUser as Record<string, unknown>;
    if (typeof profile.uname === "string") {
      user = profile.uname;
    } else if (typeof profile.name === "string") {
      user = profile.name;
    }
  }
  return {
    ts: record.ts,
    kind: record.kind,
    user,
    text: record.text,
    face: typeof record.face === "string" ? record.face : "",
    giftName: typeof record.giftName === "string" ? record.giftName : "",
    giftNum: typeof record.giftNum === "number" ? record.giftNum : 0,
    giftIcon: typeof record.giftIcon === "string" ? record.giftIcon : "",
  };
}

/**
 * 弹幕监控。
 * - 开启后接 EventSource('/api/danmu/events')，实时追加，最多 300 条
 * - paused 只影响自动滚底，消息始终追加，最多保留 300 条
 * - 运行中每 5 秒刷新一次 /api/danmu/status 同步统计
 */
export function useDanmu() {
  const [running, setRunning] = useState(false);
  const [roomId, setRoomId] = useState<number>(0);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [stats, setStats] = useState<DanmuStats>({
    danmu: 0,
    gift: 0,
    enter: 0,
    popularity: 0,
    topKeywords: [],
  });
  const [items, setItems] = useState<DanmuItem[]>([]);
  /** 每条新消息 +1：仅供置顶滚动层判断“有一条新的” */
  const [seq, setSeq] = useState(0);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const sourceRef = useRef<EventSource | null>(null);
  const startedRef = useRef(0);
  const autoStartRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  /** 拉一次状态：首次进入、以及运行中周期刷新统计 */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const data = await api.danmuStatus();
      if (!mountedRef.current) {
        return false;
      }
      setRunning(data.running);
      setRoomId(data.roomId);
      setStartedAt(data.startedAt);
      setStats(data.stats);
      setError(null);
      // 页面首次打开发现监控已停时自动恢复一次，避免「打开就是已停止、漏弹幕」；
      // 未登录时不发 start（否则接口 400 会在控制台留下网络错误）
      if (!data.running && !autoStartRef.current) {
        autoStartRef.current = true;
        void (async () => {
          try {
            const session = await api.session();
            if (session.loggedIn) {
              await api.danmuStart();
            }
          } catch {
            // 未登录或网络异常：保持停止，不打扰控制台
          }
        })();
      }
      // 服务重启后 startedAt 变化，旧消息已不在后端内存里，清掉避免残留误导
      const startedAt = data.startedAt ?? 0;
      const restarted = startedRef.current !== 0 && startedRef.current !== startedAt;
      startedRef.current = startedAt;
      if (restarted) {
        setItems(data.recent.slice(-MAX_ITEMS));
      } else if (data.recent.length > 0) {
        setItems((prev) => {
          if (prev.length > 0) {
            return prev;
          }
          return data.recent.slice(-MAX_ITEMS);
        });
      }
      return data.running;
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setError(errorMessage(cause));
      }
      return false;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 事件流：运行中才连，停止后关闭
  useEffect(() => {
    if (!running) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }
    if (sourceRef.current !== null) {
      return;
    }
    const source = new EventSource(DANMU_EVENTS_URL);
    sourceRef.current = source;

    source.onmessage = (event: MessageEvent<string>) => {
      if (!mountedRef.current) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      // 部分后端会在事件里带上最新统计，能对上就顺手同步
      if (typeof payload === "object" && payload !== null) {
        const record = payload as Record<string, unknown>;
        if (typeof record.running === "boolean") {
          setRunning(record.running);
        }
        const popularity = record.popularity;
        if (typeof popularity === "number") {
          setStats((prev) => ({ ...prev, popularity }));
        }
        // 暂停只停止自动滚底（由面板处理），事件始终追加
        const item = parseItem(record.item ?? payload);
        if (item !== null) {
          setItems((prev) => {
            const next = prev.length >= MAX_ITEMS ? prev.slice(prev.length - MAX_ITEMS + 1) : prev.slice();
            next.push(item);
            return next;
          });
          setSeq((value) => value + 1);
        }
      }
    };

    source.onerror = () => {
      // 浏览器会自动重连，这里不打断，只记一次错误提示
      if (mountedRef.current) {
        setError("弹幕事件流连接中断，正在自动重连");
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [running]);

  // 运行中定期同步统计数字
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [running, refresh]);

  const start = useCallback(
    async (targetRoomId?: number): Promise<void> => {
      await api.danmuStart(targetRoomId);
      setItems([]);
      setPaused(false);
      await refresh();
    },
    [refresh],
  );

  const stop = useCallback(async (): Promise<void> => {
    await api.danmuStop();
    sourceRef.current?.close();
    sourceRef.current = null;
    await refresh();
  }, [refresh]);

  const send = useCallback(async (msg: string): Promise<void> => {
    await api.danmuSend(msg);
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  return {
    running,
    roomId,
    startedAt,
    stats,
    items,
    seq,
    paused,
    loading,
    error,
    setPaused,
    refresh,
    start,
    stop,
    send,
    clear,
  };
}

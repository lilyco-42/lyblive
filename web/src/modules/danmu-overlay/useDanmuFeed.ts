import { useEffect, useRef, useState } from "react";
import { api, DANMU_EVENTS_URL, type DanmuItem } from "@/lib/api";

/** 浮层自己维护的滚动窗口，避免长直播把内存撑大 */
const MAX_BUFFER = 200;

export interface DanmuFeed {
  running: boolean;
  roomId: number;
  items: DanmuItem[];
  /** 每条新消息让 seq +1：渲染层只处理“最新一条”，不会重复也不会漏 */
  seq: number;
  error: string | null;
}

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
    text: record.text,
    user,
    face: typeof record.face === "string" ? record.face : "",
    giftName: typeof record.giftName === "string" ? record.giftName : "",
    giftNum: typeof record.giftNum === "number" ? record.giftNum : 0,
    giftIcon: typeof record.giftIcon === "string" ? record.giftIcon : "",
  };
}

/**
 * 浮层用的弹幕流：与 DanmuPanel 共用同一个 SSE 端点，但只关心“新消息”。
 * 组件卸载或后端停流时自动断开；断线后 3 秒重连一次（CEF 场景更稳）。
 */
export function useDanmuFeed(demo = false): DanmuFeed {
  const [running, setRunning] = useState(false);
  const [roomId, setRoomId] = useState(0);
  const [items, setItems] = useState<DanmuItem[]>([]);
  const [seq, setSeq] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceRef.current?.close();
      sourceRef.current = null;
      if (retryRef.current !== null) {
        globalThis.clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (demo) {
      return;
    }
    let cancelled = false;

    async function sync() {
      try {
        const status = await api.danmuStatus();
        if (cancelled || !mountedRef.current) {
          return;
        }
        setRunning(status.running);
        setRoomId(status.roomId);
        setError(null);
        if (status.recent.length > 0) {
          setItems((prev) => (prev.length > 0 ? prev : status.recent.slice(-MAX_BUFFER)));
        }
      } catch (cause: unknown) {
        if (!cancelled && mountedRef.current) {
          setError(cause instanceof Error ? cause.message : "弹幕状态获取失败");
        }
      }
    }

    void sync();
    const timer = globalThis.setInterval(() => void sync(), 5000);
    return () => {
      cancelled = true;
      globalThis.clearInterval(timer);
    };
  }, [demo]);

  useEffect(() => {
    if (!running || demo) {
      sourceRef.current?.close();
      sourceRef.current = null;
      return;
    }
    if (sourceRef.current !== null) {
      return;
    }

    const connect = () => {
      if (!mountedRef.current) {
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
        const item = parseItem(payload);
        if (item === null) {
          return;
        }
        setItems((prev) => [...prev, item].slice(-MAX_BUFFER));
        setSeq((value) => value + 1);
      };

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        if (!mountedRef.current) {
          return;
        }
        retryRef.current = globalThis.setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [running, demo]);

  // demo=1：给浮层预览/自测注入假弹幕，不连真实 SSE，也不轮询后端状态
  useEffect(() => {
    if (!demo) {
      return;
    }
    const samples = [
      "前排",
      "666",
      "主播加油",
      "这个操作 6",
      "老板大气",
      "笑死",
      "好耶",
      "冲冲冲",
      "礼物已送达",
      "这波稳了",
    ];
    let index = 0;
    const timer = globalThis.setInterval(() => {
      if (!mountedRef.current) {
        return;
      }
      const text = samples[index % samples.length];
      index += 1;
      const item: DanmuItem = { ts: Date.now(), kind: "danmu", user: `观众${(index % 5) + 1}`, text };
      setItems((prev) => [...prev, item].slice(-MAX_BUFFER));
      setSeq((value) => value + 1);
    }, 900);
    return () => globalThis.clearInterval(timer);
  }, [demo]);

  return { running, roomId, items, seq, error };
}
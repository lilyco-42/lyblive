import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Room } from "@/lib/api";

/**
 * 房间信息与写操作。
 * 每次写成功后由调用方负责 toast 并调用 refresh() 重新拉 /api/room。
 */
export function useRoom() {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<Room | null> => {
    setLoading(true);
    try {
      const data = await api.room();
      if (mountedRef.current) {
        setRoom(data.room);
        setError(null);
      }
      return data.room;
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setError(errorMessage(cause));
      }
      return null;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 包一层 saving 标记，失败向上抛给组件 toast */
  const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    setSaving(true);
    try {
      await action();
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, []);

  const setTitle = useCallback(
    async (title: string) => {
      await run(() => api.setTitle(title));
      await refresh();
    },
    [run, refresh],
  );

  const setArea = useCallback(
    async (areaId: number) => {
      await run(() => api.setArea(areaId));
      await refresh();
    },
    [run, refresh],
  );

  const setAnnouncement = useCallback(
    async (content: string) => {
      await run(() => api.setAnnouncement(content));
      await refresh();
    },
    [run, refresh],
  );

  return { room, loading, saving, error, refresh, setTitle, setArea, setAnnouncement };
}

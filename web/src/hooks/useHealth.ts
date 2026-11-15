import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Health } from "@/lib/api";

/** 顶栏健康徽标：定期拉取 /api/health。 */
export function useHealth(pollMs = 30000) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await api.health();
      if (mountedRef.current) {
        setHealth(data);
        setError(null);
      }
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setHealth(null);
        setError(errorMessage(cause));
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    // 周期刷新，后端崩了能及时变红
    const timer = window.setInterval(() => {
      void load();
    }, pollMs);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [load, pollMs]);

  return { health, error, reload: load };
}

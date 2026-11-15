import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Session } from "@/lib/api";

/**
 * 登录态。
 * - refresh：重新拉 /api/session
 * - logout：退出登录
 * 前端只关心 loggedIn / user / roomId，不接触 cookie 与 csrf。
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<Session | null> => {
    setLoading(true);
    try {
      const data = await api.session();
      if (mountedRef.current) {
        setSession(data);
        setError(null);
      }
      return data;
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

  /** 只更新内存态（例如扫码确认后后端已返回 session） */
  const apply = useCallback((next: Session) => {
    if (mountedRef.current) {
      setSession(next);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    await api.logout();
    await refresh();
  }, [refresh]);

  return { session, loading, error, refresh, logout, apply };
}

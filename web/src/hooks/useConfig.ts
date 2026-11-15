import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type AppConfig } from "@/lib/api";

/** 应用配置：配置目录 / 凭据文件 / 记住登录开关。 */
export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.config();
      if (mountedRef.current) {
        setConfig(data.config);
        setError(null);
      }
    } catch (cause: unknown) {
      if (mountedRef.current) {
        setError(errorMessage(cause));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 写开关后重拉配置，保证展示与后端一致 */
  const setRememberLogin = useCallback(
    async (rememberLogin: boolean): Promise<void> => {
      setSaving(true);
      try {
        await api.saveConfig({ rememberLogin });
        await refresh();
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [refresh],
  );

  return { config, loading, saving, error, refresh, setRememberLogin };
}

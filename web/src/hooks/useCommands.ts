import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type CommandInfo } from "@/lib/api";

/** 命令注册表（同时是 CLI 子命令与 MCP 工具）。 */
export function useCommands() {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const data = await api.commands();
      if (mountedRef.current) {
        setCommands(data.commands);
        setError(null);
      }
      return true;
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

  return { commands, loading, error, refresh };
}

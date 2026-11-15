import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Area } from "@/lib/api";

/** 两级分区目录：GET /api/partitions。 */
export function usePartitions() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
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
      const data = await api.partitions();
      if (mountedRef.current) {
        setAreas(data.areas);
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

  return { areas, loading, error, refresh };
}

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../lib/api";
import type { HubState } from "../types";

/** Состояние Key Hub: опрашиваем локальный сервис, он сам ходит в облако раз в несколько секунд. */
export function useHub(active: boolean) {
  const [state, setState] = useState<HubState | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.hubState();
      if (alive.current) setState(s);
    } catch {
      /* сервис не ответил — повторим */
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!active) {
      setState(null);
      return;
    }
    void refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [active, refresh]);

  /** Подставляет свежее состояние из ответа действия. */
  const apply = useCallback((s: HubState) => setState(s), []);
  return { state, refresh, apply };
}

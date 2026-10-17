import { useEffect } from 'react';
import { useStudio } from '@/store/studio';

/** Coalesce SSE bursts, including events immediately following the initial request. */
export function useRunEvents(refresh: () => void) {
  useEffect(() => {
    let seen = useStudio.getState().events.at(-1)?.id ?? 0;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useStudio.subscribe((state, previous) => {
      if (state.events === previous.events) return;
      const fresh = state.events.filter((event) => event.id > seen);
      for (const event of fresh) seen = Math.max(seen, event.id);
      if (!fresh.some((event) => event.type === 'run.created' || event.type === 'run.updated') || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        refresh();
      }, Math.max(0, last + 2000 - Date.now()));
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [refresh]);
}

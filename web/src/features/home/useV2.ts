import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioEvent } from '@asf/shared';
import { api } from '@/lib/api';
import { useStudio } from '@/store/studio';

/** Quiet period after a studio event before the read model is fetched again. */
export const V2_EVENT_DEBOUNCE_MS = 1500;
/** Safety poll while the page is visible, in case an event was missed. */
export const V2_POLL_MS = 15_000;

export interface V2Result<T> {
  data: T | null;
  error: string | null;
  /** True only while there is nothing to show yet (first load, or after the path changed). */
  loading: boolean;
  reload: () => void;
}

interface V2State<T> { data: T | null; error: string | null; loading: boolean }

/** Id of the newest event that is not streamed agent output (0 when there is none). */
function latestMeaningfulEventId(events: StudioEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type !== 'agent.output') return events[index].id;
  }
  return 0;
}

/**
 * Fetches a /api/v2 read model and keeps it fresh: it reloads (debounced) when the studio event stream
 * delivers an event other than 'agent.output', and every 15 s while the tab is visible.
 * A response that arrives after the path changed (or the component unmounted) is ignored.
 */
export function useV2<T>(path: string | null): V2Result<T> {
  const [state, setState] = useState<V2State<T>>({ data: null, error: null, loading: path !== null });
  const pathRef = useRef(path);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEventRef = useRef(latestMeaningfulEventId(useStudio.getState().events));
  pathRef.current = path;

  const load = useCallback(async (target: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const data = await api<T>(target, { signal: controller.signal });
      if (!controller.signal.aborted) setState({ data, error: null, loading: false });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setState((previous) => ({ data: previous.data, error: cause instanceof Error ? cause.message : String(cause), loading: false }));
    }
  }, []);

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    setState({ data: null, error: null, loading: true });
    void load(path);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load(path);
    }, V2_POLL_MS);
    return () => {
      clearInterval(poll);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      controllerRef.current?.abort();
    };
  }, [path, load]);

  // A number, so the hook re-renders only when a meaningful event arrives, not for every line of agent output.
  const latestEventId = useStudio((s) => latestMeaningfulEventId(s.events));
  useEffect(() => {
    if (latestEventId <= seenEventRef.current) return;
    seenEventRef.current = latestEventId;
    if (pathRef.current === null || timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pathRef.current !== null) void load(pathRef.current);
    }, V2_EVENT_DEBOUNCE_MS);
  }, [latestEventId, load]);

  const reload = useCallback(() => {
    const target = pathRef.current;
    if (target === null) return;
    setState((previous) => ({ ...previous, error: null, loading: previous.data === null }));
    void load(target);
  }, [load]);

  return { ...state, reload };
}

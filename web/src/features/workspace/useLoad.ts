import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

export interface LoadState<T> {
  data: T | null;
  error: string | null;
  status: number | null;
  loading: boolean;
  reload: () => void;
}

/** One-shot GET for a tab: loads when `path` changes (null = idle), never polls. Late responses are ignored. */
export function useLoad<T>(path: string | null): LoadState<T> {
  const [state, setState] = useState<Omit<LoadState<T>, 'reload'>>({ data: null, error: null, status: null, loading: path !== null });
  const [nonce, setNonce] = useState(0);
  const tokenRef = useRef(0);

  useEffect(() => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    if (path === null) {
      setState({ data: null, error: null, status: null, loading: false });
      return undefined;
    }
    setState((previous) => ({ ...previous, loading: true, error: null, status: null }));
    api<T>(path).then(
      (data) => { if (token === tokenRef.current) setState({ data, error: null, status: null, loading: false }); },
      (cause: unknown) => {
        if (token !== tokenRef.current) return;
        setState({
          data: null, loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
          status: cause instanceof ApiError ? cause.status : null,
        });
      },
    );
    return () => { tokenRef.current += 1; };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}

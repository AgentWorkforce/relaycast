import { useState, useEffect, useContext, useRef } from 'react';
import { ClientContext } from '../context.js';
import type { MessageWithMeta } from '@relaycast/sdk';
import type { UseSearchReturn } from '../types.js';

export interface UseSearchOptions {
  channel?: string;
  from?: string;
  limit?: number;
}

export function useSearch(query: string, opts?: UseSearchOptions): UseSearchReturn {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useSearch must be used within <RelayProvider>');

  const [results, setResults] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await ctx.agent.search(query, optsRef.current);
        setResults(data as MessageWithMeta[]);
        setError(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, ctx.agent]);

  return { results, loading, error };
}

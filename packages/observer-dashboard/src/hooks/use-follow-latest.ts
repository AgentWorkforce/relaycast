'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Follow incoming entries within this pane until the reader scrolls away. */
export function useFollowLatest(scrollRef: RefObject<HTMLDivElement>, latestId?: string) {
  const following = useRef(true);

  useClientLayoutEffect(() => {
    if (latestId === undefined) {
      // Clearing an empty feed may not emit a scroll event. Resume following.
      following.current = true;
      return;
    }
    const pane = scrollRef.current;
    if (pane && following.current) pane.scrollTop = pane.scrollHeight;
  }, [latestId, scrollRef]);

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const onScroll = () => {
      // Hidden responsive panes must not change the reader's follow preference.
      if (pane.clientHeight > 0) {
        following.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 80;
      }
    };
    const resize = new ResizeObserver(() => {
      if (following.current && pane.clientHeight > 0) pane.scrollTop = pane.scrollHeight;
    });
    pane.addEventListener('scroll', onScroll, { passive: true });
    resize.observe(pane);
    return () => {
      pane.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  }, [scrollRef]);
}

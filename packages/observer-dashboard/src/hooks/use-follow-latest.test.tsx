// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFollowLatest } from './use-follow-latest';

let resized: () => void;
const disconnect = vi.fn();

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  disconnect.mockClear();
});

/** Create a scroll pane with measurable overflow in jsdom. */
function makePane() {
  const pane = document.createElement('div');
  Object.defineProperties(pane, {
    clientHeight: { value: 200, configurable: true },
    scrollHeight: { value: 1000, configurable: true },
  });
  return pane;
}

/** Simulate a reader scroll, including the event that changes follow mode. */
function scroll(pane: HTMLDivElement, top: number) {
  act(() => {
    pane.scrollTop = top;
    pane.dispatchEvent(new Event('scroll'));
  });
}

describe('useFollowLatest', () => {
  it('follows the initial and latest entries within its own pane', () => {
    const pane = makePane();
    const other = makePane();
    other.scrollTop = 123;
    const pageScroll = vi.spyOn(window, 'scrollTo');
    const ref = { current: pane };
    const { rerender } = renderHook(({ id }) => useFollowLatest(ref, id), { initialProps: { id: 'first' } });
    expect(pane.scrollTop).toBe(1000);
    Object.defineProperty(pane, 'scrollHeight', { value: 1200 });
    rerender({ id: 'second' });
    expect(pane.scrollTop).toBe(1200);
    expect(other.scrollTop).toBe(123);
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('preserves the reading position and resumes when the reader returns near the bottom', () => {
    const pane = makePane();
    const ref = { current: pane };
    const { rerender } = renderHook(({ id }) => useFollowLatest(ref, id), { initialProps: { id: 'first' } });
    scroll(pane, 300);
    Object.defineProperty(pane, 'scrollHeight', { value: 1200 });
    rerender({ id: 'second' });
    expect(pane.scrollTop).toBe(300);
    scroll(pane, 950);
    Object.defineProperty(pane, 'scrollHeight', { value: 1400 });
    rerender({ id: 'third' });
    expect(pane.scrollTop).toBe(1400);
  });

  it('resumes following after clearing a feed at the top without a scroll event', () => {
    const pane = makePane();
    const ref = { current: pane };
    const { rerender } = renderHook(({ id }: { id?: string }) => useFollowLatest(ref, id), {
      initialProps: { id: 'first' } as { id?: string },
    });
    scroll(pane, 0);
    Object.defineProperty(pane, 'scrollHeight', { value: 200 });
    rerender({ id: undefined });
    expect(pane.scrollTop).toBe(0);
    Object.defineProperty(pane, 'scrollHeight', { value: 1200 });
    rerender({ id: 'after-clear' });
    expect(pane.scrollTop).toBe(1200);
  });

  it('does not jump when older entries are prepended without changing the latest id', () => {
    const pane = makePane();
    const ref = { current: pane };
    const { rerender } = renderHook(() => useFollowLatest(ref, 'latest'));
    scroll(pane, 200);
    Object.defineProperty(pane, 'scrollHeight', { value: 1500 });
    // The pagination caller restores its anchor after prepending an older page.
    pane.scrollTop += 500;
    rerender();
    expect(pane.scrollTop).toBe(700);
  });

  it('follows a pane becoming visible but preserves a reader position on resize', () => {
    const pane = makePane();
    const ref = { current: pane };
    renderHook(() => useFollowLatest(ref, 'latest'));
    Object.defineProperty(pane, 'clientHeight', { value: 0 });
    scroll(pane, 0);
    Object.defineProperty(pane, 'clientHeight', { value: 200 });
    act(() => resized());
    expect(pane.scrollTop).toBe(1000);
    scroll(pane, 200);
    act(() => resized());
    expect(pane.scrollTop).toBe(200);
  });

  it('waits for the first entry and cleans up the observer and listener', () => {
    const pane = makePane();
    const removeListener = vi.spyOn(pane, 'removeEventListener');
    const ref = { current: pane };
    const { rerender, unmount } = renderHook(({ id }: { id?: string }) => useFollowLatest(ref, id), { initialProps: {} });
    expect(pane.scrollTop).toBe(0);
    rerender({ id: 'first' });
    expect(pane.scrollTop).toBe(1000);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});

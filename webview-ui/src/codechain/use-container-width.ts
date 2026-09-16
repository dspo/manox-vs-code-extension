// Container-width measurement for the Code Tutor view's layout breakpoint.
// Copied from the sidebar's `lib/use-container-width.ts` so the standalone
// `codechain-bundle` stays lean and this entry can mock it independently in
// tests. Same reason as the original: a webview view's width is decided by
// where the user docked it (bottom panel / sidebar / floating), not the
// viewport, so a ResizeObserver stands in for container queries.
//
// One deliberate hardening over the original: `ResizeObserver` is absent under
// jsdom (the panel render tests). The observer is created only when the global
// exists, so the hook degrades to width `0` — which the app treats as
// "unmeasured" and defaults to the wide (tree) layout instead of the narrow
// focus card.

import { useEffect, useRef, useState } from 'react';

export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>;
  width: number;
} {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

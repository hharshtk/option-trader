"use client";

import { useEffect, useRef } from "react";

// Scrolls only the nearest [data-scroll-container], so the page itself doesn't jump.
export function CenterOnMount({ token }: { token: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const marker = ref.current;
    const container = marker?.closest<HTMLElement>("[data-scroll-container]");
    if (!marker || !container) return;
    const offset = marker.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += offset - container.clientHeight / 2;
  }, [token]);

  return <span ref={ref} aria-hidden />;
}

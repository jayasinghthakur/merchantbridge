'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export function secondsLeft(untilMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

/** Re-renders once a second until `untilMs`; renders `children(seconds)`. */
export function Countdown({
  untilMs,
  children,
}: {
  untilMs: number;
  children: (seconds: number) => ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  const left = secondsLeft(untilMs, now);
  useEffect(() => {
    if (left <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [left]);
  return <>{children(left)}</>;
}

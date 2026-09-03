'use client';

import { useEffect, useState } from 'react';

/*
 * "in 13h 22m", ticking. The server cannot know the reader's clock or zone,
 * so the instant is sent as ISO and the distance is computed here, once every
 * thirty seconds. Past the instant it says so rather than counting negative.
 */
function label(until: number, now: number): string {
  const ms = until - now;
  if (ms <= 0) return 'any moment now';
  const m = Math.ceil(ms / 60_000);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h >= 1) return `in ${h}h ${rest}m`;
  return `in ${m}m`;
}

export default function Countdown({ until, className }: { until: string | null; className?: string }) {
  const target = until ? Date.parse(until) : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [target]);
  if (!Number.isFinite(target)) return <span className={className}>{'\u2014'}</span>;
  return <span className={className}>{label(target, now)}</span>;
}

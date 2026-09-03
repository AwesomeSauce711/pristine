'use client';

import { useEffect, useSyncExternalStore } from 'react';

/*
 * What the UI may assume about the reader: signed in or not, subscribed or
 * not. FOR DISPLAY ONLY -- /api/patch decides for real on every call.
 *
 * ONE ANSWER, SHARED. The nav, the hero and the pricing table each ask, and
 * the nav is mounted twice, so a landing page used to fire four requests on
 * load and four more on every window focus -- for a signed-in subscriber,
 * some forty-five queries to render three labels, and enough to reach the
 * route's own per-IP limit from behind a shared address. The answer now
 * lives at module scope: one request in flight at a time, every instance
 * reading the same value, one focus listener for all of them.
 */
export interface Me {
  /** null until the first answer arrives, so the UI can avoid a flash. */
  signedIn: boolean | null;
  /** May download right now: a live plan with allowance, or a bought download. */
  entitled: boolean;
  /** A live subscription, whether or not there is allowance left today. */
  hasPlan: boolean;
  /** The plan's id when there is one. */
  tier: string | null;
}

const INITIAL: Me = { signedIn: null, entitled: false, hasPlan: false, tier: null };

let current: Me = INITIAL;
let inflight: Promise<void> | null = null;
let answeredAt = 0;
const listeners = new Set<() => void>();

/* A focus that follows an answer by less than this is the same moment:
 * clicking back into the tab after a sign-in in it, say. */
const FRESH_MS = 2000;

/**
 * Ask /api/me again, once for everyone. Exported so a page that has just
 * changed the answer (a sign-in, a payment) can refresh the labels.
 */
export function refreshMe(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch('/api/me', { cache: 'no-store' })
    .then((r) => {
      /* A 429 from the route's own limiter, or a 503 while the session
       * cannot be looked up, is not an answer. Parsed as one, its missing
       * fields read as signed out and the tool page sent a subscriber to
       * sign in. Keep the last answer instead. */
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then((d: { signedIn?: boolean; entitled?: boolean; hasPlan?: boolean; tier?: string | null }) => {
      current = {
        signedIn: !!d.signedIn,
        entitled: !!(d.entitled || d.hasPlan),
        hasPlan: !!d.hasPlan,
        tier: d.tier ?? null,
      };
      answeredAt = Date.now();
      for (const notify of listeners) notify();
    })
    .catch(() => { /* leave the last known value */ })
    .finally(() => { inflight = null; });
  return inflight;
}

function onFocus() {
  if (Date.now() - answeredAt > FRESH_MS) void refreshMe();
}

function subscribe(notify: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('focus', onFocus);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0) window.removeEventListener('focus', onFocus);
  };
}

const getSnapshot = () => current;
const getServerSnapshot = () => INITIAL;

export function useMe(): Me {
  const me = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  /* Fetched on mount unless an answer just landed: the page that mounted
   * this may be the one the reader signed in or paid on. */
  useEffect(() => { onFocus(); }, []);
  return me;
}
